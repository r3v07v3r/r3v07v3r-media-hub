// Rooms: persistent, host-less presence channels — plural.
//
// This grew out of the single "friends group" (its history is this file's
// history: one room, one socket, presence as soft state with a TTL). What
// changed is the cardinality and the ownership. A person now sits in
// several rooms at once — the family, the film friends — each its own
// relay room with its own secret, its own member view, and its own
// decision about whether this device's activity is published there.
//
// Deliberately built on exactly the same relay room a watch party uses: a
// room is just another Durable Object everyone stays connected to, the
// server stays a dumb forwarder that never decrypts, and room traffic is
// end-to-end encrypted with the room secret for free.
//
// PRESENCE IS STILL HOST-LESS. The room keeps working when any member is
// offline — including its admin. Nobody is authoritative about who is
// present: every member announces itself on an interval and every member
// independently builds its own view from what it hears; a member who
// stops announcing ages out. What the ADMIN owns is the room itself, not
// the roster: their identity is baked into the invite code at creation
// (see ShareCodePayloadV3), which is what lets everyone agree who the
// admin is with no relay round-trip — and it is the identity the rename
// rule believes. The relay host token from /host is kept, unused, as the
// credential the worker-side kick will present.
//
// Activity ("watching Dune, 34 minutes in") rides the announcement and is
// opt-in PER ROOM: sharing with the family and not the poker group is the
// entire reason rooms are plural. With sharing off the field is simply
// absent, so a member who has not opted in is indistinguishable from one
// who is not watching anything.

import crypto from 'node:crypto'

import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import type {
  RoomActivity,
  RoomInboundMessage,
  RoomMessage,
  RoomsStatus,
  RoomView
} from '../../shared/media-hub/types'
import { decodeShareCode, decryptMessage, encodeRoomShareCode, encryptMessage } from './party'
import {
  ANNOUNCE_INTERVAL_MS,
  acceptRoomName,
  applyRekey,
  PREV_SECRETS_KEPT,
  parseBannedEnvelope,
  rememberKicked,
  migrateLegacyRooms,
  reapPresence,
  recordPresence,
  withRoomName,
  type PresenceRecord,
  type StoredRoom
} from './roomRules'
import { handle } from './ipcGuard'
import { logError } from './logger'
import { sendToRenderer } from './rendererBridge'
import {
  generateIdentity,
  identityFromPrivateDer,
  exportPrivateDer,
  mintCryptogram,
  nextSeq,
  signRoomMessage,
  verifyRoomMessage,
  type RoomIdentity,
  type SignedEnvelope
} from './roomIdentity'
import { asRoomSocket, connectHopWs, type RoomSocket } from './roomsHopClient'
import {
  decrypt,
  encrypt,
  getLanCacheConnection,
  partySyncCredentials,
  readSettings,
  writeSettings
} from './settingsStore'
import { connectRelayWs } from './watchParty'

/** Reconnect backoff bounds. A room is meant to be always-on, so a
 *  dropped socket retries indefinitely rather than giving up — but it
 *  backs off so a worker outage doesn't turn every client into a hot
 *  loop. Per room: one struggling room must not delay another's socket. */
const RECONNECT_MIN_MS = 3_000
const RECONNECT_MAX_MS = 120_000

/** How old a signed message may be and still be believed. Wide enough
 *  for the relay's retained replays (which arrive stamped with their
 *  age); tight enough that yesterday's captured re-key cannot roll a
 *  room back to yesterday's secret. */
const MESSAGE_FRESHNESS_MS = 10 * 60 * 1000

interface RoomState {
  roomId: string
  stored: StoredRoom
  relayUrl: string
  secret: string
  /** Whether this room speaks the signed dialect (v4 code, admin key
   *  known). The one legacy room — the migrated friends group — does
   *  not, and stays on the old wire so pre-rooms clients still work. */
  signed: boolean
  /** This device's per-room send sequence — the message-layer ATC. */
  seq: number
  /** Per-sender high-water marks for received sequences. In-memory on
   *  purpose: after a restart the freshness window covers the gap. */
  lastSeqs: Map<string, number>
  ws: RoomSocket | null
  /** Which path this room's socket took — shown in the UI, pinned in
   *  tests, and the honest answer to "is the hop actually in use". */
  transport: 'relay' | 'cache-hop'
  presence: Map<string, PresenceRecord>
  reconnectTimer: ReturnType<typeof setTimeout> | null
  reconnectDelay: number
  replyTimer: ReturnType<typeof setTimeout> | null
  /** Resolvers waiting to OBSERVE a ban for a given id on this room's
   *  socket — the kick flow's barrier before the re-key broadcast. */
  banWaiters: Map<string, (() => void)[]>
  closing: boolean
}

const rooms = new Map<string, RoomState>()
/** What this device is watching right now, or null — one fact, published
 *  into each room whose sharing switch is on. */
let currentActivity: RoomActivity | null = null
let announceTimer: ReturnType<typeof setInterval> | null = null
let reapTimer: ReturnType<typeof setInterval> | null = null

