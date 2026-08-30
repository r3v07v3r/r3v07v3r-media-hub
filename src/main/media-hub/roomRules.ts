// The decisions in the rooms system that are worth pinning, with no
// database, network or Electron in reach — the same split watchlistRules
// has, for the same reason: rooms.ts is mostly sockets and timers, and
// what actually decides who appears, who is believed, and what survives a
// migration is the handful of functions here.
//
// WIRE COMPATIBILITY, stated once: the message types on the wire are
// still 'friend-presence' and 'friend-join-*'. A member running the app
// from before rooms existed is sitting in the migrated room speaking that
// dialect, and renaming the wire would silently split the room into two
// populations that cannot see each other. Only the TypeScript names moved.

import type { RoomActivity, RoomMemberPresence } from '../../shared/media-hub/types'

/** A member not heard from within this window is dropped from the local
 *  view. Comfortably more than two announce intervals, so a single lost
 *  message or a brief stall never makes someone flicker offline. */
export const PRESENCE_TTL_MS = 70_000

/** How often each member re-announces itself. Frequent enough that a new
 *  arrival sees everyone quickly, rare enough to be irrelevant for both
 *  bandwidth and Durable Object wake-ups. */
export const ANNOUNCE_INTERVAL_MS = 20_000

export interface PresenceRecord extends RoomMemberPresence {
  lastSeen: number
}

/**
 * Folds one decrypted presence announcement into a room's view.
 *
 * `ageMs` is non-zero only for state REPLAYED by the relay on connect
 * (room.ts's `retained` envelope): it is subtracted from lastSeen so the
 * TTL still measures how long ago the member actually spoke — a
 * nine-minute-old replay must not reset their clock as if it were fresh.
 *
 * Returns whether this sender was previously unknown, which is what
 * triggers the reply-to-newcomer that spares a joiner staring at an
 * empty room for an announce interval — but only for LIVE messages:
 * replaying retained state describes members who are not newcomers.
 */
export function recordPresence(
  presence: Map<string, PresenceRecord>,
  msg: Record<string, unknown>,
  selfFriendId: string,
  now: number,
  ageMs = 0
): { changed: boolean; isNewcomer: boolean } {
  const friendId = String(msg.friendId || '')
  if (!friendId || friendId === selfFriendId) return { changed: false, isNewcomer: false }
  const isNewcomer = !presence.has(friendId) && ageMs === 0
  const activity = (msg.activity as RoomActivity | undefined) || null
  presence.set(friendId, {
    friendId,
    name: String(msg.name || 'Someone').slice(0, 40),
    activity: activity
      ? {
          mediaId: String(activity.mediaId || ''),
          kind: String(activity.kind || 'movie'),
          title: String(activity.title || '').slice(0, 120),
          poster: String(activity.poster || '').slice(0, 500),
          position: Number(activity.position) || 0,
          paused: activity.paused === true,
          partyCode: activity.partyCode ? String(activity.partyCode).slice(0, 400) : undefined
        }
      : null,
    lastSeen: now - Math.max(0, ageMs)
  })
  return { changed: true, isNewcomer }
}

/** Drops everyone the TTL has expired. Returns whether anything left. */
export function reapPresence(presence: Map<string, PresenceRecord>, now: number): boolean {
  let changed = false
  for (const [id, record] of presence) {
    if (now - record.lastSeen > PRESENCE_TTL_MS) {
      presence.delete(id)
      changed = true
    }
  }
  return changed
}

/**
 * Whether an announced room name is believed.
 *
 * The admin's identity is the one baked into the invite code everyone
 * joined with — not anything the relay says, and not anything a message
 * claims about itself beyond its friendId. A room with no admin (the
 * migrated legacy group, or one joined by a v2 code) keeps whatever name
 * it has: nobody has the standing to rename it for everyone else.
 *
 * Within-room spoofing of a friendId is possible for anyone holding the
 * room secret. That is a name badge among friends, not a security
 * boundary, and docs/ROOMS.md says so rather than this code pretending
 * otherwise.
 */
export function acceptRoomName(
  currentName: string,
  announcedName: unknown,
  senderFriendId: string,
  adminFriendId: string | undefined
): string {
  if (!adminFriendId || senderFriendId !== adminFriendId) return currentName
  const proposed = String(announcedName ?? '').slice(0, 40)
  return proposed.trim() ? proposed : currentName
}

/** The persisted shape of one room membership. */
export interface StoredRoom {
  /** The invite code — carries relay endpoint, secret, name, admin. */
  code: string
  /** Display name; starts from the code, follows admin renames. */
  name: string
  /** Whether THIS device publishes its activity into this room. */
  sharing: boolean
  /** The creator's friendId, from the invite code. Absent for rooms that
   *  predate admins — which simply have none. */
  adminFriendId?: string
  /** The relay's host token, held only by the creator. Kept because it is
   *  the credential the worker-side kick will require; unused until then. */
  roomToken?: string
}

/**
 * Migrates the single pre-rooms friends group into the rooms list.
 *
 * The old group's creator token was deliberately discarded at creation
 * (a friends group was host-less by design), so the migrated room has NO
 * admin — that is the truth of it, not a defect to invent an admin for.
 * The old global sharing flag becomes this room's per-room setting, so
 * nobody's opt-in or opt-out changes meaning during the upgrade.
 */
export function migrateLegacyRooms(settings: {
  rooms?: StoredRoom[]
  friendsGroupCode?: string
  friendsShareActivity?: boolean
}): { rooms: StoredRoom[]; changed: boolean } {
  const rooms = Array.isArray(settings.rooms) ? [...settings.rooms] : []
  const legacy = settings.friendsGroupCode
  if (!legacy) return { rooms, changed: false }
  if (rooms.some((room) => room.code === legacy)) return { rooms, changed: false }
  rooms.push({
    code: legacy,
    name: 'Friends',
    sharing: settings.friendsShareActivity === true
  })
  return { rooms, changed: true }
}
