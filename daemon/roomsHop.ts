// The rooms hop: one relay connection per room per NETWORK.
//
// Every device in a household that sits in the same rooms would
// otherwise hold its own WebSocket to the Cloudflare relay — N devices,
// N connections, N wake-ups of the same Durable Object saying the same
// things. When a cache server is on the LAN, devices subscribe to their
// rooms THROUGH it instead: the daemon holds a single upstream relay
// connection per room for as long as anyone local is subscribed, fans
// incoming traffic out to the local subscribers, and forwards their
// sends up. That is the whole feature — the "single check-in per room"
// the household's network makes.
//
// WHAT THIS BOX CAN AND CANNOT SEE, stated plainly because it matters:
// room traffic is encrypted end-to-end with a secret that NEVER reaches
// this daemon — everything relayed here is ciphertext, exactly as it is
// at Cloudflare. What the daemon does hold is the relay-level admission
// ticket (joinSecret) its subscribers pass it, its own householdKey
// identity per room, and each subscriber's declared identity HASH — the
// public form of a member identity, never the key. docs/ROOMS.md names
// those trades.
//
// LOCAL ECHO is the subtle obligation. The relay fans a message to every
// connection EXCEPT its sender — and a household shares one connection,
// so a message from the living room would never reach the bedroom if
// this daemon did not deliver it locally itself. It does, synthesizing
// the same {type:'relay'} envelope the relay would have sent, so clients
// parse hop traffic and direct traffic identically.
//
// KICKS MUST REACH THROUGH THE HOP, and this is the part review caught
// being wrong: the relay bans a kicked member's PERSONAL key, but the
// shared upstream is authenticated as the household — the ban cannot
// close the kicked member's transport, and a daemon that kept fanning
// would deliver them the admin's old-secret re-key, undoing the removal
// entirely. So the relay broadcasts each kick's banned hashes to the
// room, and this daemon acts on them: subscribers whose declared hash is
// banned are dropped BEFORE the re-key can pass through (ordering is
// safe — the re-key only leaves the admin after the kick call returns,
// so the banned envelope always precedes it on the upstream socket), and
// re-subscriptions under a banned hash are refused for as long as this
// daemon runs. Re-keys are additionally sent transient — never retained
// — so a later subscriber can never be replayed one.
//
// One honest gap: a device subscribing to an upstream that is ALREADY
// established missed the relay's retained-state replay (that happens
// once, at upstream connect). Local members' last messages are retained
// and replayed here with the same ageMs semantics; remote members simply
// re-announce within their interval. A joiner sees the household at
// once and the rest of the room within ~20 seconds.

import crypto from 'node:crypto'
import fs from 'node:fs'
import type http from 'node:http'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'

const ROOM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MEMBER_HASH_RE = /^[0-9a-f]{64}$/
/** Same ceiling the relay and the app enforce. */
const MAX_MESSAGE_BYTES = 64 * 1024
/** Replaying a locally-retained message older than this is worse than
 *  replaying nothing — same reasoning, same figure as the relay. */
const RETENTION_MAX_AGE_MS = 10 * 60 * 1000
const UPSTREAM_CONNECT_TIMEOUT_MS = 8000

/** The relay closes a socket that exceeds 40 messages per 10 seconds —
 *  a fair bound for one device, but the household's whole traffic rides
 *  ONE socket here, and a burst of devices reconnecting together could
 *  trip it and take the room down for everyone. So sends are paced just
 *  under the relay's ceiling and the excess QUEUES rather than drops:
 *  an announcement delayed a few seconds repeats anyway; a household
 *  socket closed by the relay is an outage. */
const DEFAULT_RATE_WINDOW_MS = 10_000
const DEFAULT_MAX_SENDS_PER_WINDOW = 36
const SEND_QUEUE_LIMIT = 64

interface HopDeps {
  isAuthorized(token: string | undefined): boolean
  dataDir: string
  log(message: string): void
  /** Test hooks — production always uses the defaults above. */
  rateWindowMs?: number
  maxSendsPerWindow?: number
}

interface LocalSub {
  ws: WebSocket
  /** Stable per-connection tag for the synthesized relay envelopes. */
  id: string
  rooms: Set<string>
  /** The member identity HASH this subscriber declared per room — what
   *  a relay ban names, and therefore what lets this daemon honour one
   *  locally. The raw key never comes anywhere near this box. */
  declaredHash: Map<string, string>
}