/** A per-install identity that survives restarts, the same in every room.
 *  The relay's own connId changes on every connection, so it cannot be
 *  used to recognise the same person twice. */
function selfIdentity(): { friendId: string; name: string } {
  const settings = readSettings()
  let friendId = settings.friendId
  if (!friendId) {
    friendId = crypto.randomUUID()
    settings.friendId = friendId
    writeSettings(settings)
  }
  return { friendId, name: settings.partyDisplayName || 'Someone' }
}

/**
 * This install's chip: the Ed25519 identity every signed room speaks
 * as. Created once, persisted ENCRYPTED like every other credential,
 * and its id (sha256 of the public key) is the friendId other members
 * see — claiming it without the private key is impossible, because
 * nothing you say verifies. Losing the key is losing the identity;
 * docs/ROOMS.md says so plainly rather than promising recovery.
 */
let cachedIdentity: RoomIdentity | null = null
function roomsIdentity(): RoomIdentity {
  if (cachedIdentity) return cachedIdentity
  const settings = readSettings()
  const stored = settings.roomIdentityKey
    ? identityFromPrivateDer(decrypt(settings.roomIdentityKey))
    : null
  if (stored) {
    cachedIdentity = stored
    return stored
  }
  const fresh = generateIdentity()
  settings.roomIdentityKey = encrypt(exportPrivateDer(fresh))
  writeSettings(settings)
  cachedIdentity = fresh
  return fresh
}

/** The identity's monotonic cryptogram counter — EMV's ATC. Strictly
 *  increasing across every room and relay, persisted before use, so a
 *  replayed cryptogram is always below some server's floor. */
function nextCtr(): number {
  const settings = readSettings()
  const next = (Number(settings.roomIdentityCtr) || 0) + 1
  settings.roomIdentityCtr = next
  writeSettings(settings)
  return next
}

/**
 * Sends one payload into a room, in whichever dialect the room speaks.
 *
 * Signed rooms wrap the body in a signed envelope (sign-then-encrypt):
 * the signature proves the sender to other MEMBERS; the encryption
 * keeps it from everyone else, exactly as before. The legacy room sends
 * the old shape verbatim — its other members may be running the app
 * from before identities existed.
 */
function sendRoomPayload(
  room: RoomState,
  body: Record<string, unknown>,
  opts: { transient?: boolean; underSecret?: string } = {}
): void {
  if (!room.ws) return
  const secret = opts.underSecret ?? room.secret
  // Time-anchored, not a plain counter: a restart resumes ABOVE every
  // sequence the previous session sent, so peers who stayed online and
  // hold the old high-water mark accept the first message immediately
  // instead of rejecting hours of them as replays. See nextSeq.
  if (room.signed) room.seq = nextSeq(room.seq)
  const payload = room.signed
    ? (signRoomMessage(roomsIdentity(), room.roomId, body, room.seq) as unknown as Record<
        string,
        unknown
      >)
    : body
  try {
    room.ws.send(encryptMessage(secret, payload), opts.transient ? { transient: true } : undefined)
  } catch {
    // the socket's own close/error path handles it
  }
}

function storedRooms(): StoredRoom[] {
  return readSettings().rooms ?? []
}

function persistRooms(list: StoredRoom[]): void {
  const settings = readSettings()
  settings.rooms = list
  writeSettings(settings)
}

/** Updates one persisted room in place, keyed by its code. */
function updateStoredRoom(code: string, change: (room: StoredRoom) => void): void {
  const list = storedRooms()
  const room = list.find((entry) => entry.code === code)
  if (!room) return
  change(room)
  persistRooms(list)
}

/** Like updateStoredRoom, but keyed by the room's relay id — for the
 *  re-key path, where the code itself is the thing changing and can no
 *  longer be used to find the row it replaces. */
function updateStoredRoomById(room: RoomState, change: (stored: StoredRoom) => void): void {
  const list = storedRooms()
  for (const entry of list) {
    const parsed = decodeShareCode(entry.code)
    if (parsed && parsed.v !== 1 && parsed.relay.roomId === room.roomId) {
      change(entry)
      persistRooms(list)
      return
    }
  }
}

/** Debounce for re-key rescues, per room+member: a returning member
 *  announces on an interval, and one hand-off per arrival is enough. */
const rekeyOffers = new Map<string, number>()
const REKEY_OFFER_INTERVAL_MS = 60_000

function offerRekeyTo(room: RoomState, toFriendId: string, underSecret: string): void {
  if (!toFriendId || !room.ws) return
  const key = `${room.roomId}:${toFriendId}`
  const last = rekeyOffers.get(key) ?? 0
  const now = Date.now()
  if (now - last < REKEY_OFFER_INTERVAL_MS) return
  rekeyOffers.set(key, now)
  // Under the secret the returner actually SPOKE — someone offline
  // through two rotations is two dialects behind, and a hand-off in
  // last week's dialect would be as unreadable to them as today's.
  // Signed (the returner verifies it really is the admin handing over
  // keys) and transient (never retained by a hop — a re-key replayed to
  // the NEXT local subscriber is a re-key delivered to exactly who must
  // not get one).
  sendRoomPayload(
    room,
    { type: 'room-rekey', code: room.stored.code, toFriendId },
    { transient: true, underSecret }
  )
}

