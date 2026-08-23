// The Durable Object backing one room — used both by an ephemeral watch
// party and by a long-lived friends group.
//
// Still a dumb relay: it never decrypts anything. Every app-level message
// is AES-256-GCM-encrypted client-side with a secret embedded in the code,
// which this server never sees. It tags each incoming raw message with the
// sender's connId and isHost flag, wraps it in a
// `{type:'relay', connId, isHost, body}` envelope, and forwards that to
// every OTHER connection. That envelope shape, and the separate
// unencrypted `{type:'assigned', connId}` sent once on connect, must stay
// byte-for-byte what src/main/media-hub/watchParty.ts already expects.
//
// Two things changed here, and they are deliberately paired because both
// hang off the connection lifecycle:
//
// 1. HIBERNATION. This used to hold every WebSocket in memory via
//    `server.accept()` plus addEventListener, which keeps the object
//    resident — and therefore billing for duration — for as long as
//    anyone is connected. A friends group is meant to be connected
//    permanently, so that is the difference between "cheap" and "always
//    on the meter". Using state.acceptWebSocket() plus the
//    webSocketMessage/webSocketClose handlers lets the runtime evict this
//    object from memory while sockets stay open, and wake it on the next
//    message.
//
// 2. RETENTION. The object now keeps each connection's LAST message and
//    replays it to anyone who connects afterwards. It still cannot read
//    any of it — the retained value is the same opaque ciphertext it
//    forwards — but retaining it removes the need for every member to
//    re-announce on a timer just so newcomers can discover them. A
//    joiner learns the room's current state in one round trip instead of
//    waiting out everyone else's announce interval.
//
//    Retained state lives in the socket's own ATTACHMENT rather than
//    Durable Object storage: attachments survive hibernation, cost
//    nothing per write (storage writes are billed), and are discarded
//    automatically when the socket closes, so a disconnect cleans itself
//    up with no bookkeeping.
//
//    Because it cannot read the payload, the object cannot know how old
//    the retained value is in the sender's terms — so it stamps its own
//    receive time and replays `{type:'retained', ageMs, connId, isHost,
//    body}`. A client extrapolating a position from a replayed message
//    must subtract ageMs; without it a stale position would be applied as
//    if it were current.

export interface Env {
  ROOMS: DurableObjectNamespace
  INVITE_KEY: string
}

/** What each socket carries with it across hibernation. */
interface SocketAttachment {
  connId: string
  isHost: boolean
  /** Last raw (still encrypted) message this connection sent. */
  last?: string
  /** When that message arrived, by this object's clock. */
  lastAt?: number
}

// A room with no connections at all is reclaimed after this long. Only
// reached once everybody has actually disconnected — the alarm is pushed
// back on every connect and every message, so an active friends group
// never expires just because it has been alive a long time. Before this,
// a flat 24h from creation killed long-lived groups outright.
const ROOM_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Replaying a message older than this is worse than replaying nothing:
 *  it describes a member who has very likely moved on or stopped
 *  watching, and a client would have to discard it anyway. */
const RETENTION_MAX_AGE_MS = 10 * 60 * 1000

// The Electron clients cap their raw WebSocket payloads at 64 KiB. The relay
// adds its own JSON envelope around every payload, so leave headroom for that
// wrapper and enforce the same boundary before retaining or broadcasting it.
export const MAX_RELAY_MESSAGE_BYTES = 60 * 1024
// A Watch Party is intentionally a small room. This bounds retained state and
// the O(connections) fan-out work a member can trigger with one message.
export const MAX_ROOM_CONNECTIONS = 32

export function isRelayMessageWithinLimit(message: string): boolean {
  return new TextEncoder().encode(message).byteLength <= MAX_RELAY_MESSAGE_BYTES
}

export class PartyRoom {
  private readonly state: DurableObjectState
  private roomToken: string | null = null

  constructor(state: DurableObjectState) {
    this.state = state
  }

  private attachmentOf(ws: WebSocket): SocketAttachment | null {
    try {
      return (ws.deserializeAttachment() as SocketAttachment) ?? null
    } catch {
      return null
    }
  }

