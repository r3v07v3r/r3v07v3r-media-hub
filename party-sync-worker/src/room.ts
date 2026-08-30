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
  /** The member identity this connection presented, for rooms with a
   *  membership layer. Absent on legacy rooms and parties. */
  memberKey?: string
  /** sha256 of that identity — what kicks name, so it is precomputed
   *  here rather than derived per kick. */
  memberKeyHash?: string
  /** Last raw (still encrypted) message this connection sent. */
  last?: string
  /** When that message arrived, by this object's clock. */
  lastAt?: number
  /** Start of the current per-connection relay-message window. */
  rateWindowStartedAt?: number
  /** Number of messages accepted in that window. */
  rateWindowMessageCount?: number
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
export const RELAY_RATE_WINDOW_MS = 10_000
export const MAX_RELAY_MESSAGES_PER_WINDOW = 40

export function isRelayMessageWithinLimit(message: string): boolean {
  return new TextEncoder().encode(message).byteLength <= MAX_RELAY_MESSAGE_BYTES
}

// --- membership -------------------------------------------------------------
//
// Rooms created with {membership: true} gain a relay-level admission
// layer: a joinSecret carried in the invite code, and a memberKey each
// install generates. These are RELAY credentials, not content — the
// object still never decrypts a byte. They exist so that removing a
// member can be real: a ban the relay does not enforce is theatre, and
// the client-side secret rotation alone cannot stop a kicked member
// reconnecting to sit in the room as an unreadable ghost.
//
// docs/ROOMS.md in the main app is the policy this implements; read it
// before changing the admission rules.

/** Bounds the identity sets a room accumulates in Durable Object
 *  storage. Known is a hard cap — a room with 256 distinct installs is
 *  not a household. Banned drops its OLDEST entries past the cap, which
 *  is safe: an evicted banned key becomes merely unknown, and unknown
 *  keys need the CURRENT joinSecret — which rotated at the moment that
 *  key was banned. */
export const MAX_KNOWN_MEMBERS = 256
export const MAX_BANNED_MEMBERS = 512

const MEMBER_KEY_RE = /^[a-zA-Z0-9_-]{8,64}$/
const MEMBER_KEY_HASH_RE = /^[0-9a-f]{64}$/

export function isValidMemberKey(key: unknown): key is string {
  return typeof key === 'string' && MEMBER_KEY_RE.test(key)
}

export function isValidMemberKeyHash(hash: unknown): hash is string {
  return typeof hash === 'string' && MEMBER_KEY_HASH_RE.test(hash)
}

/** sha256 hex of a memberKey — the only form of the key that ever
 *  travels anywhere but the key's own connection. Must stay in lockstep
 *  with the client's hashing (node:crypto sha256 hex of the utf8 key). */
export async function memberKeyHashOf(memberKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(memberKey))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export type AdmissionVerdict = 'admit' | 'admit-and-register' | 'refuse'

/**
 * Whether a WebSocket connect is let into the room.
 *
 * The order of these checks is the design, not an implementation detail:
 *
 *  - A legacy room (no joinSecret was ever minted) admits everyone, as
 *    it always has. Ephemeral watch parties and pre-kick rooms live
 *    here, and nothing about them changed.
 *  - A membership room refuses a connection with no identity at all.
 *  - BANNED WINS OVER EVERYTHING — including a banned key that somehow
 *    presents the current joinSecret (the admin's own re-key message
 *    could leak inside a household; the ban must hold anyway).
 *  - A KNOWN key is admitted even with a stale joinSecret: an offline
 *    member returning after a rotation must not be locked out of their
 *    own room. Rotation gates STRANGERS, not members.
 *  - A stranger with the current joinSecret is admitted and becomes
 *    known. A stranger without it is refused.
 *
 * BANS ARE ADDRESSED BY HASH, admission by the key itself. The raw
 * memberKey is a bearer credential — a known one reconnects without the
 * current joinSecret — so it is a secret between one install and this
 * object, and never travels anywhere else. What members see of each
 * other, and therefore what a kick can name, is the sha256 of the key:
 * enough to ban by, useless to connect with. Review found the earlier
 * version broadcasting raw keys in presence, which let a kicked member
 * who had cached a KEPT member's key walk straight back in as them.
 */