function pushStatus(): void {
  sendToRenderer(MEDIA_HUB_CHANNELS.roomsEvent, roomsStatus())
}

export function roomsStatus(): RoomsStatus {
  // The signed identity is the self everywhere that matters now; the
  // legacy UUID only ever mattered inside the one unsigned room, which
  // has no admin to compare against.
  const selfId = roomsIdentity().id
  const now = Date.now()
  const views: RoomView[] = [...rooms.values()].map((room) => ({
    roomId: room.roomId,
    name: room.stored.name,
    code: room.stored.code,
    connected: room.ws !== null,
    isAdmin: Boolean(room.stored.adminFriendId && room.stored.adminFriendId === selfId),
    hasAdmin: Boolean(room.stored.adminFriendId),
    sharing: room.stored.sharing,
    transport: room.transport,
    members: [...room.presence.values()]
      .filter((record) => now - record.lastSeen <= 70_000)
      .map((record) => ({
        friendId: record.friendId,
        name: record.name,
        activity: record.activity
      }))
  }))
  return { selfId, rooms: views }
}

function announceRoom(room: RoomState): void {
  if (!room.ws) return
  const { friendId, name } = selfIdentity()
  const selfId = room.signed ? roomsIdentity().id : friendId
  // Sharing off means the field is absent entirely, not null-with-a-flag:
  // "not sharing" and "not watching" should be indistinguishable to
  // everyone else.
  const payload: Record<string, unknown> = {
    type: 'friend-presence',
    name
  }
  // Legacy wire only: the claimed sender. Signed rooms carry identity
  // in the envelope, verified — a claimed field there would only be a
  // second, weaker copy of the truth.
  if (!room.signed) payload.friendId = friendId
  if (room.stored.sharing && currentActivity) payload.activity = currentActivity
  // The room's name travels with its admin: renames reach members through
  // the same channel as everything else, and the rename rule on the
  // receiving side believes this field only from the admin — a VERIFIED
  // admin, in signed rooms.
  if (room.stored.adminFriendId === selfId) payload.roomName = room.stored.name
  sendRoomPayload(room, payload)
}

function announceAll(): void {
  for (const room of rooms.values()) announceRoom(room)
}

/** Answer someone this room hasn't seen before, so they learn about us
 *  without waiting out our announce interval. Debounced per room — a join
 *  into a large room would otherwise have everyone reply at once. */
function replyToNewcomer(room: RoomState): void {
  if (room.replyTimer) return
  room.replyTimer = setTimeout(() => {
    room.replyTimer = null
    announceRoom(room)
  }, 400)
}