  /** Pushes the reclaim deadline out. Called on anything that proves the
   *  room is still in use. */
  private async touch(): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + ROOM_IDLE_TTL_MS)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'POST' && url.pathname === '/init') {
      const body = (await request.json()) as { roomToken?: string }
      if (!body.roomToken) return new Response('Missing roomToken.', { status: 400 })
      this.roomToken = body.roomToken
      await this.state.storage.put('roomToken', body.roomToken)
      await this.touch()
      return new Response('ok')
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      if (this.roomToken === null) {
        this.roomToken = (await this.state.storage.get<string>('roomToken')) ?? null
      }
      // Unknown room (never /host'd, or already reclaimed) — refuse rather
      // than silently accepting a connection nobody else will ever join.
      if (this.roomToken === null) return new Response('Unknown party.', { status: 404 })
      if (this.state.getWebSockets().length >= MAX_ROOM_CONNECTIONS) {
        return new Response('Party is full.', { status: 429 })
      }

      const token = url.searchParams.get('token')
      const isHost = token !== null && token === this.roomToken

      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket]

      // Hibernatable: the runtime owns this socket and will wake us on
      // message/close, instead of us holding it in memory.
      this.state.acceptWebSocket(server)

      // Short, opaque, and distinct from a real UUID on purpose — purely a
      // per-connection tag the client uses to tell "who sent this" apart,
      // never parsed as anything structured.
      const connId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      server.serializeAttachment({ connId, isHost } satisfies SocketAttachment)
      server.send(JSON.stringify({ type: 'assigned', connId }))

      // Replay what everyone else last said, so a joiner knows the room's
      // state immediately rather than waiting for the next announcement.
      // Opaque to us; `ageMs` is what makes it safely interpretable.
      const now = Date.now()
      for (const other of this.state.getWebSockets()) {
        if (other === server) continue
        const attachment = this.attachmentOf(other)
        if (!attachment?.last || !attachment.lastAt) continue
        const ageMs = now - attachment.lastAt
        if (ageMs > RETENTION_MAX_AGE_MS) continue
        try {
          server.send(
            JSON.stringify({
              type: 'retained',
              ageMs,
              connId: attachment.connId,
              isHost: attachment.isHost,
              body: attachment.last
            })
          )
        } catch {
          // best-effort — a dead socket is cleaned up by its own close event
        }
      }

      await this.touch()
      return new Response(null, { status: 101, webSocket: client })
    }

    return new Response('Not found.', { status: 404 })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const body = typeof message === 'string' ? message : ''
    if (!body) return
    if (!isRelayMessageWithinLimit(body)) {
      ws.close(1009, 'Message exceeds the party size limit.')
      return
    }
    const attachment = this.attachmentOf(ws)
    if (!attachment) return

    // Retain this connection's latest message for future joiners. Still
    // never decrypted — we store exactly the bytes we forward.
    ws.serializeAttachment({
      ...attachment,
      last: body,
      lastAt: Date.now()
    } satisfies SocketAttachment)

    const envelope = JSON.stringify({
      type: 'relay',
      connId: attachment.connId,
      isHost: attachment.isHost,
      body
    })
    for (const other of this.state.getWebSockets()) {
      if (other === ws) continue
      try {
        other.send(envelope)
      } catch {
        // best-effort — a dead socket gets cleaned up by its own
        // close/error event, not by a send failure here.
      }
    }
    await this.touch()
  }

  async webSocketClose(): Promise<void> {
    // Nothing to unregister: the runtime drops the socket and its
    // attachment, which is exactly the retained state for that member.
    // If that was the last connection, the idle alarm eventually reclaims
    // the room.
  }

  async webSocketError(): Promise<void> {
    // Same as close — no bookkeeping of our own to undo.
  }

  /** Idle deadline reached with nobody connected: close out anything
   *  lingering and let this object's storage be reclaimed. */
  async alarm(): Promise<void> {
    const sockets = this.state.getWebSockets()
    if (sockets.length > 0) {
      // Still in use — someone reconnected between the alarm being set and
      // it firing. Push it out again rather than tearing down a live room.
      await this.touch()
      return
    }
    await this.state.storage.deleteAll()
  }
}
