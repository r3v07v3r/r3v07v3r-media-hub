// The pre-fetch job queue.
//
// A job is queued BY TORRENT IDENTITY (infoHash), never by download link:
// TorBox links expire in hours, and the whole point of the hybrid model is
// that the daemon can finish work overnight with no app running — so the
// durable fact is "which torrent", and a fresh link is minted at fetch
// time (fetcher.ts).
//
// Persisted as one JSON file with atomic writes. The queue is small (a
// watchlist, not a crawl), single-process, and mutated from HTTP handlers
// and the fetch loop in the same event loop — a database would add a
// dependency without adding a guarantee this needs.

import fsp from 'node:fs/promises'
import path from 'node:path'

export type JobState = 'queued' | 'fetching' | 'ready' | 'failed' | 'expired'

export interface JobRecord {
  /** Same identity the item store uses — catalogId:season:episode. */
  contentKey: string
  infoHash: string
  title: string
  /** The scraper's file index into the torrent, when it provided one. */
  fileIdx?: number
  resolution?: number
  sizeBytes?: number
  /** Tracker list for magnet reconstruction, already sanitized app-side. */
  sources?: string[]
  /** Which paired device queued this — and therefore WHOSE TorBox account
   *  the fetch bills. A job is only ever fetched with its owner's token. */
  ownerDeviceId?: string
  /** Why this was asked for: 'watching' is the next episode of something
   *  somebody is partway through, 'prefetch' is from a watchlist. Absent on
   *  jobs queued before it existed. */
  reason?: 'watching' | 'prefetch'
  state: JobState
  queuedAt: number
  attempts: number
  /** Set while fetching: bytes written so far, for /api/status. */
  progressBytes?: number
  lastError?: string
}

/** A job unfetchable for this long is marked expired and stops retrying —
 *  the feeder can re-queue it later if the title is still wanted. */
const JOB_EXPIRY_MS = 48 * 60 * 60 * 1000

const INFO_HASH_RE = /^[a-f0-9]{40}$/

export interface EnqueueOptions {
  /** Whether a device has shared a TorBox credential this daemon can fetch
   *  with. Consulted only when a second device asks for a job that is still
   *  queued, to decide whether the job may change hands. Left out, nobody
   *  is assumed able to fetch, so a job keeps the device that queued it. */
  canFetch?: (deviceId: string) => boolean
}

export interface JobStore {
  list(): JobRecord[]
  /** Adds or refreshes a job. An existing ready/fetching entry for the same
   *  content is left alone — queueing is idempotent from the feeder's view.
   *  A queued one keeps its owner unless that owner cannot fetch it and the
   *  new requester can (see the ownership rule inside). A queued/fetching
   *  job for the same file under another contentKey (sameFile) is returned
   *  instead of starting a second download of it. */
  enqueue(
    job: Omit<JobRecord, 'state' | 'queuedAt' | 'attempts'>,
    options?: EnqueueOptions
  ): JobRecord | null
  cancel(contentKey: string): boolean
  /** The next job the fetch loop should work on, oldest first. */
  nextQueued(): JobRecord | null
  update(contentKey: string, patch: Partial<JobRecord>): void
  /** Drops ready/expired records that no longer need remembering. */
  prune(now?: number): void
  load(): Promise<void>
}

/** The season:episode tail of a contentKey, or '' for a film key. */
function episodeTail(contentKey: string): string {
  const parts = contentKey.split(':')
  if (parts.length < 3) return ''
  const season = parts.at(-2) ?? ''
  const episode = parts.at(-1) ?? ''
  return /^\d+$/.test(season) && /^\d+$/.test(episode) ? `${season}:${episode}` : ''
}

/**
 * Whether two jobs would download the same file. The same infoHash is not
 * enough on its own: a season pack is one torrent holding many episodes,
 * each a job of its own. So the file index has to match when either side
 * names one, and with no index on either side the episode named by the key
 * has to match (two film keys match, a film and an episode do not).
 */