function onRoomMessage(room: RoomState, raw: unknown): void {
  let body = String(raw)
  let ageMs = 0
  try {
    const envelope = JSON.parse(body) as { type?: string; body?: string; ageMs?: number }
    if (envelope?.type === 'relay' && typeof envelope.body === 'string') {
      body = envelope.body
    } else if (envelope?.type === 'retained' && typeof envelope.body === 'string') {
      // State the relay held for a member who was already here — what
      // lets a joiner see the room immediately instead of waiting out
      // everyone's announce interval. The relay cannot read it, so it
      // stamps how long it has held it and presence ages it accordingly.
      body = envelope.body
      ageMs = Number(envelope.ageMs) || 0
    } else if (envelope?.type === 'assigned') {
      return
    }
  } catch {
    // not an envelope — fall through and try to decrypt as-is
  }
  // The relay announcing a kick's bans. Plaintext metadata; what reads
  // it here is the kick flow's barrier — see the kick handler.
  const bannedIds = parseBannedEnvelope(body)
  if (bannedIds) {
    for (const id of bannedIds) {
      for (const resolve of room.banWaiters.get(id) ?? []) resolve()
      room.banWaiters.delete(id)
    }
    return
  }
  let msg = decryptMessage(room.secret, body) as Record<string, unknown> | null
  let matchedOldSecret: string | null = null
  // A message the current secret cannot read may be a member who was
  // offline through re-keys — possibly several — still speaking an old
  // dialect. The bounded chain of previous secrets exists for exactly
  // this, newest first; anything NONE of them can read is noise and
  // stays unread. Which one matched matters: the rescue answers in it.
  if (!msg) {
    for (const previous of room.stored.prevSecrets ?? []) {
      msg = decryptMessage(previous, body) as Record<string, unknown> | null
      if (msg) {
        matchedOldSecret = previous
        break
      }
    }
  }
  if (!msg) return
  const { friendId } = selfIdentity()
  const selfId = room.signed ? roomsIdentity().id : friendId

  // WHO SPOKE. In a signed room that answer comes out of a signature —
  // verified against the carried public key, the key hashed against the
  // claimed id, the sequence strictly above this sender's last, and the
  // timestamp inside the freshness window (widened by however long the
  // relay honestly held a retained replay). An unsigned message in a
  // signed room is dropped, whatever it says: the room's whole point is
  // that nobody can speak as anyone else.
  let from: string
  if (room.signed) {
    const envelope = msg as unknown as SignedEnvelope
    const verified = verifyRoomMessage(
      room.roomId,
      envelope,
      room.lastSeqs.get(String(envelope.from))
    )
    if (!verified.ok) return
    if (Date.now() - envelope.ts > MESSAGE_FRESHNESS_MS + ageMs) return
    room.lastSeqs.set(verified.from, envelope.seq)
    from = verified.from
    msg = verified.body
  } else {
    from = String(msg.friendId || '')
  }

  // The admin rotated the room's secret — after a kick, always after the
  // relay ban, because the new joinSecret in the code only exists in the
  // kick response. applyRekey is the judgement: admin only, same room,
  // same admin in the new code.
  if (msg.type === 'room-rekey') {
    const adopted = applyRekey(
      { roomId: room.roomId, relayUrl: room.relayUrl, adminFriendId: room.stored.adminFriendId },
      msg,
      // The verified sender in signed rooms — "only the admin is
      // believed" is a property of the signature, not of a claim.
      from
    )
    if (!adopted || adopted.secret === room.secret) return
    const chain = [room.secret, ...(room.stored.prevSecrets ?? [])].slice(0, PREV_SECRETS_KEPT)
    room.secret = adopted.secret
    room.stored.code = adopted.code
    room.stored.joinSecret = adopted.joinSecret
    room.stored.prevSecrets = chain
    updateStoredRoomById(room, (stored) => {
      stored.code = adopted.code
      stored.joinSecret = adopted.joinSecret
      stored.prevSecrets = chain
    })
    pushStatus()
    return
  }

  if (msg.type === 'friend-presence') {
    // A KICKED member speaking an old secret is not a member returning —
    // it is the removal still being enforced. No presence row, and above
    // all no rescue: behind a household hop their transport survives the
    // relay ban, they still hold the old secret, and a rescue would hand
    // them the new code. The relay ban plus this gate is the whole
    // removal for hop members.
    if (matchedOldSecret && (room.stored.kickedFriendIds ?? []).includes(from)) {
      return
    }
    // Someone speaking the OLD secret after a re-key was offline when it
    // happened. Hand them the current code under the dialect they can
    // read — safe, because the one party that must not hear it is banned
    // at the relay (or gated above, where a ban cannot reach their
    // transport). Admin only: one rescuer is enough, and the admin's
    // copy is always current.
    if (matchedOldSecret && room.stored.adminFriendId === selfId) {
      offerRekeyTo(room, from, matchedOldSecret)
    }
    const { changed, isNewcomer } = recordPresence(
      room.presence,
      from,
      msg,
      selfId,
      Date.now(),
      ageMs
    )
    if (isNewcomer) replyToNewcomer(room)
    // The admin's announcements carry the room's name — see announceRoom.
    // In signed rooms `from` is the signature's verdict, so a rename is
    // accepted from the admin's KEY, not the admin's name.
    const renamed = acceptRoomName(room.stored.name, msg.roomName, from, room.stored.adminFriendId)
    const wasRenamed = renamed !== room.stored.name
    if (wasRenamed) {
      // The display name AND this member's own copy of the invite code:
      // the code is what gets copied for the next person, and one left
      // carrying the old name would hand them a label no announcement
      // could ever correct if the admin happened to be offline.
      const oldCode = room.stored.code
      const recoded = withRoomName(oldCode, renamed)
      room.stored.name = renamed
      if (recoded) room.stored.code = recoded
      updateStoredRoom(oldCode, (stored) => {
        stored.name = renamed
        if (recoded) stored.code = recoded
      })
    }
    if (changed || wasRenamed) pushStatus()
    return
  }
  // Peer-to-peer requests. Addressed messages are filtered here rather
  // than in the renderer so a device never even sees traffic meant for
  // someone else. Replayed (retained) copies are dropped: a join request
  // is a live intent, and answering a stale one would drag someone into a
  // party they asked about minutes ago.
  if (
    ageMs === 0 &&
    typeof msg.type === 'string' &&
    msg.type.startsWith('friend-join-') &&
    msg.toFriendId === selfId
  ) {
    const inbound: RoomInboundMessage = {
      roomId: room.roomId,
      message: msg as unknown as RoomMessage
    }
    sendToRenderer(MEDIA_HUB_CHANNELS.roomsMessage, inbound)
  }
}

function scheduleReconnect(room: RoomState): void {
  if (room.closing || room.reconnectTimer) return
  const delay = room.reconnectDelay
  room.reconnectDelay = Math.min(RECONNECT_MAX_MS, Math.round(delay * 1.8))
  room.reconnectTimer = setTimeout(() => {
    room.reconnectTimer = null
    if (!rooms.has(room.roomId)) return
    openSocket(room).catch(() => scheduleReconnect(room))
  }, delay)
}

