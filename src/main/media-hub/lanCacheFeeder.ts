// The feeder: decides WHAT the cache daemon should hold, from what this
// person actually watches — the app-side half of the hybrid model.
//
// The decision logic lives in shared/lancache/wantedList.ts (pure,
// tested); this module is the glue that runs it against the database and
// the paired daemon on a background cadence. The daemon's tombstones are
// the counterweight to the triggers: a title it expired is NOT immediately
// re-queued, or the hard-max-age rule would mean nothing.

import { computeWantedList } from '../../shared/lancache/wantedList'
import { getDatabase } from './dbState'
import { isLanCacheConnected, lanCacheCatalog, queueLanCacheJob } from './lanCache'
import { logError } from './logger'
import { sanitizeTrackers } from './security'
import { discoverBestPrefetchCandidate } from './torbox'

/** New downloads queued per pass — gentle by design; the feeder runs again
 *  in half an hour and the daemon fetches one at a time anyway. */
const MAX_NEW_JOBS_PER_PASS = 3

/** One feeder pass. Registered as a recurring background job. */
export async function runLanCacheFeeder(): Promise<void> {
  if (!isLanCacheConnected()) return
  const db = getDatabase()
  const wanted = computeWantedList(db.tracked(), db.history())
  if (!wanted.length) return

  const catalog = await lanCacheCatalog(wanted.map((entry) => entry.contentKey))
  if (!catalog) return // daemon unreachable — next pass tries again

  const have = new Set(catalog.items.map((item) => item.contentKey))
  const inFlight = new Set(catalog.inFlight.map((job) => job.contentKey))
  const tombstoned = new Set(catalog.tombstoned)

  let queued = 0
  for (const entry of wanted) {
    if (queued >= MAX_NEW_JOBS_PER_PASS) break
    if (have.has(entry.contentKey) || inFlight.has(entry.contentKey)) continue
    // Recently expired by the daemon's TTL — deliberately NOT re-queued.
    // Renewed interest (playing it, re-queueing from the UI) lifts the
    // tombstone daemon-side; the feeder alone never overrides expiry.
    if (tombstoned.has(entry.contentKey)) continue

    try {
      const candidate = await discoverBestPrefetchCandidate(
        entry.type,
        entry.resolveId,
        entry.title
      )
      if (!candidate?.infoHash) continue // nothing released yet — normal for future episodes
      const accepted = await queueLanCacheJob({
        contentKey: entry.contentKey,
        infoHash: candidate.infoHash,
        title: entry.title || String(candidate.name ?? ''),
        fileIdx: candidate.fileIdx,
        resolution: candidate.resolution,
        sizeBytes: Number(candidate.sizeBytes) || undefined,
        sources: sanitizeTrackers(candidate.sources)
      })
      if (accepted) queued += 1
    } catch (error) {
      logError('lancache:feeder', error)
    }
  }
}
