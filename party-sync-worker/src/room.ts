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
  /** The VERIFIED identity this connection admitted with (sha256 of
   *  its public key), for rooms with a membership layer. Absent on
   *  legacy rooms and parties. */
  memberId?: string
  /** The host this connection dialled, for verifying carry cryptograms
   *  that arrive later on the same socket. */
  host?: string
  /** Identities this connection CARRIES on behalf of a household hop —
   *  each one verified by its own cryptogram, exactly like a direct
   *  admission. What lets one network connection answer for several
   *  members without any of them trusting the box between. */
  carried?: string[]
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

// --- membership: chip-and-tap ------------------------------------------------
//
// Rooms created with {membership: true} gain a relay-level admission
// layer. It works the way EMV bank cards do, which is the design brief
// it was built to: each install holds an Ed25519 private key that never
// leaves the device, and admission presents a CRYPTOGRAM — a signature
// over this relay's host, the room, a timestamp and a monotonic counter
// (EMV's ATC). This object verifies the signature, the freshness and
// the counter, so an intercepted cryptogram is a receipt, not a card:
// bound to one door, one moment, already spent.
//
// The member's identity IS the key — their id is sha256(publicKey) — so
// there are no bearer strings left at this layer at all. The joinSecret
// survives with one narrow job: it is the invite's proof, required only
// of identities this room has never seen. This object still never
// decrypts a byte of room content.
//
// docs/ROOMS.md in the main app is the policy; the client-side mirror
// of the cryptogram format is src/main/media-hub/roomIdentity.ts, and
// the two must stay in lockstep.

/** Bounds the identity sets a room accumulates in Durable Object
 *  storage. Known is a hard cap — a room with 256 distinct installs is
 *  not a household. Banned drops its OLDEST entries past the cap, which
 *  is safe: an evicted banned identity becomes merely unknown, and
 *  unknown identities need the CURRENT joinSecret — which rotated at
 *  the moment they were banned. */
export const MAX_KNOWN_MEMBERS = 256
export const MAX_BANNED_MEMBERS = 512
export const CRYPTOGRAM_FRESHNESS_MS = 5 * 60 * 1000

const MEMBER_ID_RE = /^[0-9a-f]{64}$/

export function isValidMemberId(id: unknown): id is string {
  return typeof id === 'string' && MEMBER_ID_RE.test(id)
}

export interface CryptogramInput {
  pub: string
  ts: number
  ctr: number
  sig: string
}