/** Whether the paired cache server advertises the rooms hop, cached
 *  briefly per URL. A pre-hop daemon defines its answer by ABSENCE, and
 *  dialling it anyway would cost every room a failed subscription (up
 *  to the six-second timeout) on every reconnect. One two-second ping a
 *  minute answers for all rooms at once. */
const hopCapability = new Map<string, { ok: boolean; at: number }>()
const HOP_CAPABILITY_TTL_MS = 60_000

async function daemonAdvertisesHop(url: string): Promise<boolean> {
  const cached = hopCapability.get(url)
  if (cached && Date.now() - cached.at < HOP_CAPABILITY_TTL_MS) return cached.ok
  let ok = false
  try {
    const response = await fetch(`${url}/api/ping`, { signal: AbortSignal.timeout(2000) })
    const ping = (await response.json()) as { roomsHop?: boolean }
    ok = ping.roomsHop === true
  } catch {
    ok = false
  }
  hopCapability.set(url, { ok, at: Date.now() })
  return ok
}

async function openSocket(room: RoomState): Promise<void> {
  if (room.closing) return
  // THE TRANSPORT CHOICE, made fresh on every (re)connect. A paired
  // cache server carries the room as the network's single relay
  // connection; anything short of that — no server, a pre-hop daemon,
  // a refused subscription — falls through to connecting direct. The
  // hop is an optimisation the household added, never a dependency:
  // no setting, no error surfaced, just the better path when it
  // exists and the ordinary one when it does not.
  let ws: RoomSocket | null = null
  const lan = getLanCacheConnection()
  const relayHost = new URL(room.relayUrl).host
  if (lan && !lan.pending && (await daemonAdvertisesHop(lan.url))) {
    try {
      // The tap, handed to the terminal: a 'carry' cryptogram the
      // daemon forwards to the relay, which verifies it exactly like a
      // direct admission. The daemon can deliver it but never mint it —
      // it is bound to this relay, this room, this moment, and a
      // counter that is already spent.
      const cryptogram = room.signed
        ? mintCryptogram(roomsIdentity(), 'carry', relayHost, room.roomId, nextCtr())
        : undefined
      ws = await connectHopWs(lan.url, lan.token, {
        roomId: room.roomId,
        relayUrl: room.relayUrl,
        join: room.stored.joinSecret,
        cryptogram
      })
      room.transport = 'cache-hop'
    } catch {
      ws = null
    }
  }
  if (!ws) {
    // Direct: the tap at the relay's own door — an 'admit' cryptogram.
    // A KNOWN identity is admitted even with a stale joinSecret, so a
    // rotation while this device slept does not lock it out; what it
    // must always do is PROVE the identity, fresh, every time.
    const query: Record<string, string> = {}
    if (room.signed) {
      const cryptogram = mintCryptogram(roomsIdentity(), 'admit', relayHost, room.roomId, nextCtr())
      query.pub = cryptogram.pub
      query.ts = String(cryptogram.ts)
      query.ctr = String(cryptogram.ctr)
      query.sig = cryptogram.sig
    }
    if (room.stored.joinSecret) query.join = room.stored.joinSecret
    ws = asRoomSocket(
      await connectRelayWs(room.relayUrl, room.roomId, {
        token: room.stored.roomToken ?? '',
        query
      })
    )
    room.transport = 'relay'
  }
  if (rooms.get(room.roomId) !== room || room.closing) {
    try {
      ws.close()
    } catch {
      // superseded by a newer connect or a leave
    }
    return
  }
  room.ws = ws
  room.reconnectDelay = RECONNECT_MIN_MS
  ws.on('message', (raw: unknown) => onRoomMessage(room, raw))
  const onGone = (): void => {
    if (rooms.get(room.roomId) !== room) return
    room.ws = null
    pushStatus()
    scheduleReconnect(room)
  }
  ws.on('close', onGone)
  ws.on('error', onGone)
  // Announce immediately so a reconnect doesn't leave us invisible for a
  // full interval, and so everyone already present learns about us at once.
  announceRoom(room)
  pushStatus()
}

/** Brings one stored room to life. Idempotent by roomId — joining a code
 *  for a room already active is a no-op, not a second socket.
 *
 *  `firstConnectMustSucceed` is the difference between restoring a room
 *  this install already belongs to (retry forever — the relay being
 *  down is not a reason to lose a room) and JOINING one (the connect is
 *  the proof the invite works, and a failure has to reach the person
 *  holding a possibly-stale code rather than silently persisting a room
 *  that can never connect). */
