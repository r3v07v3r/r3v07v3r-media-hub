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

import { decodeShareCode, encodeRoomShareCode } from './party'
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
  /** The sender's identity, as the CALLER established it: the verified
   *  signature's id in a signed room, the claimed friendId in the one
   *  legacy room. What used to be a per-message claim is a parameter
   *  precisely so this function cannot be handed an unverified one by
   *  accident — there is no msg.friendId to fall back to. */
  from: string,
  msg: Record<string, unknown>,
  selfFriendId: string,
  now: number,
  ageMs = 0
): { changed: boolean; isNewcomer: boolean } {
  const friendId = from
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
          // Optional on the wire (older builds don't send it); a non-finite
          // or non-positive claim reads as absent rather than as a zero
          // that would make every percentage division blow up downstream.
          duration:
            Number.isFinite(Number(activity.duration)) && Number(activity.duration) > 0
              ? Number(activity.duration)
              : undefined,
          paused: activity.paused === true,
          // 600, not 400: a hybrid invite (direct + relay endpoints in one
          // code — see party.ts's encodeHybridShareCode) runs longer than
          // the single-transport codes this clamp was sized for.
          partyCode: activity.partyCode ? String(activity.partyCode).slice(0, 600) : undefined
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
 * The relay's ban announcement, parsed — `{type:'banned', hashes:[ids]}`
 * — or null for anything else. Read by the kick flow's BARRIER: the
 * admin must OBSERVE the ban on its own room socket before broadcasting
 * the re-key, because the kick's HTTP response and the ban's WebSocket
 * frame travel on different connections with no ordering between them.
 * On a shared hop, observing the ban proves the daemon has already
 * applied it (it applies before it fans), which is exactly what makes
 * the local re-key echo safe.
 */
export function parseBannedEnvelope(text: string): string[] | null {
  try {
    const envelope = JSON.parse(text) as { type?: string; hashes?: unknown }
    if (envelope.type !== 'banned' || !Array.isArray(envelope.hashes)) return null
    return envelope.hashes.filter(
      (hash): hash is string => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)
    )
  } catch {
    return null
  }
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
  /** The VERIFIED sender — in a signed room this came out of a
   *  signature check, so "only the admin is believed" is cryptographic
   *  here, not a claim about a claim. */
  senderFriendId: string
): { code: string; secret: string; joinSecret?: string; name: string } | null {
  if (!room.adminFriendId || senderFriendId !== room.adminFriendId) return null
  const code = typeof msg.code === 'string' ? msg.code : ''
  const parsed = decodeShareCode(code)
  if (!parsed || parsed.v !== 4) return null
  if (parsed.relay.roomId !== room.roomId) return null
  if (parsed.relay.url !== room.relayUrl) return null
  if (parsed.admin.id !== room.adminFriendId) return null
  return { code, secret: parsed.secret, joinSecret: parsed.join, name: parsed.name }
}

/** How many kicked identities a room remembers. Bounds a hostile admin
 *  growing the settings file; a real room never approaches it. */
export const KICKED_MEMBERS_KEPT = 64

/**
 * Records a removal the admin performed, bounded and idempotent.
 *
 * The list exists for one gate: a KICKED friendId speaking an OLD
 * secret gets no presence row and, above all, no rescue. Without it the
 * rescue would undo the kick for anyone whose transport the relay ban
 * cannot reach (a member behind a household hop): they still hold the
 * old secret, announce under it, and the admin would helpfully hand
 * them the new code.
 */
export function rememberKicked(kicked: readonly string[] | undefined, friendId: string): string[] {
  const list = [...(kicked ?? [])]
  if (friendId && !list.includes(friendId)) list.push(friendId)
  return list.slice(-KICKED_MEMBERS_KEPT)
}

/**
 * Re-encodes an invite code with a new display name, changing nothing
 * else.
 *
 * It decodes and re-encodes through the typed codec rather than editing
 * the code's bytes. The old JSON form let this pass unknown fields
 * through verbatim; the packed form has no room for a field it cannot
 * name, so a code is now rebuilt from exactly what the decoder
 * understood — and a code that does not fully decode is not rewritten
 * at all.
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
  // Only a room code carries a name to change. A relay PARTY code has no
  // name field at all, so there is nothing here to rename.
  if (!parsed || parsed.v !== 4) return null
  try {
    return encodeRoomShareCode({
      relay: parsed.relay,
      secret: parsed.secret,
      name: String(name).slice(0, 40),
      admin: parsed.admin,
      ...(parsed.join ? { join: parsed.join } : {})
    })
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
  /** The admin's raw public key (base64url), from the invite code — what
   *  turns their renames and re-keys into verifiable statements. Absent
   *  on the legacy room, which has no admin at all. */
  adminPub?: string
  /** The relay's admission ticket, from the invite code. Only strangers
   *  need it — a known identity taps in without — but it is kept
   *  current so re-shares of OUR copy of the code stay valid. */
  joinSecret?: string
  /** The secrets this room used before its re-keys, newest first and
   *  bounded (see PREV_SECRETS_KEPT). Kept for one purpose: recognising
   *  and rescuing a member who slept through rotations — possibly more
   *  than one; a single slot left anyone offline through two kicks an
   *  unreadable ghost forever. Never handed to anyone the relay would
   *  refuse. */
  prevSecrets?: string[]
  /** friendIds this admin removed — the rescue and presence gate for
   *  members whose transport a relay ban cannot reach. Admin-side only;
   *  see rememberKicked. */
  kickedFriendIds?: string[]
}

/** How many old room secrets a member keeps. Each kick pushes one; five
 *  covers anyone offline through five consecutive kicks, and a room that
 *  kicks more often than a straggler reconnects has bigger problems —
 *  the admin can always hand them the fresh code by hand. */
export const PREV_SECRETS_KEPT = 5
