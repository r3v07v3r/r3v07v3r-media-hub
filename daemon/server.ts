// The daemon's HTTP surface: a small JSON API for the paired app, and a
// Range-capable /stream endpoint for the player.
//
// Auth model, in one place:
//  - /api/ping is unauthenticated by design — discovery needs an identity
//    check before pairing exists, and it exposes nothing but name/version.
//  - /api/pair is unauthenticated but throttled (see pairing.ts).
//  - every other /api route requires a paired bearer token.
//  - /stream takes the token as a query parameter, because the consumer is
//    mpv, which cannot send a header — the exact pattern the app already
//    uses for Jellyfin's api_key, and the reason the URL must never be
//    logged verbatim.
//
// Binds 0.0.0.0: serving the LAN is this process's entire purpose. What
// keeps that sane is that nothing beyond ping/pair answers without a token.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'

import type { ActivityTracker } from './activity'
import type { Credentials } from './credentials'
import type { UpdaterStatus } from './updater'
import type { JobStore, JobRecord } from './jobs'
import type { Pairing } from './pairing'
import type { ItemStore } from './storage'

const MAX_BODY_BYTES = 1024 * 1024

const CONTENT_TYPES: Record<string, string> = {
  '.mkv': 'video/x-matroska',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.ts': 'video/mp2t'
}

export interface ServerDeps {
  storage: ItemStore
  jobs: JobStore
  pairing: Pairing
  credentials: Credentials
  activity: ActivityTracker
  updaterStatus: () => UpdaterStatus
  serverName: string
  version: string
  diskBudgetBytes: number
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Body too large.'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {})
      } catch {
        reject(new Error('Body was not valid JSON.'))
      }
    })
    req.on('error', reject)
  })
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return undefined
  return header.slice('Bearer '.length).trim()
}

/** Serves one item file honouring a single-range Range header — the same
 *  206 contract the app's StreamCache consumes from Jellyfin, verified
 *  live against a real instance this project's test suite mirrors. */
