// The Durable Object backing one Watch Party room. One instance per
// roomId (see index.ts's env.ROOMS.idFromName(roomId)) so every connection
// for the same room lands on the same in-memory object — that's what makes
// broadcasting between them possible at all.
//
// Deliberately a dumb relay: it never decrypts anything. Every app-level
// message (hello/welcome/leave/party-state/queue-sync/nowPlaying/etc.) is
// AES-256-GCM-encrypted client-side with a secret embedded in the party
// code, which this server never sees — it just tags each incoming raw
// message with the sender's connId and isHost flag, wraps it in a
// `{type:'relay', connId, isHost, body}` envelope, and forwards that
// envelope to every OTHER connection in the room. This exact envelope
// shape (and the separate, unencrypted `{type:'assigned', connId}` sent
// once right after a connection opens) is not something to change here —
// it must match what src/main/media-hub/watchParty.ts's client already
// expects byte-for-byte, since that code shipped first and isn't part of
// this deploy.

export interface Env {
  ROOMS: DurableObjectNamespace
  INVITE_KEY: string
}

interface Connection {
  ws: WebSocket
  connId: string
  isHost: boolean
}

// Only reachable while nobody has actually claimed the host slot yet
// (right after /host, before the host's own websocket connects) — a
// generous window since the host dials in immediately after hosting, but
// wide enough to tolerate a slow network hop.
const ROOM_TTL_MS = 24 * 60 * 60 * 1000

export class PartyRoom {
  private readonly state: DurableObjectState
  private roomToken: string | null = null
  private readonly connections = new Map<string, Connection>()

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'POST' && url.pathname === '/init') {
      const body = (await request.json()) as { roomToken?: string }
      if (!body.roomToken) return new Response('Missing roomToken.', { status: 400 })
      this.roomToken = body.roomToken
      await this.state.storage.put('roomToken', body.roomToken)
      await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS)
      return new Response('ok')
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      if (this.roomToken === null) {
        this.roomToken = (await this.state.storage.get<string>('roomToken')) ?? null
      }
      // Unknown room (never /host'd, or already expired) — refuse rather
      // than silently accepting a connection nobody else will ever join.
      if (this.roomToken === null) return new Response('Unknown party.', { status: 404 })

      const token = url.searchParams.get('token')
      const isHost = token !== null && token === this.roomToken

      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
      server.accept()

      // Short, opaque, and distinct from a real UUID on purpose — this is
      // purely a per-connection tag the client uses to tell "who sent
      // this" apart, never parsed as anything structured.
      const connId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      this.connections.set(connId, { ws: server, connId, isHost })
      server.send(JSON.stringify({ type: 'assigned', connId }))

      server.addEventListener('message', (event: MessageEvent) => {
        const body = typeof event.data === 'string' ? event.data : ''
        if (!body) return
        const envelope = JSON.stringify({ type: 'relay', connId, isHost, body })
        for (const [otherId, conn] of this.connections) {
          if (otherId === connId) continue
          try {
            conn.ws.send(envelope)
          } catch {
            // best-effort — a dead socket gets cleaned up by its own
            // close/error event, not by a send failure here.
          }
        }
      })

      const cleanup = (): void => {
        this.connections.delete(connId)
      }
      server.addEventListener('close', cleanup)
      server.addEventListener('error', cleanup)

      return new Response(null, { status: 101, webSocket: client })
    }

    return new Response('Not found.', { status: 404 })
  }

  /** Room TTL reached — close out any lingering connections with a real
   *  code instead of leaving clients to eventually notice a silent hang,
   *  then let the Durable Object's own storage (and, on its own schedule,
   *  the object itself) be reclaimed normally. */
  async alarm(): Promise<void> {
    for (const conn of this.connections.values()) {
      try {
        conn.ws.close(1000, 'Room expired')
      } catch {
        // best-effort
      }
    }
    this.connections.clear()
    await this.state.storage.deleteAll()
  }
}