export function admissionVerdict(input: {
  currentJoinSecret: string | null
  memberKey: string | null
  /** sha256 of memberKey, computed by the caller (hashing is async in
   *  workers and this stays a pure function). */
  memberKeyHash: string | null
  presentedJoinSecret: string | null
  known: ReadonlySet<string>
  bannedHashes: ReadonlySet<string>
}): AdmissionVerdict {
  if (!input.currentJoinSecret) return 'admit'
  if (!input.memberKey || !isValidMemberKey(input.memberKey)) return 'refuse'
  if (input.memberKeyHash && input.bannedHashes.has(input.memberKeyHash)) return 'refuse'
  if (input.known.has(input.memberKey)) return 'admit'
  if (input.presentedJoinSecret && input.presentedJoinSecret === input.currentJoinSecret) {
    return input.known.size >= MAX_KNOWN_MEMBERS ? 'refuse' : 'admit-and-register'
  }
  return 'refuse'
}

export function nextRelayMessageRate(
  windowStartedAt: number | undefined,
  windowMessageCount: number | undefined,
  now: number
): { allowed: boolean; windowStartedAt: number; windowMessageCount: number } {
  const startsNewWindow =
    windowStartedAt === undefined ||
    now < windowStartedAt ||
    now - windowStartedAt >= RELAY_RATE_WINDOW_MS
  const nextCount = startsNewWindow ? 1 : (windowMessageCount ?? 0) + 1
  return {
    allowed: nextCount <= MAX_RELAY_MESSAGES_PER_WINDOW,
    windowStartedAt: startsNewWindow ? now : windowStartedAt,
    windowMessageCount: nextCount
  }
}

export class PartyRoom {
  private readonly state: DurableObjectState
  private roomToken: string | null = null
  /** null until loaded; '' means "loaded, and this is a legacy room". */
  private joinSecret: string | null = null
  private known: Set<string> | null = null
  private banned: Set<string> | null = null

  constructor(state: DurableObjectState) {
    this.state = state
  }

  /** Loads the membership layer once per in-memory lifetime. Storage is
   *  the truth — this object hibernates and forgets. */
  private async loadMembership(): Promise<void> {
    if (this.joinSecret === null) {
      this.joinSecret = (await this.state.storage.get<string>('joinSecret')) ?? ''
    }
    if (this.known === null) {
      this.known = new Set((await this.state.storage.get<string[]>('known')) ?? [])
    }
    if (this.banned === null) {
      this.banned = new Set((await this.state.storage.get<string[]>('banned')) ?? [])
    }
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
      const body = (await request.json()) as { roomToken?: string; membership?: boolean }
      if (!body.roomToken) return new Response('Missing roomToken.', { status: 400 })
      this.roomToken = body.roomToken
      await this.state.storage.put('roomToken', body.roomToken)
      let joinSecret: string | undefined
      if (body.membership === true) {
        // The admission ticket strangers must present. Travels to members
        // inside the invite code; this object only ever compares it.
        joinSecret = crypto.randomUUID()
        this.joinSecret = joinSecret
        await this.state.storage.put('joinSecret', joinSecret)
      }
      await this.touch()
      return new Response(JSON.stringify({ ok: true, joinSecret }), {
        headers: { 'content-type': 'application/json' }
      })
    }