interface Upstream {
  key: string
  roomId: string
  relayUrl: string
  ws: WebSocket | null
  /** The socket mid-handshake, tracked from the moment it exists so a
   *  shutdown can terminate it — waiting for `open` to learn about it
   *  left a closing daemon with an orphan relay connection. */
  pendingWs: WebSocket | null
  connecting: Promise<void> | null
  subscribers: Set<LocalSub>
  /** Last ciphertext each local subscriber sent, for replaying to the
   *  next local joiner — the daemon-side mirror of the relay's own
   *  retention, and just as unreadable to it. */
  retained: Map<string, { body: string; at: number }>
  /** Send pacing — see DEFAULT_MAX_SENDS_PER_WINDOW. */
  rateWindowStartedAt: number
  rateCount: number
  sendQueue: string[]
  flushTimer: ReturnType<typeof setTimeout> | null
}

export interface RoomsHop {
  /** Wire this to the http server's 'upgrade' event. Returns true when
   *  the request was for the hop (handled or refused). */
  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): boolean
  stop(): void
  /** For tests and /api/status: how many upstream relay connections are
   *  open right now. The whole point is that this number is per-room,
   *  not per-device. */
  upstreamCount(): number
}

export function createRoomsHop(deps: HopDeps): RoomsHop {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES + 4096 })
  const upstreams = new Map<string, Upstream>()
  /** Hashes the relay has announced as banned, per room — outlives the
   *  upstream that heard them, so a kicked member cannot shed the ban by
   *  letting the household connection lapse and re-subscribing. Session
   *  scope: after a daemon restart the relay's own admission gate is
   *  what stops them reconnecting DIRECTLY, and a re-subscription here
   *  only ever hears post-rotation ciphertext they cannot read. */
  const bannedByRoom = new Map<string, Set<string>>()
  const rateWindowMs = deps.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS
  const maxSendsPerWindow = deps.maxSendsPerWindow ?? DEFAULT_MAX_SENDS_PER_WINDOW
  const keysPath = path.join(deps.dataDir, 'rooms-hop.json')
  let stopped = false

  /**
   * This daemon's own relay identity for one room ON ONE RELAY — the
   * householdKey.
   *
   * Persisted, and that persistence is load-bearing: once the relay has
   * seen this key join with a valid joinSecret it is KNOWN, and known
   * keys survive joinSecret rotations. A fresh random key per boot would
   * mean every kick anywhere in the room locks the whole household out
   * until somebody hands the daemon a new invite.
   *
   * KEYED BY RELAY ORIGIN AND ROOM, never by room alone — review caught
   * the harvest this closes: the relayUrl in a subscription is
   * caller-chosen, so a malicious approved device could name the real
   * roomId with its own https server and read the bearer key this
   * daemon would otherwise have presented to the genuine relay, then
   * use it there itself (a known key reconnects without the current
   * joinSecret). Per-origin keys make that harvest worthless: the key
   * an attacker's server sees is a fresh one that has never been — and
   * will never be — presented anywhere else.
   */
  function householdKey(relayUrl: string, roomId: string): string {
    const scope = `${relayUrl}|${roomId}`
    let stored: Record<string, string> = {}
    try {
      stored = JSON.parse(fs.readFileSync(keysPath, 'utf8')) as Record<string, string>
    } catch {
      // first use
    }
    const existing = stored[scope]
    if (existing) return existing
    const fresh = `hh-${crypto.randomBytes(21).toString('base64url')}`
    stored[scope] = fresh
    try {
      fs.writeFileSync(keysPath, JSON.stringify(stored))
    } catch (error) {
      deps.log(`rooms-hop: could not persist household key: ${(error as Error).message}`)
    }
    return fresh
  }

  function sendTo(sub: LocalSub, payload: Record<string, unknown>): void {
    try {
      sub.ws.send(JSON.stringify(payload))
    } catch {
      // the socket's own close event cleans up
    }
  }

  function upstreamFor(relayUrl: string, roomId: string): Upstream {
    const key = `${relayUrl}|${roomId}`
    let upstream = upstreams.get(key)
    if (!upstream) {
      upstream = {
        key,
        roomId,
        relayUrl,
        ws: null,
        pendingWs: null,
        connecting: null,
        subscribers: new Set(),
        retained: new Map(),
        rateWindowStartedAt: 0,
        rateCount: 0,
        sendQueue: [],
        flushTimer: null
      }
      upstreams.set(key, upstream)
    }
    return upstream
  }

  /** The relay named these hashes banned. Honour it locally: the ban
   *  cannot close a kicked member's transport here (the shared upstream
   *  is the household's, not theirs), so this daemon is the enforcement
   *  point — drop them now, before anything else fans to them, and
   *  refuse their hash for as long as this process runs. */
  function applyBans(upstream: Upstream, hashes: string[]): void {
    const banned = bannedByRoom.get(upstream.key) ?? new Set<string>()
    for (const hash of hashes) {
      if (MEMBER_HASH_RE.test(hash)) banned.add(hash)
    }
    bannedByRoom.set(upstream.key, banned)
    for (const sub of [...upstream.subscribers]) {
      const declared = sub.declaredHash.get(upstream.key)
      if (declared && banned.has(declared)) {
        sendTo(sub, { type: 'room-kicked', roomId: upstream.roomId })
        dropSubscriber(upstream, sub)
      }
    }
  }

  function connectUpstream(upstream: Upstream, joinSecret: string | undefined): Promise<void> {
    if (upstream.ws && upstream.ws.readyState === WebSocket.OPEN) return Promise.resolve()
    if (upstream.connecting) return upstream.connecting
    upstream.connecting = new Promise<void>((resolve, reject) => {
      const params = new URLSearchParams({
        member: householdKey(upstream.relayUrl, upstream.roomId)
      })
      if (joinSecret) params.set('join', joinSecret)
      const ws = new WebSocket(
        `${upstream.relayUrl.replace(/^http/, 'ws')}/party/${upstream.roomId}?${params}`,
        { maxPayload: MAX_MESSAGE_BYTES + 4096 }
      )
      upstream.pendingWs = ws
      const timer = setTimeout(() => {
        ws.terminate()
        reject(new Error('relay connection timed out'))
      }, UPSTREAM_CONNECT_TIMEOUT_MS)
      ws.once('open', () => {
        clearTimeout(timer)
        upstream.pendingWs = null
        // The world may have moved on during the handshake: the daemon
        // stopping, or every subscriber leaving (which removed this
        // upstream from the map). An orphan socket that opens anyway
        // must close, not lurk past a shutdown or a self-update.
        if (stopped || upstreams.get(upstream.key) !== upstream) {
          try {
            ws.close()
          } catch {
            // already gone
          }
          reject(new Error('superseded during connect'))
          return
        }
        upstream.ws = ws
        resolve()
      })
      ws.once('error', (error) => {
        clearTimeout(timer)
        upstream.pendingWs = null
        reject(error)
      })
      ws.on('message', (raw) => {
        const text = String(raw)
        // The one envelope this daemon READS rather than forwards
        // blindly: the relay announcing a kick's banned hashes. Handled
        // before the fan-out so the kicked subscriber is gone before
        // anything else (the admin's re-key follows this on the same
        // socket) can reach them.
        try {
          const envelope = JSON.parse(text) as { type?: string; hashes?: unknown }
          if (envelope.type === 'banned' && Array.isArray(envelope.hashes)) {
            applyBans(
              upstream,
              envelope.hashes.filter((h): h is string => typeof h === 'string')
            )
          }
        } catch {
          // not JSON — forward as-is
        }
        // Otherwise verbatim to every subscriber: the relay's own
        // envelopes carry everything a client already knows how to
        // read, and re-writing them here would be a second protocol to
        // keep honest.
        for (const sub of upstream.subscribers) {
          sendTo(sub, { type: 'msg', roomId: upstream.roomId, raw: text })
        }
      })
      ws.on('close', () => {
        // A stale close (this upstream was already replaced by a newer
        // one under the same key) must not tear the replacement down.
        if (upstream.ws === ws) upstream.ws = null
        if (upstreams.get(upstream.key) !== upstream) return
        // The clients own reconnection, not this daemon: each is told the
        // room went down and re-subscribes on its usual backoff, and the
        // first to return recreates the upstream. A daemon-side retry
        // loop would fight theirs and hide outages from them.
        for (const sub of upstream.subscribers) {
          sendTo(sub, { type: 'room-down', roomId: upstream.roomId })
          sub.rooms.delete(upstream.key)
          sub.declaredHash.delete(upstream.key)
        }
        upstream.subscribers.clear()
        teardownUpstream(upstream)
      })
    }).finally(() => {
      upstream.connecting = null
    })
    return upstream.connecting
  }

  function teardownUpstream(upstream: Upstream): void {
    if (upstream.flushTimer) clearTimeout(upstream.flushTimer)
    upstream.flushTimer = null
    upstream.sendQueue = []
    upstreams.delete(upstream.key)
    try {
      upstream.ws?.close()
    } catch {
      // already gone
    }
    try {
      upstream.pendingWs?.terminate()
    } catch {
      // already gone
    }
  }

  function dropSubscriber(upstream: Upstream, sub: LocalSub): void {
    upstream.subscribers.delete(sub)
    upstream.retained.delete(sub.id)
    sub.rooms.delete(upstream.key)
    sub.declaredHash.delete(upstream.key)
    // Last one out closes the upstream — holding a relay connection open
    // for a room nobody local is in would be the daemon costing what it
    // exists to save.
    if (upstream.subscribers.size === 0) teardownUpstream(upstream)
  }

  /** Pushes one body upstream within the relay's rate ceiling, queueing
   *  the excess. FIFO — announcements delayed beats announcements
   *  reordered. */
  function sendUpstream(upstream: Upstream, body: string): void {
    upstream.sendQueue.push(body)
    if (upstream.sendQueue.length > SEND_QUEUE_LIMIT) {
      // Oldest out: everything on this channel is periodic state that
      // repeats; the newest copy is the one worth keeping.
      upstream.sendQueue.shift()
    }
    flushSendQueue(upstream)
  }

  function flushSendQueue(upstream: Upstream): void {
    const now = Date.now()
    if (now - upstream.rateWindowStartedAt >= rateWindowMs) {
      upstream.rateWindowStartedAt = now
      upstream.rateCount = 0
    }
    while (upstream.sendQueue.length && upstream.rateCount < maxSendsPerWindow) {
      const body = upstream.sendQueue.shift()!
      upstream.rateCount += 1
      try {
        upstream.ws?.send(body)
      } catch {
        // upstream close handling notifies everyone
      }
    }
    if (upstream.sendQueue.length && !upstream.flushTimer) {
      const waitMs = Math.max(50, upstream.rateWindowStartedAt + rateWindowMs - now)
      upstream.flushTimer = setTimeout(() => {
        upstream.flushTimer = null
        if (upstreams.get(upstream.key) === upstream) flushSendQueue(upstream)
      }, waitMs)
    }
  }

  async function handleSub(
    sub: LocalSub,
    msg: { roomId?: unknown; relayUrl?: unknown; join?: unknown; memberKeyHash?: unknown }
  ): Promise<void> {
    const roomId = String(msg.roomId || '')
    const relayUrl = String(msg.relayUrl || '').replace(/\/+$/, '')
    if (!ROOM_ID_RE.test(roomId)) {
      sendTo(sub, { type: 'sub-error', roomId, error: 'Invalid room id.' })
      return
    }
    let parsed: URL
    try {
      parsed = new URL(relayUrl)
    } catch {
      sendTo(sub, { type: 'sub-error', roomId, error: 'Invalid relay URL.' })
      return
    }
    // https only, with one carve-out: a loopback relay for the test
    // harness and local wrangler dev. Loopback cannot leave the box, so
    // the rule the https requirement enforces — room traffic never
    // crosses a network in the clear — still holds.
    const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
      sendTo(sub, { type: 'sub-error', roomId, error: 'Relays are https only.' })
      return
    }
    const declaredHash =
      typeof msg.memberKeyHash === 'string' && MEMBER_HASH_RE.test(msg.memberKeyHash)
        ? msg.memberKeyHash
        : null
    const key = `${relayUrl}|${roomId}`
    if (declaredHash && bannedByRoom.get(key)?.has(declaredHash)) {
      // The relay named this identity banned while this daemon was
      // watching. Refusing here is what makes a kick stick for hop
      // members whose transport the relay itself cannot reach.
      sendTo(sub, { type: 'sub-error', roomId, error: 'Removed from this room.' })
      return
    }
    const upstream = upstreamFor(relayUrl, roomId)
    try {
      await connectUpstream(upstream, typeof msg.join === 'string' ? msg.join : undefined)
    } catch (error) {
      if (upstream.subscribers.size === 0) teardownUpstream(upstream)
      sendTo(sub, { type: 'sub-error', roomId, error: (error as Error).message })
      return
    }
    // The handshake took real time, and the subscriber may have hung up
    // during it. Registering a closed socket would anchor the upstream
    // to a ghost no close event will ever clean up again.
    if (sub.ws.readyState !== WebSocket.OPEN) {
      if (upstream.subscribers.size === 0) teardownUpstream(upstream)
      return
    }
    upstream.subscribers.add(sub)
    sub.rooms.add(upstream.key)
    if (declaredHash) sub.declaredHash.set(upstream.key, declaredHash)
    sendTo(sub, { type: 'sub-ok', roomId })
    // The household's recent words, replayed the way the relay replays
    // its own retention — stamped with how long the daemon has held
    // them, so a stale position is never applied as if it were current.
    const now = Date.now()
    for (const [localId, entry] of upstream.retained) {
      if (localId === sub.id) continue
      const ageMs = now - entry.at
      if (ageMs > RETENTION_MAX_AGE_MS) continue
      sendTo(sub, {
        type: 'msg',
        roomId,
        raw: JSON.stringify({
          type: 'retained',
          ageMs,
          connId: `lan-${localId}`,
          isHost: false,
          body: entry.body
        })
      })
    }
  }

  function handleSend(
    sub: LocalSub,
    msg: { roomId?: unknown; body?: unknown; transient?: unknown }
  ): void {
    const roomId = String(msg.roomId || '')
    const body = typeof msg.body === 'string' ? msg.body : ''
    if (!body || Buffer.byteLength(body) > MAX_MESSAGE_BYTES) return
    for (const key of sub.rooms) {
      const upstream = upstreams.get(key)
      if (!upstream || upstream.roomId !== roomId) continue
      sendUpstream(upstream, body)
      // Transient sends are never retained. The flag exists for
      // re-keys: retained, one would be replayed to the NEXT local
      // subscriber — and the next subscriber is exactly who a re-key
      // must never reach by default. The daemon cannot read the
      // message; the sender says which kind it is.
      if (msg.transient !== true) {
        upstream.retained.set(sub.id, { body, at: Date.now() })
      }
      // THE LOCAL ECHO. The relay fans to every connection but the
      // sender — and the household is one connection, so siblings only
      // hear each other if this daemon says it. Same envelope shape the
      // relay uses, so clients cannot tell the difference.
      const envelope = JSON.stringify({
        type: 'relay',
        connId: `lan-${sub.id}`,
        isHost: false,
        body
      })
      for (const other of upstream.subscribers) {
        if (other === sub) continue
        sendTo(other, { type: 'msg', roomId, raw: envelope })
      }
      return
    }
  }

  wss.on('connection', (ws) => {
    const sub: LocalSub = {
      ws,
      id: crypto.randomBytes(8).toString('hex'),
      rooms: new Set(),
      declaredHash: new Map()
    }
    ws.on('message', (raw) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(String(raw)) as Record<string, unknown>
      } catch {
        return
      }
      if (msg.type === 'sub') void handleSub(sub, msg)
      else if (msg.type === 'send') handleSend(sub, msg)
      else if (msg.type === 'unsub') {
        const upstream = [...sub.rooms]
          .map((key) => upstreams.get(key))
          .find((entry) => entry && entry.roomId === String(msg.roomId || ''))
        if (upstream) dropSubscriber(upstream, sub)
      }
    })
    const cleanup = (): void => {
      for (const key of [...sub.rooms]) {
        const upstream = upstreams.get(key)
        if (upstream) dropSubscriber(upstream, sub)
      }
    }
    ws.on('close', cleanup)
    ws.on('error', cleanup)
  })

  return {
    handleUpgrade(req, socket, head) {
      const url = new URL(req.url ?? '/', 'http://daemon.invalid')
      if (url.pathname !== '/api/rooms/hop') return false
      // The same gate as every authenticated route: paired AND approved.
      // Query-param token for the same reason /stream uses one — an
      // upgrade request is awkward about headers in some clients, and
      // the existing precedent is the query.
      const token = url.searchParams.get('token') ?? undefined
      if (!deps.isAuthorized(token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return true
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req)
      })
      return true
    },
    stop() {
      stopped = true
      for (const upstream of [...upstreams.values()]) teardownUpstream(upstream)
      upstreams.clear()
      for (const client of wss.clients) {
        try {
          client.close()
        } catch {
          // shutting down
        }
      }
      wss.close()
    },
    upstreamCount() {
      return [...upstreams.values()].filter(
        (upstream) => upstream.ws && upstream.ws.readyState === WebSocket.OPEN
      ).length
    }
  }
}