export function sameFile(
  a: Pick<JobRecord, 'infoHash' | 'fileIdx' | 'contentKey'>,
  b: Pick<JobRecord, 'infoHash' | 'fileIdx' | 'contentKey'>
): boolean {
  if (a.infoHash !== b.infoHash) return false
  if (a.fileIdx !== undefined || b.fileIdx !== undefined) return a.fileIdx === b.fileIdx
  return episodeTail(a.contentKey) === episodeTail(b.contentKey)
}

/**
 * Whether a stored item is the file a request asks for. Stricter about the
 * index than sameFile only where it has to be: both sides naming an index
 * must agree, and otherwise (an item written before the index was
 * recorded, or a request without one) the episode named by the keys
 * decides, so one episode of a season pack is never answered with another.
 */
export function heldIsSameFile(
  held: Pick<JobRecord, 'infoHash' | 'fileIdx' | 'contentKey'>,
  asked: Pick<JobRecord, 'infoHash' | 'fileIdx' | 'contentKey'>
): boolean {
  if (held.infoHash !== asked.infoHash) return false
  if (held.fileIdx !== undefined && asked.fileIdx !== undefined) {
    return held.fileIdx === asked.fileIdx
  }
  return episodeTail(held.contentKey) === episodeTail(asked.contentKey)
}