function fromB64url(value: string): Uint8Array | null {
  try {
    const b64 = value.replace(/-/g, '+').replace(/_/g, '/')
    const raw = atob(b64)
    const out = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Verifies one cryptogram: signature, freshness, and shape. The COUNTER
 * floor is the caller's (it lives in storage); everything stateless is
 * here. Returns the verified identity id, or a refusal.
 *
 * Must mirror roomIdentity.ts's cryptogramData exactly — the signed
 * bytes are `purpose|relayHost|roomId|ts|ctr`.
 */
export async function verifyCryptogram(
  cryptogram: CryptogramInput,
  purpose: 'admit' | 'carry',
  relayHost: string,
  roomId: string,
  now = Date.now()
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  if (
    typeof cryptogram.pub !== 'string' ||
    typeof cryptogram.sig !== 'string' ||
    !Number.isFinite(cryptogram.ts) ||
    !Number.isInteger(cryptogram.ctr) ||
    cryptogram.ctr < 0
  ) {
    return { ok: false, reason: 'malformed' }
  }
  if (Math.abs(now - cryptogram.ts) > CRYPTOGRAM_FRESHNESS_MS) {
    return { ok: false, reason: 'stale' }
  }
  const pubBytes = fromB64url(cryptogram.pub)
  const sigBytes = fromB64url(cryptogram.sig)
  if (!pubBytes || pubBytes.length !== 32 || !sigBytes) return { ok: false, reason: 'bad key' }
  let key: CryptoKey
  try {
    key = await crypto.subtle.importKey(
      'raw',
      pubBytes as unknown as ArrayBuffer,
      { name: 'Ed25519' },
      false,
      ['verify']
    )
  } catch {
    return { ok: false, reason: 'bad key' }
  }
  const data = new TextEncoder().encode(
    `${purpose}|${relayHost}|${roomId.toLowerCase()}|${cryptogram.ts}|${cryptogram.ctr}`
  )
  let valid = false
  try {
    valid = await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      sigBytes as unknown as ArrayBuffer,
      data as unknown as ArrayBuffer
    )
  } catch {
    valid = false
  }
  if (!valid) return { ok: false, reason: 'bad signature' }
  return { ok: true, id: await sha256Hex(pubBytes) }
}

export type AdmissionVerdict = 'admit' | 'admit-and-register' | 'refuse'

/**
 * Whether a VERIFIED identity is let into the room. Pure and sync: the
 * cryptogram (signature, freshness, counter) is checked before this is
 * consulted; this is only the membership policy.
 *
 *  - A legacy room (no joinSecret was ever minted) admits everyone, as
 *    it always has. Ephemeral watch parties and pre-identity rooms live
 *    here, and nothing about them changed.
 *  - BANNED WINS OVER EVERYTHING — including a banned identity that
 *    somehow presents the current joinSecret (the admin's own re-key
 *    could leak inside a household; the ban must hold anyway).
 *  - A KNOWN identity is admitted with a stale joinSecret: an offline
 *    member returning after a rotation must not be locked out of their
 *    own room. Rotation gates STRANGERS, not members.
 *  - A stranger with the current joinSecret is admitted and becomes
 *    known. A stranger without it is refused.
 */
export function admissionVerdict(input: {
  currentJoinSecret: string | null
  /** The identity the cryptogram VERIFIED, or null when none/invalid. */
  verifiedId: string | null
  presentedJoinSecret: string | null
  known: ReadonlySet<string>
  banned: ReadonlySet<string>
}): AdmissionVerdict {
  if (!input.currentJoinSecret) return 'admit'
  if (!input.verifiedId) return 'refuse'
  if (input.banned.has(input.verifiedId)) return 'refuse'
  if (input.known.has(input.verifiedId)) return 'admit'
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
  /** Per-identity counter floors — EMV's ATC. A cryptogram whose ctr is
   *  not strictly above the floor is a replay, however perfect its
   *  signature. */
  private ctrs: Map<string, number> | null = null
  /** This object's own room id, learned from the first connect's path
   *  and persisted — carry frames arrive mid-connection with no URL to
   *  parse it from. */
  private roomId: string | null = null

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
    if (this.ctrs === null) {
      this.ctrs = new Map(
        Object.entries((await this.state.storage.get<Record<string, number>>('ctrs')) ?? {})
      )
    }
    if (this.roomId === null) {
      this.roomId = (await this.state.storage.get<string>('roomId')) ?? null
    }
  }

  private counterAccepts(id: string, ctr: number): boolean {
    return ctr > (this.ctrs?.get(id) ?? -1)
  }

  /** Records a successful admission: the identity's new counter floor,
   *  and its registration when the joinSecret admitted a stranger. One
   *  storage write for both. */
  private async commitAdmission(id: string, verdict: AdmissionVerdict, ctr: number): Promise<void> {
    this.ctrs!.set(id, ctr)
    // Bounded like the identity sets: a full counter table sheds its
    // oldest entry, whose identity then merely needs a fresh cryptogram
    // with any higher counter — safe, because freshness still gates it.
    if (this.ctrs!.size > MAX_KNOWN_MEMBERS * 2) {
      const oldest = this.ctrs!.keys().next().value
      if (oldest) this.ctrs!.delete(oldest)
    }
    const writes: Record<string, unknown> = { ctrs: Object.fromEntries(this.ctrs!) }
    if (verdict === 'admit-and-register') {
      this.known!.add(id)
      writes.known = [...this.known!]
    }
    await this.state.storage.put(writes)
  }

  /**
   * A carry frame: a household hop vouching for one more member it
   * transports, with that member's own cryptogram — which the hop can
   * forward but never mint. Verified exactly like a direct admission,
   * against the host THIS connection arrived on; the reply tells the
   * hop whether the member is genuine, and the attachment records who
   * this connection now answers for.
   */
  private async handleCarry(ws: WebSocket, frame: Record<string, unknown>): Promise<void> {
    const attachment = this.attachmentOf(ws)
    await this.loadMembership()
    const refuse = (error: string): void => {
      try {
        ws.send(JSON.stringify({ type: 'carry-rejected', error }))
      } catch {
        // dead socket cleans itself up
      }
    }
    if (!attachment || !this.joinSecret || !this.roomId || !attachment.host) {
      refuse('This room has no membership layer.')
      return
    }
    const cryptogram = {
      pub: String(frame.pub ?? ''),
      ts: Number(frame.ts),
      ctr: Number(frame.ctr),
      sig: String(frame.sig ?? '')
    }
    const verified = await verifyCryptogram(cryptogram, 'carry', attachment.host, this.roomId)
    if (!verified.ok) {
      refuse(verified.reason)
      return
    }
    if (!this.counterAccepts(verified.id, cryptogram.ctr)) {
      refuse('replayed')
      return
    }
    const verdict = admissionVerdict({
      currentJoinSecret: this.joinSecret,
      verifiedId: verified.id,
      presentedJoinSecret: typeof frame.join === 'string' ? frame.join : null,
      known: this.known!,
      banned: this.banned!
    })
    if (verdict === 'refuse') {
      refuse('Not a member of this room.')
      return
    }
    await this.commitAdmission(verified.id, verdict, cryptogram.ctr)
    const carried = [...(attachment.carried ?? [])]
    if (!carried.includes(verified.id)) carried.push(verified.id)
    ws.serializeAttachment({ ...attachment, carried } satisfies SocketAttachment)
    try {
      ws.send(JSON.stringify({ type: 'carry-ok', id: verified.id }))
    } catch {
      // dead socket cleans itself up
    }
  }

  private roomIdFor(url: URL): string | null {
    const match = /^\/party\/([0-9a-f-]{36})/i.exec(url.pathname)
    return match ? match[1].toLowerCase() : null
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
      const body = (await request.json()) as { roomToken?: string; memberIds?: unknown }
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
      // Kicks name IDENTITIES — sha256 of a public key, which is also
      // the friendId everyone already sees. One namespace, nothing
      // secret in it: an id without its private key cannot connect.
      const ids = (Array.isArray(body.memberIds) ? body.memberIds : []).filter(isValidMemberId)
      if (!ids.length) return new Response('No members named.', { status: 400 })
      const kicked = new Set(ids)
      for (const id of ids) {
        this.banned!.add(id)
        this.known!.delete(id)
        this.ctrs?.delete(id)
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
      const bannedEnvelope = JSON.stringify({ type: 'banned', hashes: ids })
      for (const socket of this.state.getWebSockets()) {
        const attachment = this.attachmentOf(socket)
        if (attachment?.memberId && kicked.has(attachment.memberId)) continue
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
        if (attachment?.memberId && kicked.has(attachment.memberId)) {
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
      // The tap. A membership connect presents a cryptogram — pub, ts,
      // ctr, sig — verified against THIS host and room, with the counter
      // strictly above the identity's stored floor (EMV's ATC), so a
      // captured cryptogram is dead on arrival anywhere, anytime else.
      // Carrier connections (a household hop) present purpose 'carry'
      // for the first member they carry; direct members present 'admit'.
      let verifiedId: string | null = null
      let admittedCtr = 0
      const isCarrier = url.searchParams.get('carrier') === '1'
      // Remember this object's own room id — carry frames arrive with no
      // URL, and their cryptograms bind to it.
      const pathRoomId = this.roomIdFor(url)
      if (pathRoomId && this.roomId !== pathRoomId) {
        this.roomId = pathRoomId
        await this.state.storage.put('roomId', pathRoomId)
      }
      if (this.joinSecret) {
        const cryptogram = {
          pub: url.searchParams.get('pub') ?? '',
          ts: Number(url.searchParams.get('ts')),
          ctr: Number(url.searchParams.get('ctr')),
          sig: url.searchParams.get('sig') ?? ''
        }
        const verified = await verifyCryptogram(
          cryptogram,
          isCarrier ? 'carry' : 'admit',
          url.host,
          pathRoomId ?? '',
          Date.now()
        )
        if (verified.ok && this.counterAccepts(verified.id, cryptogram.ctr)) {
          verifiedId = verified.id
          admittedCtr = cryptogram.ctr
        }
      }
      const verdict = admissionVerdict({
        currentJoinSecret: this.joinSecret || null,
        verifiedId,
        presentedJoinSecret: url.searchParams.get('join'),
        known: this.known!,
        banned: this.banned!
      })
      if (verdict === 'refuse') {
        return new Response('Not a member of this room.', { status: 403 })
      }
      if (this.joinSecret && verifiedId)
        await this.commitAdmission(verifiedId, verdict, admittedCtr)

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
        ...(verifiedId && this.joinSecret
          ? isCarrier
            ? { carried: [verifiedId], host: url.host }
            : { memberId: verifiedId, host: url.host }
          : {})
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
    // Carry frames are the one message CONTENT this object reads — a
    // hop vouching for another member with a cryptogram. Everything
    // else stays opaque and fans out below. Room ciphertext cannot
    // collide with this: encrypted payloads are not JSON objects with a
    // type field.
    if (body.length < 2048 && body.includes('"carry"')) {
      try {
        const frame = JSON.parse(body) as Record<string, unknown>
        if (frame && frame.type === 'carry') {
          await this.handleCarry(ws, frame)
          return
        }
      } catch {
        // not a frame — fall through to the relay path
      }
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
