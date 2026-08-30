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
// ticket (joinSecret) its subscribers pass it, and its own householdKey
// identity per room. docs/ROOMS.md names that trade: a household's own
// cache box holding the room's door key, never its contents.
//
// LOCAL ECHO is the subtle obligation. The relay fans a message to every
// connection EXCEPT its sender — and a household shares one connection,
// so a message from the living room would never reach the bedroom if
// this daemon did not deliver it locally itself. It does, synthesizing
// the same {type:'relay'} envelope the relay would have sent, so clients
// parse hop traffic and direct traffic identically.
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
/** Same ceiling the relay and the app enforce. */
const MAX_MESSAGE_BYTES = 64 * 1024
/** Replaying a locally-retained message older than this is worse than
 *  replaying nothing — same reasoning, same figure as the relay. */
const RETENTION_MAX_AGE_MS = 10 * 60 * 1000
const UPSTREAM_CONNECT_TIMEOUT_MS = 8000

interface HopDeps {
  isAuthorized(token: string | undefined): boolean
  dataDir: string
  log(message: string): void
}

interface LocalSub {
  ws: WebSocket
  /** Stable per-connection tag for the synthesized relay envelopes. */
  id: string
  rooms: Set<string>
}

interface Upstream {
  key: string
  roomId: string
  relayUrl: string
  ws: WebSocket | null
  connecting: Promise<void> | null
  subscribers: Set<LocalSub>
  /** Last ciphertext each local subscriber sent, for replaying to the
   *  next local joiner — the daemon-side mirror of the relay's own
   *  retention, and just as unreadable to it. */
  retained: Map<string, { body: string; at: number }>
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
  const keysPath = path.join(deps.dataDir, 'rooms-hop.json')

  /**
   * This daemon's own relay identity for one room — the householdKey.
   *
   * Persisted, and that persistence is load-bearing: once the relay has
   * seen this key join with a valid joinSecret it is KNOWN, and known
   * keys survive joinSecret rotations. A fresh random key per boot would
   * mean every kick anywhere in the room locks the whole household out
   * until somebody hands the daemon a new invite.
   */
  function householdKey(roomId: string): string {
    let stored: Record<string, string> = {}
    try {
      stored = JSON.parse(fs.readFileSync(keysPath, 'utf8')) as Record<string, string>
    } catch {
      // first use
    }
    const existing = stored[roomId]
    if (existing) return existing
    const fresh = `hh-${crypto.randomBytes(21).toString('base64url')}`
    stored[roomId] = fresh
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
        connecting: null,
        subscribers: new Set(),
        retained: new Map()
      }
      upstreams.set(key, upstream)
    }
    return upstream
  }

  function connectUpstream(upstream: Upstream, joinSecret: string | undefined): Promise<void> {
    if (upstream.ws && upstream.ws.readyState === WebSocket.OPEN) return Promise.resolve()
    if (upstream.connecting) return upstream.connecting
    upstream.connecting = new Promise<void>((resolve, reject) => {
      const params = new URLSearchParams({ member: householdKey(upstream.roomId) })
      if (joinSecret) params.set('join', joinSecret)
      const ws = new WebSocket(
        `${upstream.relayUrl.replace(/^http/, 'ws')}/party/${upstream.roomId}?${params}`,
        { maxPayload: MAX_MESSAGE_BYTES + 4096 }
      )
      const timer = setTimeout(() => {
        ws.terminate()
        reject(new Error('relay connection timed out'))
      }, UPSTREAM_CONNECT_TIMEOUT_MS)
      ws.once('open', () => {
        clearTimeout(timer)
        upstream.ws = ws
        resolve()
      })
      ws.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      ws.on('message', (raw) => {
        // Verbatim to every subscriber: the relay's own envelopes
        // (relay/retained/assigned) carry everything a client already
        // knows how to read, and re-writing them here would be a second
        // protocol to keep honest.
        const text = String(raw)
        for (const sub of upstream.subscribers) {
          sendTo(sub, { type: 'msg', roomId: upstream.roomId, raw: text })
        }
      })
      ws.on('close', () => {
        // The clients own reconnection, not this daemon: each is told the
        // room went down and re-subscribes on its usual backoff, and the
        // first to return recreates the upstream. A daemon-side retry
        // loop would fight theirs and hide outages from them.
        if (upstream.ws === ws) upstream.ws = null
        for (const sub of upstream.subscribers) {
          sendTo(sub, { type: 'room-down', roomId: upstream.roomId })
          sub.rooms.delete(upstream.key)
        }
        upstream.subscribers.clear()
        upstreams.delete(upstream.key)
      })
    }).finally(() => {
      upstream.connecting = null
    })
    return upstream.connecting
  }

  function dropSubscriber(upstream: Upstream, sub: LocalSub): void {
    upstream.subscribers.delete(sub)
    upstream.retained.delete(sub.id)
    sub.rooms.delete(upstream.key)
    // Last one out closes the upstream — holding a relay connection open
    // for a room nobody local is in would be the daemon costing what it
    // exists to save.
    if (upstream.subscribers.size === 0) {
      upstreams.delete(upstream.key)
      try {
        upstream.ws?.close()
      } catch {
        // already gone
      }
    }
  }

  async function handleSub(
    sub: LocalSub,
    msg: { roomId?: unknown; relayUrl?: unknown; join?: unknown }
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
    const upstream = upstreamFor(relayUrl, roomId)
    try {
      await connectUpstream(upstream, typeof msg.join === 'string' ? msg.join : undefined)
    } catch (error) {
      if (upstream.subscribers.size === 0) upstreams.delete(upstream.key)
      sendTo(sub, { type: 'sub-error', roomId, error: (error as Error).message })
      return
    }
    upstream.subscribers.add(sub)
    sub.rooms.add(upstream.key)
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

  function handleSend(sub: LocalSub, msg: { roomId?: unknown; body?: unknown }): void {
    const roomId = String(msg.roomId || '')
    const body = typeof msg.body === 'string' ? msg.body : ''
    if (!body || Buffer.byteLength(body) > MAX_MESSAGE_BYTES) return
    for (const key of sub.rooms) {
      const upstream = upstreams.get(key)
      if (!upstream || upstream.roomId !== roomId) continue
      try {
        upstream.ws?.send(body)
      } catch {
        // upstream close handling notifies everyone
      }
      upstream.retained.set(sub.id, { body, at: Date.now() })
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
      rooms: new Set()
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
      for (const upstream of upstreams.values()) {
        try {
          upstream.ws?.close()
        } catch {
          // shutting down
        }
      }
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
