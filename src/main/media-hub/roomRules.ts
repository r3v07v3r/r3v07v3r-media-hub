// The decisions in the rooms system that are worth pinning, with no
// database, network or Electron in reach — the same split watchlistRules
// has, for the same reason: rooms.ts is mostly sockets and timers, and
// what actually decides who appears, who is believed, what a re-key may
// change, and what survives a migration is the handful of functions
// here. (party.ts is the one import with code in it, and it is pure
// crypto and validation — nothing here touches a socket or a store.)
//
// WIRE COMPATIBILITY, stated once: the message types on the wire are
// still 'friend-presence' and 'friend-join-*'. A member running the app
// from before rooms existed is sitting in the migrated room speaking that
// dialect, and renaming the wire would silently split the room into two
// populations that cannot see each other. Only the TypeScript names moved.

import { decodeShareCode } from './party'
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
  /** sha256 of every relay memberKey this person's announcements have
   *  carried — accumulated, not replaced, because one person is several
   *  installs and kicking them means kicking all the room has seen.
   *  HASHES on purpose: the raw key is a bearer credential between one
   *  install and the relay, and broadcasting it would hand every member
   *  (including one about to be kicked) someone else's door pass. */
  memberKeyHashes: string[]
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
  const memberKeyHashes = [...(presence.get(friendId)?.memberKeyHashes ?? [])]
  const announcedHash =
    typeof msg.memberKeyHash === 'string' && /^[0-9a-f]{64}$/.test(msg.memberKeyHash)
      ? msg.memberKeyHash
      : ''
  if (announcedHash && !memberKeyHashes.includes(announcedHash)) memberKeyHashes.push(announcedHash)
  presence.set(friendId, {
    friendId,
    memberKeyHashes,
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

/**
 * Whether — and how — a room-rekey message is believed.
 *
 * A re-key replaces the room's secret and invite code, which makes it
 * the most powerful message on the channel: accepted carelessly it could
 * move members onto an attacker's secret or into a different room
 * entirely. Three conditions, each closing a specific door:
 *
 *  1. Only the ADMIN's friendId is believed. (Within-room spoofing by
 *     secret-holders remains possible and is a documented trust
 *     boundary — see docs/ROOMS.md — but a random member's client must
 *     still refuse to originate one.)
 *  2. The new code must be for THE SAME ROOM — and a room's identity is
 *     its relay URL AND its roomId. Same UUID on a different relay is
 *     still a relocation: the id namespace belongs to the relay, and a
 *     code pointing elsewhere would quietly move every copied invite
 *     (and, after restart, this client) onto a server of the sender's
 *     choosing.
 *  3. The new code must name THE SAME ADMIN. There is no admin handoff
 *     by message; a code that says otherwise is not this room's.
 *
 * Returns what to adopt, or null to ignore the message entirely.
 */
export function applyRekey(
  room: { roomId: string; relayUrl: string; adminFriendId?: string },
  msg: Record<string, unknown>,
  senderFriendId: string
): { code: string; secret: string; joinSecret?: string; name: string } | null {
  if (!room.adminFriendId || senderFriendId !== room.adminFriendId) return null
  const code = typeof msg.code === 'string' ? msg.code : ''
  const parsed = decodeShareCode(code)
  if (!parsed || parsed.v !== 3) return null
  if (parsed.relay.roomId !== room.roomId) return null
  if (parsed.relay.url !== room.relayUrl) return null
  if (parsed.adminFriendId !== room.adminFriendId) return null
  return { code, secret: parsed.secret, joinSecret: parsed.join, name: parsed.name }
}

/** Caps for the persisted per-room identity history. Generous for any
 *  real friends group, bounded so a hostile member cannot grow the
 *  settings file without limit. */
export const SEEN_MEMBERS_MAX_PEOPLE = 64
export const SEEN_HASHES_PER_PERSON = 8

/**
 * Folds a newly announced identity hash into the room's persisted
 * history, or returns null when nothing changed.
 *
 * Persisted — not read from live presence — because presence is soft
 * state with a 70-second TTL, and a kick has to name every install the
 * room has EVER seen for a person. Review found the ephemeral version's
 * hole: let someone's record age out, kick them when one install
 * returns, and their other install's key is never banned — still known
 * to the relay, admitted despite the rotated joinSecret.
 */
export function rememberSeenMember(
  seen: Readonly<Record<string, string[]>> | undefined,
  friendId: string,
  hash: string
): Record<string, string[]> | null {
  if (!friendId || !/^[0-9a-f]{64}$/.test(hash)) return null
  const existing = seen?.[friendId] ?? []
  if (existing.includes(hash)) return null
  const next: Record<string, string[]> = { ...(seen ?? {}) }
  if (!next[friendId] && Object.keys(next).length >= SEEN_MEMBERS_MAX_PEOPLE) return null
  // Oldest first out. A person cycling past the cap can shed history,
  // but each shed key was registered at the relay under a joinSecret
  // that has since rotated at every kick — the residual is bounded and
  // named in docs/ROOMS.md rather than pretended away.
  next[friendId] = [...existing, hash].slice(-SEEN_HASHES_PER_PERSON)
  return next
}

/** Every identity hash the room has seen for one person — the union of
 *  live presence and the persisted history. What a kick names. */
export function memberHashesFor(
  presence: ReadonlyMap<string, PresenceRecord>,
  seen: Readonly<Record<string, string[]>> | undefined,
  friendId: string
): string[] {
  const out = [...(seen?.[friendId] ?? [])]
  for (const hash of presence.get(friendId)?.memberKeyHashes ?? []) {
    if (!out.includes(hash)) out.push(hash)
  }
  return out
}

/**
 * Re-encodes an invite code with a new display name, changing NOTHING
 * else — every other field, including ones this version of the app does
 * not know about, passes through verbatim.
 *
 * Exists because the name lives in two places: the stored display name,
 * which renames update, and the invite code, which is what gets copied
 * and handed to the next member. Left unrecoded, an invite copied after
 * a rename carries the old name — and if the admin is offline when the
 * newcomer joins, no announcement ever corrects it. Every member holds
 * every field of the code they joined with, so every member can recode
 * their own copy when a rename reaches them.
 *
 * Returns null for anything that does not decode as a room code; the
 * caller keeps the code it has, which is always safer than writing one
 * this function could not read.
 */
export function withRoomName(code: string, name: string): string | null {
  const parsed = decodeShareCode(code)
  if (!parsed || parsed.v === 1) return null
  try {
    const raw = JSON.parse(Buffer.from(code, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    raw.name = String(name).slice(0, 40)
    return Buffer.from(JSON.stringify(raw), 'utf8').toString('base64url')
  } catch {
    return null
  }
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
  /** The relay's host token, held only by the creator — the credential
   *  the relay's kick endpoint requires. */
  roomToken?: string
  /** This install's relay identity in the room. Generated on create or
   *  join of a membership room; announced so others can name it in a
   *  kick. */
  memberKey?: string
  /** The relay's admission ticket, from the invite code. Only strangers
   *  need it — a known memberKey is admitted without — but it is kept
   *  current so re-shares of OUR copy of the code stay valid. */
  joinSecret?: string
  /** The secrets this room used before its re-keys, newest first and
   *  bounded (see PREV_SECRETS_KEPT). Kept for one purpose: recognising
   *  and rescuing a member who slept through rotations — possibly more
   *  than one; a single slot left anyone offline through two kicks an
   *  unreadable ghost forever. Never handed to anyone the relay would
   *  refuse. */
  prevSecrets?: string[]
  /** friendId -> sha256 of every relay identity their announcements have
   *  carried. Persisted so a kick can name installs the room saw last
   *  month, not just in the last 70 seconds — see rememberSeenMember. */
  seenMembers?: Record<string, string[]>
}

/** How many old room secrets a member keeps. Each kick pushes one; five
 *  covers anyone offline through five consecutive kicks, and a room that
 *  kicks more often than a straggler reconnects has bigger problems —
 *  the admin can always hand them the fresh code by hand. */
export const PREV_SECRETS_KEPT = 5

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