export function createJobStore(dataDir: string): JobStore {
  const jobsPath = path.join(dataDir, 'jobs.json')
  let jobs: JobRecord[] = []
  let persistTimer: NodeJS.Timeout | null = null

  // Writes are coalesced: progress updates arrive per-chunk during a
  // download, and each one does not deserve its own fsync.
  function schedulePersist(): void {
    if (persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      void persist()
    }, 500)
    persistTimer.unref?.()
  }

  async function persist(): Promise<void> {
    try {
      const tmp = `${jobsPath}.tmp`
      await fsp.writeFile(tmp, JSON.stringify({ jobs }))
      await fsp.rename(tmp, jobsPath)
    } catch {
      // Best-effort: a lost queue re-fills from the feeder's next pass.
    }
  }

  return {
    list: () => [...jobs],
    enqueue(input, options) {
      if (!INFO_HASH_RE.test(input.infoHash)) return null
      if (!input.contentKey || !input.title) return null
      const existing = jobs.find((job) => job.contentKey === input.contentKey)
      if (existing) {
        // Never restart something in flight or already done; but a failed/
        // expired record is superseded by a fresh request (possibly a
        // different, newly-available release).
        if (
          existing.state === 'queued' ||
          existing.state === 'fetching' ||
          existing.state === 'ready'
        ) {
          // A SECOND REQUESTER JOINS, it does not take over.
          //
          // This used to hand any queued job to whoever asked for it last.
          // Ownership decides whose TorBox account pays, whose allocation the
          // file is charged to, who the finished item is entitled to and who
          // may cancel it — so a housemate who named the same title took all
          // four, and could then cancel a download the first device was
          // about to make. The first owner keeps it now. The second device
          // waits instead: its feeder sees the title in flight, and when it
          // asks again for the same release after the file lands it is
          // granted the copy that exists (the dedupe path in POST /api/jobs).
          // Dedupe matches the exact release, though. If that feeder has
          // since picked a different one, it is answered with this ready
          // record and granted nothing, and gets its own job (and a second
          // download) only once the record ages out of this store.
          //
          // The one case where the job still changes hands is the one the
          // old rule was written for: a job stuck queued because its owner
          // never shared a TorBox credential, wanted by somebody whose
          // account CAN fetch it. That job could not be fetched at all as it
          // stood, so moving it takes nothing from anyone.
          const adopter = input.ownerDeviceId
          if (
            existing.state === 'queued' &&
            adopter &&
            adopter !== existing.ownerDeviceId &&
            options?.canFetch &&
            !options.canFetch(existing.ownerDeviceId ?? '') &&
            options.canFetch(adopter)
          ) {
            existing.ownerDeviceId = adopter
            schedulePersist()
          }
          // A prefetch that somebody has since started watching is a watch.
          // Only ever upgraded, never the other way: once a person is
          // partway through the series, a second device adding it to a
          // watchlist does not make the queue less urgent than it was.
          if (
            existing.state === 'queued' &&
            input.reason === 'watching' &&
            existing.reason !== 'watching'
          ) {
            existing.reason = 'watching'
            schedulePersist()
          }
          return existing
        }
        jobs = jobs.filter((job) => job !== existing)
      }
      // THE SAME FILE UNDER ANOTHER NAME joins the download already under
      // way. Storage is keyed by infoHash, so two jobs for one release (the
      // same film asked for as tt and as kitsu, say) would both fetch into
      // the same folder, and the second would rewrite meta.json and drop
      // the first owner's entitlement. The existing job keeps its owner,
      // exactly as a second requester for the same contentKey does above.
      const sameRelease = jobs.find(
        (job) =>
          job.contentKey !== input.contentKey &&
          (job.state === 'queued' || job.state === 'fetching') &&
          sameFile(job, input)
      )
      if (sameRelease) {
        // The same healing as above: a queued job whose owner cannot fetch
        // it (their key was removed) goes to a joiner who can, or it would
        // park forever with the joiner's request inside it.
        const adopter = input.ownerDeviceId
        if (
          sameRelease.state === 'queued' &&
          adopter &&
          adopter !== sameRelease.ownerDeviceId &&
          options?.canFetch &&
          !options.canFetch(sameRelease.ownerDeviceId ?? '') &&
          options.canFetch(adopter)
        ) {
          sameRelease.ownerDeviceId = adopter
          schedulePersist()
        }
        if (
          sameRelease.state === 'queued' &&
          input.reason === 'watching' &&
          sameRelease.reason !== 'watching'
        ) {
          sameRelease.reason = 'watching'
          schedulePersist()
        }
        return sameRelease
      }
      const record: JobRecord = {
        ...input,
        state: 'queued',
        queuedAt: Date.now(),
        attempts: 0
      }
      jobs.push(record)
      schedulePersist()
      return record
    },
    cancel(contentKey) {
      const before = jobs.length
      // A fetching job is marked rather than removed — the fetch loop owns
      // the in-flight download and checks state between chunks.
      jobs = jobs.filter((job) => !(job.contentKey === contentKey && job.state === 'queued'))
      // TWO WAYS TO CANCEL SOMETHING, and the count only sees one of them.
      // Comparing lengths reported false for the case that had most
      // obviously worked — stopping a download in flight — because that
      // path marks the record instead of dropping it. The route reads this
      // to decide between "stopped" and "there was nothing to stop", so it
      // has to mean "did anything change".
      let changed = jobs.length !== before
      for (const job of jobs) {
        if (job.contentKey === contentKey && job.state === 'fetching') {
          job.state = 'expired'
          job.lastError = 'Cancelled.'
          changed = true
        }
      }
      schedulePersist()
      return changed
    },
    nextQueued() {
      const queued = jobs
        .filter((job) => job.state === 'queued')
        .sort((a, b) => a.queuedAt - b.queuedAt)
      return queued[0] ?? null
    },
    update(contentKey, patch) {
      const job = jobs.find((candidate) => candidate.contentKey === contentKey)
      if (!job) return
      Object.assign(job, patch)
      schedulePersist()
    },
    prune(now = Date.now()) {
      jobs = jobs.filter((job) => {
        if (job.state === 'queued' && now - job.queuedAt >= JOB_EXPIRY_MS) {
          job.state = 'expired'
          job.lastError = 'Not fetchable within 48 hours.'
        }
        // ready records age out quickly (the item store is the truth once
        // fetched); expired/failed stay visible for a day of debugging.
        if (job.state === 'ready') return now - job.queuedAt < 60 * 60 * 1000
        if (job.state === 'expired' || job.state === 'failed') {
          return now - job.queuedAt < 24 * 60 * 60 * 1000
        }
        return true
      })
      schedulePersist()
    },
    async load() {
      try {
        const parsed = JSON.parse(await fsp.readFile(jobsPath, 'utf8')) as { jobs?: JobRecord[] }
        if (Array.isArray(parsed.jobs)) {
          jobs = parsed.jobs
          // A job that was mid-fetch when the process died restarts cleanly.
          for (const job of jobs) {
            if (job.state === 'fetching') job.state = 'queued'
          }
        }
      } catch {
        // First run.
      }
    }
  }
}
