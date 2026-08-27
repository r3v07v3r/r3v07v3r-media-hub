// The fetch loop: turns queued jobs into complete files on disk.
//
// One download at a time, sequentially — this daemon's reason to exist is
// a SLOW internet connection, and two parallel fetches on a slow link just
// make both take twice as long while doubling the partial-file exposure if
// the box goes down.
//
// Downloads go through the app's own safeFetch machinery
// (fetchMediaWithRetry: public-https validation, redirect re-validation,
// bounded retries) — shared, not reimplemented, so the daemon can never be
// more permissive about what it fetches than the app is.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { fetchMediaWithRetry } from '../src/main/media-hub/playback'
import type { Credentials } from './credentials'
import type { JobStore, JobRecord } from './jobs'
import type { ItemStore } from './storage'
import { resolveDownload, type ResolvedDownload } from './torbox'

const IDLE_POLL_MS = 15_000
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000] as const
/** Free space that must remain AFTER a fetch completes. */
const DISK_MARGIN_BYTES = 2 * 1024 ** 3

export interface Fetcher {
  start(): void
  stop(): Promise<void>
}

export interface FetcherDeps {
  jobs: JobStore
  storage: ItemStore
  credentials: Credentials
  dataDir: string
  log: (message: string) => void
  /** Test seam: the TorBox resolve step, injectable so the download loop
   *  can be exercised against a stub content host. Production always uses
   *  the real client. */
  resolveDownloadImpl?: (
    token: string,
    infoHash: string,
    options: { fileIdx?: number; sources?: string[]; season?: number; episode?: number }
  ) => Promise<ResolvedDownload | null>
}

export function createFetcher({
  jobs,
  storage,
  credentials,
  dataDir,
  log,
  resolveDownloadImpl = resolveDownload
}: FetcherDeps): Fetcher {
  let running = false
  let wake: (() => void) | null = null
  let loopDone: Promise<void> = Promise.resolve()
  const nextAttemptAt = new Map<string, number>()

  async function sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      wake = resolve
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
    wake = null
  }

  function eligible(job: JobRecord): boolean {
    return (nextAttemptAt.get(job.contentKey) ?? 0) <= Date.now()
  }

  async function fetchOne(job: JobRecord): Promise<void> {
    const token = credentials.torboxToken()
    if (!token) {
      // No credential — the app hasn't opted in (or revoked it). Jobs wait;
      // the app can also push refreshed links by re-queueing while running.
      return
    }
    jobs.update(job.contentKey, { state: 'fetching', attempts: job.attempts + 1 })

    try {
      const parts = job.contentKey.split(':')
      const episode = Number(parts.at(-1))
      const season = Number(parts.at(-2))
      const episodic = parts.length >= 3 && Number.isFinite(season) && Number.isFinite(episode)

      const resolved = await resolveDownloadImpl(token, job.infoHash, {
        fileIdx: job.fileIdx,
        sources: job.sources,
        season: episodic ? season : undefined,
        episode: episodic ? episode : undefined
      })
      if (!resolved) {
        // TorBox is still ingesting the torrent — genuinely retry-later.
        throw new Error('TorBox has no fetchable file for this torrent yet.')
      }

      // Refuse to start a download the disk cannot hold. The eviction pass
      // keeps the budget; this keeps the DRIVE — they are different limits.
      const stat = await fsp.statfs(dataDir)
      const free = stat.bavail * stat.bsize
      if (resolved.sizeBytes > 0 && free < resolved.sizeBytes + DISK_MARGIN_BYTES) {
        throw new Error(
          `Not enough free disk for ${(resolved.sizeBytes / 1024 ** 3).toFixed(1)} GB.`
        )
      }

      const dir = await storage.beginItem({
        contentKey: job.contentKey,
        title: job.title,
        infoHash: job.infoHash,
        fileName: resolved.fileName,
        sizeBytes: resolved.sizeBytes,
        resolution: job.resolution,
        sourceRef: { source: 'torbox', infoHash: job.infoHash },
        fetchedAt: Date.now(),
        lastAccessAt: Date.now()
      })
      const filePath = path.join(dir, resolved.fileName)

      // Resume a partial from a previous attempt/restart with a Range
      // request rather than starting over — on the slow link this daemon
      // is for, re-downloading half a film is the expensive failure.
      let already = 0
      try {
        already = (await fsp.stat(filePath)).size
      } catch {
        // Nothing yet.
      }
      if (resolved.sizeBytes > 0 && already >= resolved.sizeBytes) {
        jobs.update(job.contentKey, { state: 'ready', progressBytes: already })
        return
      }

      const headers: Record<string, string> = {}
      if (already > 0) headers.Range = `bytes=${already}-`
      const response = await fetchMediaWithRetry(resolved.url, { headers })
      if (!response.ok || !response.body) {
        throw new Error(`Download request failed (${response.status}).`)
      }
      // A server that ignored the Range and replied 200 restarts the file;
      // appending would corrupt it.
      const appending = already > 0 && response.status === 206
      const out = fs.createWriteStream(filePath, appending ? { flags: 'a' } : undefined)
      let written = appending ? already : 0

      const reader = response.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          const current = jobs.list().find((candidate) => candidate.contentKey === job.contentKey)
          if (!running || !current || current.state !== 'fetching') {
            // Cancelled or shutting down — keep the partial for resume.
            await reader.cancel()
            break
          }
          if (!out.write(value)) {
            await new Promise<void>((resolve) => out.once('drain', resolve))
          }
          written += value.length
          jobs.update(job.contentKey, { progressBytes: written })
        }
      } finally {
        await new Promise<void>((resolve) => out.end(resolve))
      }

      const finalSize = (await fsp.stat(filePath)).size
      if (resolved.sizeBytes > 0 && finalSize < resolved.sizeBytes) {
        throw new Error(
          `Download incomplete: ${finalSize} of ${resolved.sizeBytes} bytes — will resume.`
        )
      }
      jobs.update(job.contentKey, { state: 'ready', progressBytes: finalSize })
      nextAttemptAt.delete(job.contentKey)
      log(`fetched  ${job.title} (${(finalSize / 1024 ** 3).toFixed(2)} GB)`)
    } catch (error) {
      const attempts = job.attempts + 1
      const backoff = RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)]
      nextAttemptAt.set(job.contentKey, Date.now() + backoff)
      jobs.update(job.contentKey, {
        // Back to queued, not failed: jobs.prune expires anything
        // unfetchable for 48h, which is the real give-up point.
        state: 'queued',
        lastError: (error as Error).message
      })
      log(`retrying ${job.title}: ${(error as Error).message}`)
    }
  }

  return {
    start() {
      if (running) return
      running = true
      loopDone = (async () => {
        while (running) {
          jobs.prune()
          const next = jobs
            .list()
            .filter((job) => job.state === 'queued' && eligible(job))
            .sort((a, b) => a.queuedAt - b.queuedAt)[0]
          if (next) await fetchOne(next)
          else await sleep(IDLE_POLL_MS)
        }
      })()
    },
    async stop() {
      running = false
      wake?.()
      await loopDone
    }
  }
}