async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  contentType: string
): Promise<void> {
  let stat: fs.Stats
  try {
    stat = await fsp.stat(filePath)
  } catch {
    res.writeHead(404)
    res.end()
    return
  }
  const total = stat.size
  const range = req.headers.range

  let start = 0
  let end = total - 1
  let status = 200
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!match || (match[1] === '' && match[2] === '')) {
      res.writeHead(416, { 'content-range': `bytes */${total}` })
      res.end()
      return
    }
    if (match[1] === '') {
      // suffix form: last N bytes
      const suffix = Number(match[2])
      start = Math.max(0, total - suffix)
    } else {
      start = Number(match[1])
      if (match[2] !== '') end = Math.min(Number(match[2]), total - 1)
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
      res.writeHead(416, { 'content-range': `bytes */${total}` })
      res.end()
      return
    }
    status = 206
  }

  const headers: Record<string, string | number> = {
    'content-type': contentType,
    'content-length': end - start + 1,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store'
  }
  if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${total}`
  res.writeHead(status, headers)

  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = fs.createReadStream(filePath, { start, end })
  stream.pipe(res)
  stream.on('error', () => {
    res.destroy()
  })
  res.on('close', () => {
    stream.destroy()
  })
}

export function createDaemonServer(deps: ServerDeps): http.Server {
  const { storage, jobs, pairing, credentials, activity, serverName, version } = deps

  return http.createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (!res.headersSent) json(res, 500, { error: (error as Error).message })
      else res.destroy()
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://daemon.invalid')
    const route = `${req.method} ${url.pathname}`

    // --- unauthenticated ---------------------------------------------------
    if (route === 'GET /api/ping') {
      json(res, 200, { product: 'r3-cache', serverName, version })
      return
    }
    if (route === 'POST /api/pair') {
      const body = await readBody(req)
      const token = await pairing.tryPair(String(body.code ?? ''), String(body.deviceName ?? ''))
      if (!token) {
        json(res, 403, { error: 'Pairing code not accepted.' })
        return
      }
      json(res, 200, { token, serverName })
      return
    }

    // --- /stream: token in query (mpv cannot send headers) -----------------
    const streamMatch = /^\/stream\/([a-f0-9]{40})$/.exec(url.pathname)
    if (streamMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      if (!pairing.isAuthorized(url.searchParams.get('token') ?? undefined)) {
        res.writeHead(403)
        res.end()
        return
      }
      // Counted BEFORE the awaits below, and released by exactly one
      // guarded closer. Counting after them left a window where a client
      // that aborted mid-await was never decremented, and a permanently
      // non-zero count silently disables every future update; counting
      // 404s and 416s the other way armed a fresh 30-minute deferral for
      // requests nobody was watching.
      let counted = false
      const releaseStream = (): void => {
        if (!counted) return
        counted = false
        activity.streamClosed()
      }
      if (req.method === 'GET') {
        counted = true
        activity.streamOpened()
        res.once('close', releaseStream)
      }

      const item = await storage.get(streamMatch[1])
      if (!item || !item.complete) {
        releaseStream()
        res.writeHead(404)
        res.end()
        return
      }
      void storage.touch(item.infoHash).catch(() => {})
      const ext = item.fileName.slice(item.fileName.lastIndexOf('.')).toLowerCase()
      await serveFile(
        req,
        res,
        storage.filePath(item),
        CONTENT_TYPES[ext] ?? 'application/octet-stream'
      )
      return
    }

    // --- everything else requires a paired token ---------------------------
    const callerToken = bearerToken(req)
    if (!pairing.isAuthorized(callerToken)) {
      json(res, 401, { error: 'Pair with this cache server first.' })
      return
    }
    // Which household member is asking — the key credentials and job
    // ownership are scoped by. Every authenticated route has one.
    const callerDeviceId = pairing.deviceIdFor(callerToken)

    if (route === 'GET /api/catalog') {
      // ?keys=a,b,c filters; without it the full picture is returned. The
      // feeder needs all three states to make a correct decision: cached
      // (skip), in-flight (skip), tombstoned (skip — recently evicted, do
      // not immediately refill).
      const filter = (url.searchParams.get('keys') ?? '')
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean)
      const wanted = filter.length ? new Set(filter) : null
      const items = (await storage.list()).filter((item) => !wanted || wanted.has(item.contentKey))
      const inFlight = jobs
        .list()
        .filter(
          (job) =>
            (job.state === 'queued' || job.state === 'fetching') &&
            (!wanted || wanted.has(job.contentKey))
        )
      const tombstones = await storage.tombstones()
      json(res, 200, {
        items: items.map((item) => ({
          contentKey: item.contentKey,
          infoHash: item.infoHash,
          title: item.title,
          resolution: item.resolution,
          sizeBytes: item.sizeBytes,
          complete: item.complete
        })),
        inFlight: inFlight.map((job) => ({
          contentKey: job.contentKey,
          state: job.state,
          progressBytes: job.progressBytes ?? 0,
          sizeBytes: job.sizeBytes
        })),
        tombstoned: wanted
          ? Object.keys(tombstones).filter((key) => wanted.has(key))
          : Object.keys(tombstones)
      })
      return
    }

    if (route === 'POST /api/jobs') {
      const body = await readBody(req)
      const record = jobs.enqueue({
        contentKey: String(body.contentKey ?? ''),
        infoHash: String(body.infoHash ?? '').toLowerCase(),
        title: String(body.title ?? ''),
        fileIdx: Number.isFinite(Number(body.fileIdx)) ? Number(body.fileIdx) : undefined,
        resolution: Number(body.resolution) || undefined,
        sizeBytes: Number(body.sizeBytes) || undefined,
        sources: Array.isArray(body.sources) ? body.sources.map(String).slice(0, 20) : undefined,
        ownerDeviceId: callerDeviceId
      })
      if (!record) {
        json(res, 400, { error: 'A job needs a contentKey, a 40-hex infoHash, and a title.' })
        return
      }
      // Queueing is an explicit statement of renewed interest, so it lifts
      // any tombstone for the same title.
      await storage.clearTombstone(record.contentKey)
      json(res, 200, { state: record.state })
      return
    }

    const jobMatch = /^\/api\/jobs\/(.+)$/.exec(url.pathname)
    if (jobMatch && req.method === 'DELETE') {
      jobs.cancel(decodeURIComponent(jobMatch[1]))
      json(res, 200, { ok: true })
      return
    }

    if (route === 'GET /api/status') {
      json(res, 200, {
        serverName,
        version,
        usedBytes: await storage.usedBytes(),
        budgetBytes: deps.diskBudgetBytes,
        itemCount: (await storage.list()).length,
        jobs: jobs.list().map(summarizeJob),
        // The CALLER's own opt-in state — each member sees whether THEIR
        // account is linked, plus how many household members are.
        torboxLinked: Boolean(credentials.tokenForDevice(callerDeviceId)),
        linkedDevices: credentials.linkedDeviceCount(),
        activeStreams: activity.snapshot().activeStreams,
        updater: deps.updaterStatus()
      })
      return
    }

    if (route === 'POST /api/credentials') {
      // Always scoped to the caller: one member's opt-in (or revocation)
      // can never touch another member's credential.
      const body = await readBody(req)
      await credentials.setTokenForDevice(callerDeviceId, String(body.torboxToken ?? ''))
      json(res, 200, {
        torboxLinked: Boolean(credentials.tokenForDevice(callerDeviceId)),
        linkedDevices: credentials.linkedDeviceCount()
      })
      return
    }

    json(res, 404, { error: 'Unknown route.' })
  }
}

function summarizeJob(job: JobRecord): Record<string, unknown> {
  return {
    contentKey: job.contentKey,
    title: job.title,
    state: job.state,
    attempts: job.attempts,
    progressBytes: job.progressBytes ?? 0,
    sizeBytes: job.sizeBytes,
    lastError: job.lastError
  }
}
