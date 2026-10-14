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
   *  new requester can (see the ownership rule inside). */
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
          // loses nothing: its feeder sees the title in flight and waits,
          // and when it asks again after the file lands it is granted the
          // copy that exists (the dedupe path in POST /api/jobs).
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