    // Removing members — the admin's call, and the one place the relay
    // takes something away. Atomic on purpose: ban, disconnect and
    // rotation happen in one request, and the NEW joinSecret is only
    // ever in this response — which is what forces the client's re-key
    // broadcast to happen after the ban, not before. See docs/ROOMS.md.
    if (request.method === 'POST' && url.pathname === '/kick') {
      const body = (await request.json()) as { roomToken?: string; memberKeyHashes?: unknown }
      if (this.roomToken === null) {
        this.roomToken = (await this.state.storage.get<string>('roomToken')) ?? null
      }
      if (!this.roomToken || body.roomToken !== this.roomToken) {
        return new Response('Only the room admin can do that.', { status: 403 })
      }
      await this.loadMembership()
      if (!this.joinSecret) {
        return new Response('This room has no membership layer.', { status: 409 })
      }
      // Kicks name HASHES — members only ever see each other's hashes,
      // and the raw key stays a secret between its install and this
      // object. See admissionVerdict's header.
      const hashes = (Array.isArray(body.memberKeyHashes) ? body.memberKeyHashes : []).filter(
        isValidMemberKeyHash
      )
      if (!hashes.length) return new Response('No members named.', { status: 400 })
      const kicked = new Set(hashes)
      for (const hash of hashes) this.banned!.add(hash)
      // The known set stores raw keys; drop the ones whose hash was just
      // banned so they stop counting toward the registration cap.
      for (const key of [...this.known!]) {
        if (kicked.has(await memberKeyHashOf(key))) this.known!.delete(key)
      }
      // Oldest banned entries fall off past the cap — safe, because an
      // evicted hash's key becomes merely unknown, and unknown needs the
      // CURRENT joinSecret, which is about to rotate.
      const bannedList = [...this.banned!].slice(-MAX_BANNED_MEMBERS)
      this.banned = new Set(bannedList)
      const joinSecret = crypto.randomUUID()
      this.joinSecret = joinSecret
      // One atomic write for all three, not three writes: a crash between
      // them would strand storage with the rotated joinSecret but the
      // target still known and unbanned — a kick that silently undoes
      // itself on the object's next wake. Multi-key put is transactional.
      await this.state.storage.put({
        joinSecret,
        known: [...this.known!],
        banned: bannedList
      })
      // Tell the survivors who was banned — by hash, which is all anyone
      // but the key's owner ever knows. A household hop NEEDS this: its
      // shared upstream is authenticated as the household, so the ban
      // cannot close a kicked member's transport there, and the hop is
      // the enforcement point. Sent before this request returns, which
      // is what guarantees it precedes the admin's re-key on every
      // surviving socket — the re-key only leaves the admin after the
      // response arrives. Plaintext metadata, like the envelopes
      // themselves: it names an identity hash, never a key and never
      // content.
      const bannedEnvelope = JSON.stringify({ type: 'banned', hashes })
      for (const socket of this.state.getWebSockets()) {
        const attachment = this.attachmentOf(socket)
        if (attachment?.memberKeyHash && kicked.has(attachment.memberKeyHash)) continue
        try {
          socket.send(bannedEnvelope)
        } catch {
          // a dead socket is already gone
        }
      }
      // Disconnect AFTER the ban is persisted: a kicked client that
      // races a reconnect must hit the ban, not the old state.
      for (const socket of this.state.getWebSockets()) {
        const attachment = this.attachmentOf(socket)
        if (attachment?.memberKeyHash && kicked.has(attachment.memberKeyHash)) {
          try {
            socket.close(4001, 'Removed from this room.')
          } catch {
            // a dead socket is already gone
          }
        }
      }
      await this.touch()
      return new Response(JSON.stringify({ ok: true, joinSecret }), {
        headers: { 'content-type': 'application/json' }
      })
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

      // The membership gate. Legacy rooms sail through — verdict 'admit'
      // with nothing checked — so nothing about parties changed.
      await this.loadMembership()
      const memberKey = url.searchParams.get('member')
      const memberKeyHash =
        memberKey && isValidMemberKey(memberKey) ? await memberKeyHashOf(memberKey) : null
      const verdict = admissionVerdict({
        currentJoinSecret: this.joinSecret || null,
        memberKey,
        memberKeyHash,
        presentedJoinSecret: url.searchParams.get('join'),
        known: this.known!,
        bannedHashes: this.banned!
      })
      if (verdict === 'refuse') {
        return new Response('Not a member of this room.', { status: 403 })
      }
      if (verdict === 'admit-and-register') {
        this.known!.add(memberKey!)
        await this.state.storage.put('known', [...this.known!])
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
      server.serializeAttachment({
        connId,
        isHost,
        ...(memberKey && this.joinSecret ? { memberKey, memberKeyHash: memberKeyHash! } : {})
      } satisfies SocketAttachment)
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
    const now = Date.now()
    const rate = nextRelayMessageRate(
      attachment.rateWindowStartedAt,
      attachment.rateWindowMessageCount,
      now
    )
    if (!rate.allowed) {
      ws.close(1008, 'Message rate exceeds the party limit.')
      return
    }

    // Retain this connection's latest message for future joiners. Still
    // never decrypted — we store exactly the bytes we forward.
    ws.serializeAttachment({
      ...attachment,
      last: body,
      lastAt: now,
      rateWindowStartedAt: rate.windowStartedAt,
      rateWindowMessageCount: rate.windowMessageCount
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
