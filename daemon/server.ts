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
import { deviceIdForToken, isApproved, type Pairing } from './pairing'
import type { Admin } from './admin'
import { isEntitled, type ItemStore } from './storage'

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
  admin: Admin
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
  const { storage, jobs, pairing, credentials, activity, serverName, version, admin} = deps

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
      // `unclaimed` is deliberately on the UNAUTHENTICATED ping: an app that
      // has just discovered this daemon over mDNS needs to know whether to
      // offer the claim button before it has any credential. It leaks only
      // that nobody administers this server yet, which is precisely what the
      // installer needs to see and what the design wants said loudly.
      json(res, 200, {
        product: 'r3-cache',
        serverName,
        version,
        unclaimed: admin.isUnclaimed()
      })
      return
    }
    // Claiming needs a paired token (so the claimer is a real device with
    // an identity) but obviously cannot require admin — nobody is admin
    // yet. It sits here, above the admin gate, for that reason.
    if (route === 'POST /api/admin/claim') {
      const claimToken = bearerToken(req)
      if (!pairing.isAuthorized(claimToken)) {
        json(res, 401, { error: 'Pair with this cache server first.' })
        return
      }
      const claimed = await admin.claim(pairing.deviceIdFor(claimToken))
      if (!claimed) {
        // Already administered. Says so plainly rather than pretending to
        // succeed — and names the recovery path, because the console is the
        // only authority that can reopen this and somebody locked out needs
        // to know that.
        json(res, 409, {
          error: 'This server already has an administrator.',
          recovery: 'Run the daemon with --claim-admin at its console to reopen claiming.'
        })
        return
      }
      json(res, 200, { isAdmin: true })
      return
    }

    if (route === 'POST /api/pair') {
      const body = await readBody(req)
      const deviceName = String(body.deviceName ?? '')
      const code = String(body.code ?? '')

      // The code path stays until A5. Removing it here would strand every
      // app build that still sends one, and the plan's order exists because
      // approval has to be provably working before the old door closes.
      if (code) {
        const token = await pairing.tryPair(code, deviceName)
        if (!token) {
          json(res, 403, { error: 'Pairing code not accepted.' })
          return
        }
        json(res, 200, { token, serverName, status: 'approved' })
        return
      }

      // Codeless: ask to join, and wait. The token issued here is real and
      // authorises NOTHING — every authenticated route goes through
      // isAuthorized, which now requires approval.
      const token = await pairing.requestPairing(deviceName)

      // Two ways to skip the wait, and only two.
      //
      // openJoin is the admin's explicit 'anyone on this network may join'.
      //
      // isUnclaimed is the bootstrap, and it does not widen anything: while
      // nobody administers this box, ANY device on the LAN can already take
      // admin outright via /api/admin/claim, which is strictly more than
      // being let in as a user. Making pairing wait for an approver who
      // cannot exist yet would just deadlock the first install once the
      // code goes away in A5. Same window, already bounded by the console.
      const autoApprove = admin.openJoin() || admin.isUnclaimed()
      if (autoApprove) await pairing.setStatus(deviceIdForToken(token), 'approved')
      json(res, 200, {
        token,
        serverName,
        status: autoApprove ? 'approved' : 'pending'
      })
      return
    }

    // A pending device's ONE capability: asking whether it has been let in.
    // Above the auth gate by necessity — isAuthorized says no to exactly the
    // devices that need this answer.
    if (route === 'GET /api/pair/status') {
      const device = pairing.findByToken(bearerToken(req))
      if (!device) {
        json(res, 401, { error: 'Unknown device.' })
        return
      }
      json(res, 200, {
        status: isApproved(device) ? 'approved' : 'pending',
        serverName,
        deviceName: device.deviceName
      })
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

      // ENTITLEMENT, and the reason the two failures below are one branch.
      //
      // Authorising on "is this token paired" was the hole: pairing bought
      // the right to stream every item in the cache. It authorises on
      // entitlement now — but WHICH failure occurred must not be
      // observable.
      //
      // Torrent infohashes for popular titles are public. A daemon that
      // answers "not for you" differently from "not here" is fully
      // enumerable: walk a few thousand known hashes and you learn exactly
      // what this household watches, without ever being entitled to any of
      // it. So a hash the caller may not have and a hash that does not
      // exist produce the SAME status and the SAME empty body, from the
      // same statement — not two branches that happen to match today and
      // drift the first time someone adds a helpful message to one of them.
      const streamDevice = pairing.deviceIdFor(url.searchParams.get('token') ?? undefined)
      const item = await storage.get(streamMatch[1])
      const mayStream = Boolean(item && item.complete && isEntitled(item, streamDevice ?? ''))
      if (!mayStream || !item) {
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

    // --- admin: the cache server's own administration ----------------------
    //
    // Gated on admin.isAdmin, which is decided by the daemon from what it
    // has on disk. Never on anything the caller sends — a lock the backend
    // does not enforce is theatre.
    //
    // Note what is NOT here: no route that lists or streams another device's
    // items. The admin has a shell on this box and can read every file on
    // it, so this is not a security boundary — but building the capability
    // into the product would make 'the admin can browse your library' a
    // feature rather than a property of owning the hardware.
    const isAdminCaller = admin.isAdmin(callerDeviceId)

    if (route === 'GET /api/admin/devices') {
      if (!isAdminCaller) {
        json(res, 403, { error: 'Only the administrator of this server can do that.' })
        return
      }
      json(res, 200, {
        // Tokens never leave pairing.ts. Everything here is addressed by the
        // device id, which is a hash of the token and safe to show.
        devices: pairing.listDevices().map((device) => ({
          id: deviceIdForToken(device.token),
          deviceName: device.deviceName,
          createdAt: device.createdAt,
          status: isApproved(device) ? 'approved' : 'pending',
          approvedAt: device.approvedAt ?? 0,
          quotaBytes: device.quotaBytes ?? null,
          isAdmin: admin.isAdmin(deviceIdForToken(device.token)),
          isYou: deviceIdForToken(device.token) === callerDeviceId
        })),
        openJoin: admin.openJoin()
      })
      return
    }

    const deviceMatch = /^\/api\/admin\/devices\/([a-f0-9]{16})$/.exec(url.pathname)
    if (deviceMatch && req.method === 'POST') {
      if (!isAdminCaller) {
        json(res, 403, { error: 'Only the administrator of this server can do that.' })
        return
      }
      const targetId = deviceMatch[1]
      const body = await readBody(req)
      const action = String(body.action ?? '')

      // Removing your own device locks you out of a box only the console can
      // reopen. Refused explicitly rather than left as a one-click mistake.
      if ((action === 'deny' || action === 'revoke') && targetId === callerDeviceId) {
        json(res, 409, {
          error: 'That is this device. Removing it would lock you out.',
          recovery: 'Run the daemon with --claim-admin at its console to reopen claiming.'
        })
        return
      }

      let ok = false
      switch (action) {
        case 'approve':
          ok = await pairing.setStatus(targetId, 'approved')
          break
        // deny (never approved) and revoke (was approved) are the same act —
        // forget the device — and are named separately only because they read
        // differently to the admin. Kept as one implementation so they cannot
        // drift into meaning different things.
        case 'deny':
        case 'revoke':
          ok = await pairing.removeDevice(targetId)
          break
        case 'quota': {
          const raw = body.quotaBytes
          ok = await pairing.setQuota(targetId, raw === null ? null : Number(raw))
          break
        }
        default:
          json(res, 400, { error: 'Unknown action.' })
          return
      }
      if (!ok) {
        json(res, 404, { error: 'No such device.' })
        return
      }
      json(res, 200, { ok: true })
      return
    }

    if (route === 'POST /api/admin/settings') {
      if (!isAdminCaller) {
        json(res, 403, { error: 'Only the administrator of this server can do that.' })
        return
      }
      const body = await readBody(req)
      if (typeof body.openJoin === 'boolean') await admin.setOpenJoin(body.openJoin)
      json(res, 200, { openJoin: admin.openJoin() })
      return
    }

    if (route === 'GET /api/catalog') {
      // ?keys=a,b,c is now REQUIRED, and the unfiltered branch is gone.
      //
      // It used to return every cached item, with titles, to any paired
      // device — the read-side hole this whole feature closes. It was also
      // dead weight: the app never asked for it. lanCacheFeeder always
      // passes keys derived from its own watchlist and returns early on an
      // empty want-list, and resolve asks about exactly one key. So it is
      // deleted rather than fixed; there is nothing to preserve.
      //
      // The feeder still gets all three states it needs to decide — cached,
      // in-flight, tombstoned — just only for keys it named.
      const filter = (url.searchParams.get('keys') ?? '')
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean)
      if (!filter.length) {
        json(res, 200, { items: [], inFlight: [], tombstoned: [] })
        return
      }
      const wanted = new Set(filter)
      // Scoped to the asker. Same predicate the stream route uses, so what
      // you can see and what you can play can never disagree.
      const items = (await storage.list()).filter(
        (item) => wanted.has(item.contentKey) && isEntitled(item, callerDeviceId ?? '')
      )
      const inFlight = jobs
        .list()
        .filter(
          (job) =>
            (job.state === 'queued' || job.state === 'fetching') &&
            wanted.has(job.contentKey)
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
        tombstoned: Object.keys(tombstones).filter((key) => wanted.has(key))
      })
      return
    }

    if (route === 'POST /api/jobs') {
      const body = await readBody(req)
      // DEDUPE, and the reason a cache is worth running at all.
      //
      // If this hash is already on disk, the asker is entitled to the copy
      // that exists rather than causing a second download of the same file.
      // Private-by-default would otherwise collide head-on with the point of
      // a shared cache: two people wanting one film would cost two copies of
      // the disk and two copies of the bandwidth.
      //
      // This reveals nothing. The caller named that exact infohash, so they
      // already knew the release existed, and could have fetched it on their
      // own account regardless.
      //
      // The residual leak, named rather than papered over: they can infer
      // from the speed that it was already here. That is the price of a
      // shared cache being shared, and a fake delay would cost real time to
      // hide something a determined observer measures anyway.
      const dedupeHash = String(body.infoHash ?? '').toLowerCase()
      if (callerDeviceId && /^[a-f0-9]{40}$/.test(dedupeHash)) {
        const held = await storage.get(dedupeHash)
        if (held?.complete) {
          await storage.grantEntitlement(dedupeHash, callerDeviceId)
          await storage.clearTombstone(held.contentKey)
          json(res, 200, { state: 'ready' })
          return
        }
      }
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
