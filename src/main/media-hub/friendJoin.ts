// Consent and correlation for room join traffic ('friend-join-*' on the
// wire — see roomRules.ts on why the wire still says "friend").
//
// Everyone in a room holds the room secret and every member's id is in
// their presence announcements, so any member can address a join message
// to anyone (and, in the legacy unsigned room, claim any fromFriendId).
// Without a gate, that let a member pull someone into a party of the
// member's choosing (an unsolicited offer was joined on the spot) or make
// them host one — opening a listener and possibly a router port — and hand
// out the code (a request was answered automatically, with no prompt).
//
// This tracker is what main consults before anything reaches the renderer
// or the network:
//   - an incoming request is passed on only while this user shares their
//     activity — with sharing off it is dropped without a reply, so a
//     non-sharing member stays indistinguishable from one who isn't watching;
//   - an incoming offer or decline is passed on only if it answers a request
//     this device actually sent to that friend, matched by a random
//     requestId, once, within a short window;
//   - an outgoing offer or decline is sent only in answer to a request we
//     received and passed on, once.
// The renderer then asks the user before joining or hosting anything.
//
// No Electron imports, so the tests can load it directly.

import crypto from 'node:crypto'

/** Longer than the requester's own 20s give-up, so a slow answer the user
 *  accepted is not rejected for timing alone. */
export const FRIEND_JOIN_REQUEST_TTL_MS = 60_000
const MAX_TRACKED = 32
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/

interface Tracked {
  friendId: string
  requestId: string
  expiresAt: number
}

export interface FriendJoinMessageLike {
  type?: unknown
  fromFriendId?: unknown
  toFriendId?: unknown
  requestId?: unknown
}

function isJoinType(
  type: unknown
): type is 'friend-join-request' | 'friend-join-offer' | 'friend-join-declined' {
  return (
    type === 'friend-join-request' ||
    type === 'friend-join-offer' ||
    type === 'friend-join-declined'
  )
}

export class FriendJoinTracker {
  /** Requests we sent, keyed by the friend we asked. */
  private readonly outgoing = new Map<string, Tracked>()
  /** Requests we received and showed the user, keyed by requestId. */
  private readonly incoming = new Map<string, Tracked>()

  constructor(private readonly newRequestId: () => string = () => crypto.randomUUID()) {}

  private prune(now: number): void {
    for (const map of [this.outgoing, this.incoming]) {
      for (const [key, entry] of map) if (entry.expiresAt <= now) map.delete(key)
    }
  }

  /** Records a request we are about to send and returns the id to put in it. */
  startRequest(toFriendId: string, now = Date.now()): string {
    this.prune(now)
    const requestId = this.newRequestId()
    this.outgoing.set(toFriendId, {
      friendId: toFriendId,
      requestId,
      expiresAt: now + FRIEND_JOIN_REQUEST_TTL_MS
    })
    return requestId
  }

  cancelRequest(toFriendId: string): void {
    this.outgoing.delete(toFriendId)
  }

  /** Should this decrypted, addressed-to-us message reach the renderer? */
  acceptIncoming(
    msg: FriendJoinMessageLike,
    context: { selfFriendId: string; sharing: boolean; now?: number }
  ): boolean {
    const now = context.now ?? Date.now()
    this.prune(now)
    if (!isJoinType(msg.type) || msg.toFriendId !== context.selfFriendId) return false
    const from = typeof msg.fromFriendId === 'string' ? msg.fromFriendId : ''
    const requestId = typeof msg.requestId === 'string' ? msg.requestId : ''
    if (!from || from === context.selfFriendId || !REQUEST_ID_PATTERN.test(requestId)) return false

    if (msg.type === 'friend-join-request') {
      // Sharing off: no prompt, and no reply of any kind.
      if (!context.sharing) return false
      if (this.incoming.has(requestId)) return false
      if (this.incoming.size >= MAX_TRACKED) return false
      this.incoming.set(requestId, {
        friendId: from,
        requestId,
        expiresAt: now + FRIEND_JOIN_REQUEST_TTL_MS
      })
      return true
    }

    // Offer or decline: only as the answer to our own outstanding request
    // to exactly this friend, and only once.
    const pending = this.outgoing.get(from)
    if (!pending || pending.requestId !== requestId) return false
    this.outgoing.delete(from)
    return true
  }

  /** May we send this offer/decline? Only as a single answer to a request we
   *  received from that friend. Requests themselves are always allowed. */
  authorizeReply(msg: FriendJoinMessageLike, now = Date.now()): boolean {
    this.prune(now)
    if (msg.type !== 'friend-join-offer' && msg.type !== 'friend-join-declined') return false
    const requestId = typeof msg.requestId === 'string' ? msg.requestId : ''
    const entry = this.incoming.get(requestId)
    if (!entry || entry.friendId !== msg.toFriendId) return false
    this.incoming.delete(requestId)
    return true
  }

  clear(): void {
    this.outgoing.clear()
    this.incoming.clear()
  }
}
