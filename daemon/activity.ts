// Stream-activity tracking, and the one decision it exists to inform:
// is now a safe moment to restart for an update?
//
// The user's rule: updates must never interrupt playback. Two signals
// implement it, both deliberately basic:
//  - who is watching RIGHT NOW: a live count of open /stream responses,
//    plus a grace window after the last one closes (a pause or an episode
//    gap is not "done for the night");
//  - who USUALLY watches about now: a per-hour-of-day histogram of stream
//    activity, so a staged update prefers the household's quiet hours
//    instead of restarting at 8pm just because everyone happened to blink.
//
// A staleness cap breaks ties: an update that has waited a full day
// applies at the first genuinely idle moment, quiet hour or not — waiting
// forever for a perfectly quiet hour is how updates never happen.

import fsp from 'node:fs/promises'
import path from 'node:path'

/** How long after the last stream closes the daemon still counts as "in
 *  use" — resume-after-pause and next-episode gaps live inside this. */
export const IDLE_GRACE_MS = 30 * 60 * 1000
/** A staged update older than this applies at the first idle moment,
 *  ignoring the quiet-hours preference. */
export const STALE_UPDATE_MS = 24 * 60 * 60 * 1000

export interface ActivitySnapshot {
  activeStreams: number
  /** ms epoch of the most recent stream open OR close; 0 = never. */
  lastStreamAt: number
  /** Stream-opens per hour-of-day, a rolling tally. */
  hourCounts: number[]
}

export interface RestartDecisionInput {
  activeStreams: number
  lastStreamAt: number
  hourCounts: readonly number[]
  stagedAt: number
  now: number
}

/**
 * Pure: whether applying a staged update NOW honours "never interrupt
 * playback".
 *
 * Hard rules first: never with a stream open, never inside the idle grace
 * window. Then the preference: restart in an hour whose historical
 * activity is at or below the median ("quiet"), unless the update has
 * gone stale, in which case idle-now is enough.
 */
export function canRestartNow(input: RestartDecisionInput): boolean {
  if (input.activeStreams > 0) return false
  if (input.lastStreamAt > 0 && input.now - input.lastStreamAt < IDLE_GRACE_MS) return false

  if (input.now - input.stagedAt >= STALE_UPDATE_MS) return true

  const counts = [...input.hourCounts]
  while (counts.length < 24) counts.push(0)
  const total = counts.reduce((sum, value) => sum + value, 0)
  // No history yet — every hour is equally quiet; idle is enough.
  if (total === 0) return true
  const sorted = [...counts].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const hour = new Date(input.now).getHours()
  return counts[hour] <= median
}

export interface ActivityTracker {
  streamOpened(infoHash?: string): void
  streamClosed(infoHash?: string): void
  /** Whether this item has a /stream response open against it right now.
   *  Eviction consults it: deleting the file somebody is watching ends
   *  their evening, and no amount of freed space is worth that. */
  isStreaming(infoHash: string): boolean
  snapshot(): ActivitySnapshot
  load(): Promise<void>
}

/**
 * The impure shell: counters plus a best-effort persisted histogram, so
 * "when does this household watch" survives daemon restarts — which is
 * exactly when the information is needed.
 */
export function createActivityTracker(dataDir: string): ActivityTracker {
  const usagePath = path.join(dataDir, 'usage.json')
  // Per-hash open COUNTS, not a set: one player commonly has two responses
  // against the same file at once (a seek opens the next range before the
  // previous one closes), and a set would be cleared by the first close
  // while the second was still reading.
  const openByHash = new Map<string, number>()
  let activeStreams = 0
  let lastStreamAt = 0
  let hourCounts: number[] = Array.from({ length: 24 }, () => 0)
  let persistTimer: NodeJS.Timeout | null = null

  function schedulePersist(): void {
    if (persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      void (async () => {
        try {
          const tmp = `${usagePath}.tmp`
          await fsp.writeFile(tmp, JSON.stringify({ hourCounts, lastStreamAt }))
          await fsp.rename(tmp, usagePath)
        } catch {
          // Best-effort: losing the histogram only loses a preference.
        }
      })()
    }, 2000)
    persistTimer.unref?.()
  }

  return {
    streamOpened(infoHash) {
      if (infoHash) openByHash.set(infoHash, (openByHash.get(infoHash) ?? 0) + 1)
      activeStreams += 1
      lastStreamAt = Date.now()
      hourCounts[new Date().getHours()] += 1
      // Rolling decay: once any hour's tally gets large, halve everything.
      // Keeps the histogram reflecting recent months, not all time, with
      // no timestamps to manage.
      if (hourCounts.some((count) => count >= 1000)) {
        hourCounts = hourCounts.map((count) => Math.floor(count / 2))
      }
      schedulePersist()
    },
    streamClosed(infoHash) {
      if (infoHash) {
        const left = (openByHash.get(infoHash) ?? 0) - 1
        if (left > 0) openByHash.set(infoHash, left)
        else openByHash.delete(infoHash)
      }
      activeStreams = Math.max(0, activeStreams - 1)
      lastStreamAt = Date.now()
      schedulePersist()
    },
    isStreaming(infoHash) {
      return (openByHash.get(infoHash) ?? 0) > 0
    },
    snapshot() {
      return { activeStreams, lastStreamAt, hourCounts: [...hourCounts] }
    },
    async load() {
      try {
        const parsed = JSON.parse(await fsp.readFile(usagePath, 'utf8')) as {
          hourCounts?: number[]
          lastStreamAt?: number
        }
        if (Array.isArray(parsed.hourCounts) && parsed.hourCounts.length === 24) {
          hourCounts = parsed.hourCounts.map((value) => (Number.isFinite(value) ? value : 0))
        }
        if (Number.isFinite(parsed.lastStreamAt)) lastStreamAt = Number(parsed.lastStreamAt)
      } catch {
        // First run.
      }
    }
  }
}