async function activateRoom(
  stored: StoredRoom,
  { firstConnectMustSucceed = false } = {}
): Promise<void> {
  const parsed = decodeShareCode(stored.code)
  if (!parsed || parsed.v === 1) throw new Error('That is not a valid room code.')
  if (rooms.has(parsed.relay.roomId)) return
  const room: RoomState = {
    roomId: parsed.relay.roomId,
    stored,
    relayUrl: parsed.relay.url,
    secret: parsed.secret,
    // The signed dialect requires an admin key to verify against; only
    // v4 codes carry one. The migrated legacy room stays on the old
    // wire — its other members may predate identities entirely.
    signed: Boolean(stored.adminPub),
    seq: 0,
    lastSeqs: new Map(),
    ws: null,
    transport: 'relay',
    presence: new Map(),
    reconnectTimer: null,
    reconnectDelay: RECONNECT_MIN_MS,
    replyTimer: null,
    banWaiters: new Map(),
    closing: false
  }
  rooms.set(room.roomId, room)
  ensureTimers()
  if (firstConnectMustSucceed) {
    try {
      await openSocket(room)
    } catch (error) {
      deactivateRoom(room.roomId)
      // 403 is the relay's admission gate: this install is a stranger to
      // a membership room and the code's joinSecret is no longer
      // current — rotated by a kick since the code was copied.
      if (String(error).includes('403')) {
        throw new Error('That invite has expired — ask for a fresh room code.')
      }
      throw error
    }
    return
  }
  await openSocket(room).catch((error) => {
    logError('rooms:connect', String(error))
    scheduleReconnect(room)
  })
}

function deactivateRoom(roomId: string): void {
  const room = rooms.get(roomId)
  if (!room) return
  room.closing = true
  if (room.reconnectTimer) clearTimeout(room.reconnectTimer)
  if (room.replyTimer) clearTimeout(room.replyTimer)
  try {
    room.ws?.close()
  } catch {
    // best-effort
  }
  rooms.delete(roomId)
  if (rooms.size === 0) stopTimers()
}

/** One announce interval and one reaper for every room, not one pair per
 *  room: N rooms ticking independently is N timers doing the same job at
 *  the same cadence. */
function ensureTimers(): void {
  if (!announceTimer) announceTimer = setInterval(announceAll, ANNOUNCE_INTERVAL_MS)
  if (!reapTimer) {
    reapTimer = setInterval(() => {
      let changed = false
      const now = Date.now()
      for (const room of rooms.values()) {
        if (reapPresence(room.presence, now)) changed = true
      }
      if (changed) pushStatus()
    }, 10_000)
  }
}

function stopTimers(): void {
  if (announceTimer) clearInterval(announceTimer)
  if (reapTimer) clearInterval(reapTimer)
  announceTimer = null
  reapTimer = null
}

/** Called at startup so saved rooms reconnect without anyone acting. Also
 *  where the single pre-rooms friends group becomes a room — see
 *  migrateLegacyRooms for why it arrives with no admin. */
export function restoreRooms(): void {
  const settings = readSettings()
  const { rooms: list, changed } = migrateLegacyRooms(settings)
  if (changed) {
    settings.rooms = list
    delete settings.friendsGroupCode
    writeSettings(settings)
  }
  for (const stored of list) {
    activateRoom(stored).catch((error) => logError('rooms:restore', String(error)))
  }
}

/**
 * Publishes (or clears) what this member is watching. Cheap and
 * idempotent — the renderer calls it as playback state changes, and it
 * only actually reaches the network on the next announce, or immediately
 * in the rooms that share when the title itself changed.
 */
export function setRoomsActivity(activity: RoomActivity | null): void {
  const changedTitle = (currentActivity?.mediaId || '') !== (activity?.mediaId || '')
  currentActivity = activity
  if (!changedTitle) return
  for (const room of rooms.values()) {
    if (room.stored.sharing) announceRoom(room)
  }
}

