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
import type { ApplyNowResult, UpdaterStatus } from './updater'
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
  /** The administrator asking for the update by hand. Optional so a server
   *  built without an updater (the tests) still constructs; the route says
   *  so plainly rather than pretending to have done something. */
  applyUpdateNow?: () => Promise<ApplyNowResult>
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
  const { storage, jobs, pairing, credentials, activity, serverName, version, admin } = deps

  return http.createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (!res.headersSent) json(res, 500, { error: (error as Error).message })
      else res.destroy()
    })
  })

  /** The default allocation as a byte figure on THIS disk, or null when no
   *  default is set — which is every install until an admin sets one. */
  function effectiveDefaultQuota(): number | null {
    const percent = admin.defaultQuotaPercent()
    return percent > 0 ? Math.floor((deps.diskBudgetBytes * percent) / 100) : null
  }

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
        unclaimed: admin.isUnclaimed(),
        // The app checks this before routing room subscriptions through
        // the LAN instead of straight to the relay.
        roomsHop: true
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

      // No code. The device asks, and the token it gets back authorises
      // NOTHING — every authenticated route goes through isAuthorized,
      // which requires approval.
      //
      // The device NAME is what the administrator sees in the approval
      // list, so an unnamed request is one nobody can sensibly say yes to.
      const token = await pairing.requestPairing(deviceName)
      if (!token) {
        // Throttled, or too many devices already waiting. 429 rather than
        // 403: nothing was refused about this device, it was refused about
        // the timing, and an app that retries later should be told so.
        json(res, 429, {
          error: 'Too many devices are waiting to join. Try again shortly.'
        })
        return
      }

      // Two ways to skip the wait, and only two.
      //
      // openJoin is the admin's explicit 'anyone on this network may join'.
      //
      // isUnclaimed is the bootstrap, and it does not widen anything: while
      // nobody administers this box, ANY device on the LAN can already take
      // admin outright via /api/admin/claim, which is strictly more than
      // being let in as a user. Making the first device wait for an approver
      // who cannot exist yet would deadlock every fresh install.
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
        activity.streamClosed(streamMatch[1])
      }
      if (req.method === 'GET') {
        counted = true
        activity.streamOpened(streamMatch[1])
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
        openJoin: admin.openJoin(),
        defaultQuotaPercent: admin.defaultQuotaPercent(),
        // What the percentage actually works out to on THIS disk, so the
        // admin is choosing against a real figure rather than a ratio.
        defaultQuotaBytes: effectiveDefaultQuota(),
        diskBudgetBytes: deps.diskBudgetBytes
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
          // AND its TorBox token, AND the work being done on its behalf, in
          // the same act. Forgetting a device has to mean forgetting what it
          // lent us and what we were doing for it.
          //
          // The credential: dropping only the pairing record left the shared
          // secret behind in credentials.json, still counted as a linked
          // account and still usable — and the device that shared it could
          // never clear it, because clearing goes through /api/credentials,
          // which needs the authentication it had just lost.
          //
          // The jobs: clearing the credential does NOT stop a fetch already
          // running, because fetchOne copies the token into a local before
          // the first byte. Left alone it would keep spending the revoked
          // person's TorBox quota after their access was taken away, and
          // finish by writing an item entitled only to a device that no
          // longer exists — a file nobody on this server can read. Queued
          // jobs fare no better: with no credential they park on 'waiting
          // for TorBox access' and retry every five minutes forever.
          //
          // jobs.cancel handles both halves through the mechanism that
          // already exists: queued entries are dropped, and a fetching one is
          // marked expired, which the download loop notices between chunks
          // and aborts on.
          //
          // What this deliberately does NOT do is delete the items that
          // device already fetched. Reclaiming those is a deletion decision
          // that deserves its own design rather than being a side effect of
          // revoking access — the whole-disk budget still bounds them in the
          // meantime.
          if (ok) {
            await credentials.setTokenForDevice(targetId, '')
            for (const job of jobs.list()) {
              if (job.ownerDeviceId === targetId) jobs.cancel(job.contentKey)
            }
          }
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

    // UPDATE NOW. The daemon updates itself on its own schedule, which is
    // the right default and a poor answer to "I have just cut a release and
    // I want it on the box". This checks the feed immediately and installs
    // as soon as it can.
    //
    // It does NOT override the one hard rule: nothing restarts while
    // somebody is watching. An administrator can decide the household's
    // update policy; they should not be able to end someone else's film
    // from a settings page by accident. When a stream is open the answer
    // says so, and the update goes in the moment it closes.
    if (route === 'POST /api/admin/update') {
      if (!isAdminCaller) {
        json(res, 403, { error: 'Only the administrator of this server can do that.' })
        return
      }
      if (!deps.applyUpdateNow) {
        json(res, 501, { error: 'This server has no updater.' })
        return
      }
      const result = await deps.applyUpdateNow()
      json(res, 200, result)
      return
    }

    if (route === 'POST /api/admin/settings') {
      if (!isAdminCaller) {
        json(res, 403, { error: 'Only the administrator of this server can do that.' })
        return
      }
      const body = await readBody(req)
      if (typeof body.openJoin === 'boolean') await admin.setOpenJoin(body.openJoin)
      if (body.defaultQuotaPercent !== undefined) {
        await admin.setDefaultQuotaPercent(Number(body.defaultQuotaPercent))
      }
      json(res, 200, {
        openJoin: admin.openJoin(),
        defaultQuotaPercent: admin.defaultQuotaPercent()
      })
      return
    }

    // The caller's OWN items, which is the one listing entitlement allows.
    //
    // The unfiltered catalog was deleted in A1 because it handed every
    // paired device the whole disk with titles. This is the opposite: it is
    // scoped to ownerDeviceId, so it can only ever return what this device
    // paid for. Without it there is no way for somebody to see their own
    // cached titles in order to share them, which left the sharing route
    // built and unreachable.
    // Cancel a queued or in-flight fetch. YOUR OWN only: the queue is
    // scoped to the caller everywhere else, and a route that cancelled by
    // contentKey alone would let any paired device stop a housemate's
    // download without ever being able to see it.
    //
    // The admin gets no exception. Revoking a device already cancels its
    // jobs, which is the administrative lever over somebody else's work;
    // reaching into a queue item by item is not.
    if (route === 'POST /api/jobs/cancel') {
      const body = await readBody(req)
      const contentKey = String(body.contentKey ?? '')
      const job = jobs.list().find((candidate) => candidate.contentKey === contentKey)
      // Owner or admin, matching the remove route below and following from
      // the queue being visible to the admin at all: the reason they are
      // shown it is to answer "why is this box saturated", and a view with
      // no way to act on it does not answer that. It stays narrow — the
      // admin can stop work, not read what anyone has watched.
      const mayCancel = Boolean(job) && (job?.ownerDeviceId === callerDeviceId || isAdminCaller)
      if (!job || !mayCancel) {
        // Same shape as everywhere else: a job that is not yours is
        // indistinguishable from one that does not exist.
        json(res, 404, { error: 'No such job.' })
        return
      }
      // THERE HAS TO BE SOMETHING TO CANCEL. A ready record lingers for an
      // hour and an expired one for a day, both still listed, and
      // jobs.cancel does not touch either — it returned false and the route
      // reported success anyway, so the button did nothing and said it had
      // worked. Saying so plainly is better than a silent no-op, and the
      // button is no longer offered on those rows either.
      if (!jobs.cancel(contentKey)) {
        json(res, 409, { error: 'That fetch has already finished or stopped.' })
        return
      }
      json(res, 200, { ok: true })
      return
    }

    if (route === 'GET /api/items/mine') {
      const mine = (await storage.list()).filter((item) => item.ownerDeviceId === callerDeviceId)
      json(res, 200, {
        items: mine.map((item) => ({
          infoHash: item.infoHash,
          contentKey: item.contentKey,
          title: item.title,
          sizeBytes: item.presentBytes,
          complete: item.complete,
          lastAccessAt: item.lastAccessAt,
          visibility: item.visibility === 'shared' ? 'shared' : 'private',
          // A COUNT, not the ids. The owner needs to know whether anyone
          // else can reach it; naming which devices would tell them about
          // households they are not part of.
          sharedWith: Math.max(0, (item.entitled ?? []).length - 1)
        }))
      })
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
            (job.state === 'queued' || job.state === 'fetching') && wanted.has(job.contentKey)
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
        // Why the app wants it, for the queue to show. Matched against the
        // two it may be rather than cast, so an unknown value is dropped
        // instead of being stored and rendered as a label nobody wrote.
        reason: body.reason === 'watching' || body.reason === 'prefetch' ? body.reason : undefined,
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
      const allItems = await storage.list()
      // What the CALLER holds, which is what a quota is measured against.
      // Charged the same way the eviction planner charges it — to the
      // fetcher, once — or the figure shown would not be the figure
      // enforced.
      const usedByMeBytes = allItems
        .filter((candidate) => candidate.ownerDeviceId === callerDeviceId)
        .reduce((sum, candidate) => sum + candidate.presentBytes, 0)
      const callerDevice = pairing
        .listDevices()
        .find((device) => deviceIdForToken(device.token) === callerDeviceId)

      // JOBS ARE SCOPED, and this is a deliberate departure from the plan,
      // which said jobs would gain an owner name.
      //
      // They already carried titles and went to every paired device, which
      // is the same read-side hole entitlement closed for the catalog —
      // just on the queue instead of the disk. Attaching names to that list
      // would have widened it from 'what does this household watch' to 'who
      // watches what'. So a device sees its own queue, and everyone else's
      // work appears as a count: enough to explain why the server is busy,
      // without saying what anyone is fetching.
      const allJobs = jobs.list()
      const mine = allJobs.filter((job) => job.ownerDeviceId === callerDeviceId)

      // WHO SEES WHOSE, and this is a deliberate change of position.
      //
      // Jobs were scoped to the caller with no exception for the admin, on
      // the grounds that admin is not a master key. That still holds for
      // items — nothing lists another device's files. But a cache list that
      // cannot say who wants a title cannot answer the first question an
      // administrator has about their own disk: whose is this, and why.
      //
      // So the ADMIN sees the whole queue with owner names; every other
      // device still sees only its own. The narrow reading: on a server you
      // administer, the queue is operational information about your
      // hardware. It is still a real disclosure, and it is confined to the
      // one person who already decides who may join at all.
      const deviceNames = new Map(
        pairing.listDevices().map((device) => [deviceIdForToken(device.token), device.deviceName])
      )
      const visibleJobs = isAdminCaller ? allJobs : mine
      json(res, 200, {
        serverName,
        version,
        usedBytes: await storage.usedBytes(),
        budgetBytes: deps.diskBudgetBytes,
        itemCount: allItems.length,
        usedByMeBytes,
        // The allocation this device is actually held to. null means none
        // is set and the whole-disk budget is the only bound.
        quotaBytes: callerDevice?.quotaBytes ?? effectiveDefaultQuota(),
        isAdmin: admin.isAdmin(callerDeviceId),
        unclaimed: admin.isUnclaimed(),
        jobs: visibleJobs.map((job) => summarizeJob(job, deviceNames.get(job.ownerDeviceId ?? ''))),
        // What is on this server that the caller is NOT being shown. For a
        // member that is everyone else's work — enough to explain why the
        // box is busy without saying what it is busy with. For the admin,
        // who now sees the queue in full, nothing is withheld, so it is 0
        // rather than a number that double-counts what is already listed.
        othersJobCount: allJobs.length - visibleJobs.length,
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

    // Sharing: the owner decides who else may see and stream what they
    // fetched. Admin is allowed too, because the admin can already delete
    // it — but note what admin does NOT get: this route changes access, it
    // does not grant it. An admin cannot add themselves.
    // Delete a cached item. Owner or admin, matching the sharing route
    // above and for the same stated reason: the admin can already remove the
    // file from a shell, so refusing here would imply a boundary that does
    // not exist. What the admin still cannot do is FIND somebody else's
    // items — there is no route that lists them — so this is reclaiming
    // space you can already point at, not a licence to browse.
    const removeMatch = /^\/api\/items\/([a-f0-9]{40})\/remove$/.exec(url.pathname)
    if (removeMatch && req.method === 'POST') {
      const item = await storage.get(removeMatch[1])
      const mayRemove = Boolean(item) && (item?.ownerDeviceId === callerDeviceId || isAdminCaller)
      if (!item || !mayRemove) {
        json(res, 404, { error: 'No such item.' })
        return
      }
      // The FETCH GOES FIRST, and it has to. An incomplete item is listed
      // and removable, and its job may still be downloading into the very
      // directory about to be deleted: on Unix the write continues into an
      // unlinked file and the job is re-queued when its final stat fails,
      // and on Windows the recursive delete fails outright against the open
      // handle. Either way the title comes back. Cancelling first stops the
      // fetch loop between chunks, which is where it already checks.
      jobs.cancel(item.contentKey)
      await storage.remove(item.infoHash)
      // No tombstone. A deliberate delete is not the feeder being told the
      // household lost interest — if it is still on somebody's list it
      // should be allowed to come back.
      json(res, 200, { ok: true })
      return
    }

    const sharingMatch = /^\/api\/items\/([a-f0-9]{40})\/sharing$/.exec(url.pathname)
    if (sharingMatch && req.method === 'POST') {
      const item = await storage.get(sharingMatch[1])
      const mayChange = Boolean(item) && (item?.ownerDeviceId === callerDeviceId || isAdminCaller)
      // Same shape as the stream route: somebody who may not touch this
      // item learns nothing about whether it is here.
      if (!item || !mayChange) {
        json(res, 404, { error: 'No such item.' })
        return
      }
      const body = await readBody(req)
      const visibility = body.visibility === 'shared' ? 'shared' : 'private'
      const entitled = Array.isArray(body.entitled)
        ? body.entitled.map((id) => String(id)).filter((id) => /^[a-f0-9]{16}$/.test(id))
        : (item.entitled ?? [])
      await storage.setSharing(item.infoHash, visibility, entitled)
      const updated = await storage.get(item.infoHash)
      json(res, 200, {
        visibility: updated?.visibility ?? visibility,
        entitled: updated?.entitled ?? []
      })
      return
    }

    json(res, 404, { error: 'Unknown route.' })
  }
}

/**
 * A contentKey is catalogId:season:episode, and the title on a job is the
 * SERIES title — so a queue holding four episodes of two shows listed "Star
 * Trek: Strange New Worlds" twice and "Outer Banks" twice with nothing to
 * tell the rows apart. They were never duplicates; they were different
 * episodes, described identically.
 *
 * Parsed from the END, the same way fetcher.ts does it, because a catalogId
 * can itself contain colons.
 */
function episodeOf(contentKey: string): { season?: number; episode?: number } {
  const parts = contentKey.split(':')
  if (parts.length < 3) return {}
  // EMPTINESS IS CHECKED BEFORE CONVERSION, because Number('') is 0 and
  // Number.isFinite(0) is true. A film's key is `id::` — both segments
  // empty — so converting first labelled every movie in the queue S00E00.
  const rawSeason = (parts.at(-2) ?? '').trim()
  const rawEpisode = (parts.at(-1) ?? '').trim()
  if (rawEpisode === '') return {}
  const episode = Number(rawEpisode)
  if (!Number.isInteger(episode) || episode < 0) return {}
  // Anime is often numbered straight through with no season at all, so
  // `id::7` is a real key and not a malformed one. It gets the episode
  // alone rather than an invented season 0.
  if (rawSeason === '') return { episode }
  const season = Number(rawSeason)
  if (!Number.isInteger(season) || season < 0) return { episode }
  return { season, episode }
}

function summarizeJob(job: JobRecord, ownerName?: string): Record<string, unknown> {
  return {
    contentKey: job.contentKey,
    reason: job.reason,
    ownerName,
    title: job.title,
    state: job.state,
    attempts: job.attempts,
    progressBytes: job.progressBytes ?? 0,
    sizeBytes: job.sizeBytes,
    resolution: job.resolution,
    ...episodeOf(job.contentKey),
    lastError: job.lastError
  }
}
