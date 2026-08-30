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
import type WebSocket from 'ws'

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
import { partySyncCredentials, readSettings, writeSettings } from './settingsStore'
import { connectRelayWs } from './watchParty'

/** Reconnect backoff bounds. A room is meant to be always-on, so a
 *  dropped socket retries indefinitely rather than giving up — but it
 *  backs off so a worker outage doesn't turn every client into a hot
 *  loop. Per room: one struggling room must not delay another's socket. */
const RECONNECT_MIN_MS = 3_000
const RECONNECT_MAX_MS = 120_000

interface RoomState {
  roomId: string
  stored: StoredRoom
  relayUrl: string
  secret: string
  ws: WebSocket | null
  presence: Map<string, PresenceRecord>
  reconnectTimer: ReturnType<typeof setTimeout> | null
  reconnectDelay: number
  replyTimer: ReturnType<typeof setTimeout> | null
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

function pushStatus(): void {
  sendToRenderer(MEDIA_HUB_CHANNELS.roomsEvent, roomsStatus())
}

export function roomsStatus(): RoomsStatus {
  const { friendId } = selfIdentity()
  const now = Date.now()
  const views: RoomView[] = [...rooms.values()].map((room) => ({
    roomId: room.roomId,
    name: room.stored.name,
    code: room.stored.code,
    connected: room.ws !== null,
    isAdmin: Boolean(room.stored.adminFriendId && room.stored.adminFriendId === friendId),
    hasAdmin: Boolean(room.stored.adminFriendId),
    sharing: room.stored.sharing,
    members: [...room.presence.values()]
      .filter((record) => now - record.lastSeen <= 70_000)
      .map((record) => ({
        friendId: record.friendId,
        name: record.name,
        activity: record.activity
      }))
  }))
  return { selfId: friendId, rooms: views }
}

function announceRoom(room: RoomState): void {
  if (!room.ws) return
  const { friendId, name } = selfIdentity()
  // Sharing off means the field is absent entirely, not null-with-a-flag:
  // "not sharing" and "not watching" should be indistinguishable to
  // everyone else.
  const payload: Record<string, unknown> = {
    type: 'friend-presence',
    friendId,
    name
  }
  if (room.stored.sharing && currentActivity) payload.activity = currentActivity
  // The room's name travels with its admin: renames reach members through
  // the same channel as everything else, and the rename rule on the
  // receiving side only believes this field from the admin's friendId.
  if (room.stored.adminFriendId === friendId) payload.roomName = room.stored.name
  try {
    room.ws.send(encryptMessage(room.secret, payload))
  } catch {
    // A send failure is handled by the socket's own close/error path.
  }
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
  const msg = decryptMessage(room.secret, body) as Record<string, unknown> | null
  if (!msg) return
  const { friendId } = selfIdentity()
  if (msg.type === 'friend-presence') {
    const senderId = String(msg.friendId || '')
    const { changed, isNewcomer } = recordPresence(room.presence, msg, friendId, Date.now(), ageMs)
    if (isNewcomer) replyToNewcomer(room)
    // The admin's announcements carry the room's name — see announceRoom.
    const renamed = acceptRoomName(
      room.stored.name,
      msg.roomName,
      senderId,
      room.stored.adminFriendId
    )
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
    msg.toFriendId === friendId
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

async function openSocket(room: RoomState): Promise<void> {
  if (room.closing) return
  const ws = await connectRelayWs(room.relayUrl, room.roomId, {})
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
 *  for a room already active is a no-op, not a second socket. */
async function activateRoom(stored: StoredRoom): Promise<void> {
  const parsed = decodeShareCode(stored.code)
  if (!parsed || parsed.v === 1) throw new Error('That is not a valid room code.')
  if (rooms.has(parsed.relay.roomId)) return
  const room: RoomState = {
    roomId: parsed.relay.roomId,
    stored,
    relayUrl: parsed.relay.url,
    secret: parsed.secret,
    ws: null,
    presence: new Map(),
    reconnectTimer: null,
    reconnectDelay: RECONNECT_MIN_MS,
    replyTimer: null,
    closing: false
  }
  rooms.set(room.roomId, room)
  ensureTimers()
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
      const response = await fetch(`${creds.url}/host`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inviteKey: creds.inviteKey })
      })
      if (!response.ok) throw new Error(`The party-sync worker refused: ${response.status}`)
      const { roomId, roomToken } = (await response.json()) as {
        roomId: string
        roomToken: string
      }
      const { friendId } = selfIdentity()
      const secret = crypto.randomBytes(24).toString('base64url')
      const name =
        String(payload?.name || '')
          .trim()
          .slice(0, 40) || 'A room'
      // The admin is named in the code itself, so every member can agree
      // who it is offline. The roomToken is kept but NOT in the code —
      // it is the creator's credential, and the code is handed to
      // everyone.
      const code = encodeRoomShareCode({
        relay: { url: creds.url, roomId },
        secret,
        name,
        adminFriendId: friendId
      })
      const stored: StoredRoom = { code, name, sharing: false, adminFriendId: friendId, roomToken }
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
    const stored: StoredRoom = {
      code,
      // A v2 code is the old friends-group kind and carries no name; the
      // migration calls that room "Friends", so a member joining by its
      // original code must land on the SAME label — a v2 room has no
      // admin, so no announcement could ever reconcile a different one.
      name: (parsed.name || '').trim() || (parsed.v === 2 ? 'Friends' : 'A room'),
      sharing: false,
      // A v2 code predates admins; the room it joins simply has none.
      adminFriendId: parsed.v === 3 ? parsed.adminFriendId : undefined
    }
    await activateRoom(stored)
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
      const { friendId } = selfIdentity()
      if (room.stored.adminFriendId !== friendId) {
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
      const { friendId } = selfIdentity()
      // Stamped here rather than trusted from the renderer, so a message
      // always genuinely identifies its sender.
      room.ws.send(encryptMessage(room.secret, { ...message, fromFriendId: friendId }))
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
}