export function registerRoomsIpc(): void {
  handle(MEDIA_HUB_CHANNELS.roomsStatus, () => roomsStatus())

  handle<{ name?: string }, { ok: true; code: string }>(
    MEDIA_HUB_CHANNELS.roomsCreate,
    async (_e, payload) => {
      const creds = partySyncCredentials()
      if (!creds.url || !creds.inviteKey) {
        throw new Error('Configure R3-Party-Sync in Settings first.')
      }
      // membership: true asks the relay for the admission layer a kick
      // needs. A worker deployed before it exists simply returns no
      // joinSecret, and the room comes up as a legacy room — everything
      // works except kick, which is the honest degradation.
      const response = await fetch(`${creds.url}/host`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inviteKey: creds.inviteKey, membership: true })
      })
      if (!response.ok) throw new Error(`The party-sync worker refused: ${response.status}`)
      const { roomId, roomToken, joinSecret } = (await response.json()) as {
        roomId: string
        roomToken: string
        joinSecret?: string
      }
      const identity = roomsIdentity()
      const secret = crypto.randomBytes(24).toString('base64url')
      const name =
        String(payload?.name || '')
          .trim()
          .slice(0, 40) || 'A room'
      // The admin travels in the code as id AND public key — the key is
      // what lets every member VERIFY the admin's renames and re-keys
      // rather than trust them. The roomToken is kept but NOT in the
      // code — it is the creator's credential, and the code is handed to
      // everyone. The joinSecret IS in the code: it is the room's door
      // key, and an invite that cannot open the door invites nobody.
      const code = encodeRoomShareCode({
        relay: { url: creds.url, roomId },
        secret,
        name,
        admin: { id: identity.id, pub: identity.pub },
        join: joinSecret
      })
      const stored: StoredRoom = {
        code,
        name,
        sharing: false,
        adminFriendId: identity.id,
        adminPub: identity.pub,
        roomToken,
        joinSecret
      }
      persistRooms([...storedRooms(), stored])
      await activateRoom(stored)
      pushStatus()
      return { ok: true, code }
    }
  )

  handle<{ code?: string }, { ok: true }>(MEDIA_HUB_CHANNELS.roomsJoin, async (_e, payload) => {
    const code = String(payload?.code || '').trim()
    if (!code) throw new Error('Enter a room code.')
    const parsed = decodeShareCode(code)
    if (!parsed || parsed.v === 1) throw new Error('That is not a valid room code.')
    if (rooms.has(parsed.relay.roomId)) return { ok: true }
    // v3 was the pre-release bearer-string draft of rooms; nothing
    // shipped with it, and the relay no longer speaks it. Saying which
    // kind of code it is beats a confusing 403.
    if (parsed.v === 3) {
      throw new Error('That invite is from a pre-release build — ask for a fresh room code.')
    }
    const stored: StoredRoom = {
      code,
      // A v2 code is the old friends-group kind and carries no name; the
      // migration calls that room "Friends", so a member joining by its
      // original code must land on the SAME label — a v2 room has no
      // admin, so no announcement could ever reconcile a different one.
      name: (parsed.name || '').trim() || (parsed.v === 2 ? 'Friends' : 'A room'),
      sharing: false,
      // A v2 code predates admins; the room it joins simply has none.
      adminFriendId: parsed.v === 4 ? parsed.admin.id : undefined,
      adminPub: parsed.v === 4 ? parsed.admin.pub : undefined,
      // The code's joinSecret admits this identity once; after that it
      // is KNOWN to the relay and admits itself by cryptogram alone.
      joinSecret: parsed.v === 4 ? parsed.join : undefined
    }
    // The connect IS the invite check: a stale code (joinSecret rotated
    // by a kick since it was copied) fails loudly here instead of
    // persisting a room that can never connect and calling it joined.
    await activateRoom(stored, { firstConnectMustSucceed: true })
    persistRooms([...storedRooms(), stored])
    pushStatus()
    return { ok: true }
  })

  handle<{ roomId?: string }, { ok: true }>(MEDIA_HUB_CHANNELS.roomsLeave, (_e, payload) => {
    const roomId = String(payload?.roomId || '')
    const room = rooms.get(roomId)
    deactivateRoom(roomId)
    if (room) {
      persistRooms(storedRooms().filter((entry) => entry.code !== room.stored.code))
    }
    pushStatus()
    return { ok: true }
  })

  handle<{ roomId?: string; name?: string }, { ok: true }>(
    MEDIA_HUB_CHANNELS.roomsRename,
    (_e, payload) => {
      const room = rooms.get(String(payload?.roomId || ''))
      const name = String(payload?.name || '')
        .trim()
        .slice(0, 40)
      if (!room || !name) throw new Error('Nothing to rename.')
      if (room.stored.adminFriendId !== roomsIdentity().id) {
        throw new Error('Only the room admin can rename it.')
      }
      const oldCode = room.stored.code
      const recoded = withRoomName(oldCode, name)
      room.stored.name = name
      if (recoded) room.stored.code = recoded
      updateStoredRoom(oldCode, (stored) => {
        stored.name = name
        if (recoded) stored.code = recoded
      })
      // Straight away, not on the next interval — the person just typed it
      // and everyone in the room should see it before they look away.
      announceRoom(room)
      pushStatus()
      return { ok: true }
    }
  )

  handle<{ roomId?: string; sharing?: boolean }, { ok: true }>(
    MEDIA_HUB_CHANNELS.roomsSetSharing,
    (_e, payload) => {
      const room = rooms.get(String(payload?.roomId || ''))
      if (!room) throw new Error('No such room.')
      room.stored.sharing = payload?.sharing === true
      updateStoredRoom(room.stored.code, (stored) => {
        stored.sharing = payload?.sharing === true
      })
      // Announce straight away so turning sharing off withdraws what this
      // room already saw rather than leaving it visible for an interval.
      announceRoom(room)
      pushStatus()
      return { ok: true }
    }
  )

  handle<{ roomId?: string; message?: RoomMessage }, { ok: true }>(
    MEDIA_HUB_CHANNELS.roomsSend,
    (_e, payload) => {
      const room = rooms.get(String(payload?.roomId || ''))
      const message = payload?.message
      if (!room || !room.ws || !message) throw new Error('Not connected to that room.')
      // Stamped here rather than trusted from the renderer — and in a
      // signed room the stamp is then SIGNED, so it genuinely identifies
      // its sender rather than politely claiming to.
      const from = room.signed ? roomsIdentity().id : selfIdentity().friendId
      sendRoomPayload(room, { ...message, fromFriendId: from })
      return { ok: true }
    }
  )

  handle<{ activity?: RoomActivity | null }, { ok: true }>(
    MEDIA_HUB_CHANNELS.roomsSetActivity,
    (_e, payload) => {
      setRoomsActivity(payload?.activity ?? null)
      return { ok: true }
    }
  )

  // Removing a member — the one action here that takes something from
  // somebody, and the order inside it is the guarantee documented in
  // docs/ROOMS.md: the relay ban happens first and mints the new
  // joinSecret, so the re-key broadcast CANNOT precede it — the code it
  // broadcasts does not exist until the ban response arrives.
  handle<{ roomId?: string; friendId?: string }, { ok: true }>(
    MEDIA_HUB_CHANNELS.roomsKick,
    async (_e, payload) => {
      const room = rooms.get(String(payload?.roomId || ''))
      const target = String(payload?.friendId || '')
      if (!room || !target) throw new Error('No such room.')
      const selfId = roomsIdentity().id
      if (room.stored.adminFriendId !== selfId || !room.stored.roomToken) {
        throw new Error('Only the room admin can remove members.')
      }
      if (target === selfId) throw new Error('You cannot remove yourself — leave instead.')
      if (!room.stored.joinSecret) {
        throw new Error(
          'This room predates member removal. Make a new room to get it — or the relay server needs updating.'
        )
      }
      // The target IS the ban key: a member's id is the hash of their
      // public key, so the identity everyone sees, the identity the
      // relay admits, and the identity a kick names are one thing. No
      // history to reconstruct, no install the room ever saw that this
      // misses — every device of theirs speaks as this id or not at all.
      // The BARRIER is armed before the kick is sent, so the ban
      // announcement cannot slip past between the response and the
      // listener attaching.
      const banObserved = new Promise<void>((resolve) => {
        const waiters = room.banWaiters.get(target) ?? []
        waiters.push(resolve)
        room.banWaiters.set(target, waiters)
      })
      const response = await fetch(`${room.relayUrl}/party/${room.roomId}/kick`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomToken: room.stored.roomToken, memberIds: [target] })
      })
      if (!response.ok) {
        room.banWaiters.delete(target)
        throw new Error(`The relay refused the removal: ${response.status}`)
      }
      const { joinSecret } = (await response.json()) as { joinSecret: string }

      // WAIT TO SEE THE BAN before breathing a word of the new secret.
      // The kick's HTTP response and the relay's banned broadcast travel
      // on DIFFERENT connections, with no ordering between them — and if
      // this admin shares a cache hop with the kicked member, the re-key
      // below would be ECHOED LOCALLY by the daemon, off the relay path
      // entirely. Observing the ban on this room's own socket is the
      // proof that closes both: the daemon applies bans before it fans
      // the announcement, so by the time it reaches us here, the kicked
      // subscriber is already gone from the echo's audience. Every
      // relay-transported path was already safe by per-socket FIFO. The
      // timeout is a last resort for a broadcast lost in transit — the
      // rotation still protects every path except the shared-hop echo,
      // and waiting forever would wedge the kick.
      await Promise.race([banObserved, new Promise((resolve) => setTimeout(resolve, 5000))])
      room.banWaiters.delete(target)

      // They are banned, disconnected, and the ban is VISIBLY applied on
      // this member's own transport. NOW rotate the room secret and
      // hand the new code to everyone still here, under the old secret —
      // which the kicked member still knows but can no longer be present
      // to hear.
      const previous = room.secret
      const newSecret = crypto.randomBytes(24).toString('base64url')
      const identity = roomsIdentity()
      const newCode = encodeRoomShareCode({
        relay: { url: room.relayUrl, roomId: room.roomId },
        secret: newSecret,
        name: room.stored.name,
        admin: { id: identity.id, pub: identity.pub },
        join: joinSecret
      })
      // Signed (members verify it really is the admin rotating keys)
      // and transient (never retained by a hop). Members who miss it
      // are rescued by the returning-member hand-off the next time they
      // announce under the old secret.
      sendRoomPayload(
        room,
        { type: 'room-rekey', code: newCode },
        { transient: true, underSecret: previous }
      )
      const chain = [previous, ...(room.stored.prevSecrets ?? [])].slice(0, PREV_SECRETS_KEPT)
      // The rescue/presence gate for members a relay ban cannot reach
      // (a household hop's shared transport) — see rememberKicked.
      const kickedList = rememberKicked(room.stored.kickedFriendIds, target)
      room.secret = newSecret
      room.stored.code = newCode
      room.stored.joinSecret = joinSecret
      room.stored.prevSecrets = chain
      room.stored.kickedFriendIds = kickedList
      updateStoredRoomById(room, (stored) => {
        stored.code = newCode
        stored.joinSecret = joinSecret
        stored.prevSecrets = chain
        stored.kickedFriendIds = kickedList
      })
      room.presence.delete(target)
      pushStatus()
      return { ok: true }
    }
  )
}
