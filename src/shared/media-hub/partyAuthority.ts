// Who may send what in a watch party.
//
// A party has exactly one authority: the host. Every member holds the same
// party secret, so "it decrypted" proves only "a member sent it" — never
// "the host sent it". Authority therefore has to come from WHERE a frame
// arrived, and every receiver has to check it:
//
//   - direct mode: a client has a single socket, to the host. Frames the
//     host originates carry no `from`; frames it forwards on a member's
//     behalf (including relay members it bridges across) are stamped with
//     that member's id in `from`.
//   - relay mode: the relay stamps every envelope with `isHost`, taken from
//     the host's room token, so a member cannot claim it. The hybrid host
//     also bridges DIRECT members' frames onto the relay, and those arrive
//     with isHost=true — so on a host envelope the `from` stamp decides too.
//
// This module is the single policy table both main (before anything is
// forwarded or emitted) and the renderer (defence in depth, before anything
// drives the player) consult. It has no Electron or Node dependencies so the
// tests can load it directly.

/** Only the host may originate these. A copy from anyone else is dropped,
 *  never applied and never forwarded. ('queue-sync' is a legacy type no
 *  current build sends; it stays here so a forged one is never applied.) */
export const HOST_ONLY_PARTY_TYPES: ReadonlySet<string> = new Set([
  'welcome',
  'party-state',
  'queue-sync',
  'nowPlaying',
  'preparing',
  'preparing-cancelled',
  'seek-sync',
  'seek-waiting',
  'seek-go',
  'position'
])

/** Playback control a member may use only while the host has switched on
 *  "anyone can control playback". */
export const MEMBER_CONTROL_PARTY_TYPES: ReadonlySet<string> = new Set(['play', 'pause', 'seek'])

/** Things any member may send to the host about itself. They carry no
 *  authority over anyone else's player. 'resync-request' asks the host to
 *  replay its own stored nowPlaying ("Join the film") and 'watching' is a
 *  member's presence report. The legacy queue types (suggest, vote,
 *  play-request) are not listed: current builds drop them, so they are
 *  treated like any other unknown type. */
export const MEMBER_PARTY_TYPES: ReadonlySet<string> = new Set([
  'hello',
  'leave',
  'chat',
  'watching',
  'ready',
  'resync-request'
])

export type PartySenderRole = 'host' | 'member'

function typeOf(message: unknown): string {
  const type = (message as { type?: unknown } | null | undefined)?.type
  return typeof type === 'string' ? type : ''
}

/** Host side: may the host act on this frame from a member? Unknown types are
 *  dropped rather than passed through. */
export function hostAcceptsFromMember(message: unknown, allowMemberControl: boolean): boolean {
  const type = typeOf(message)
  if (!type || HOST_ONLY_PARTY_TYPES.has(type)) return false
  if (MEMBER_CONTROL_PARTY_TYPES.has(type)) return allowMemberControl
  return MEMBER_PARTY_TYPES.has(type)
}

/** Host: should a member's frame be re-sent to the other members? Only
 *  playback control, and only while the host allows it. Chat is forwarded
 *  separately as a host-built message, and everything else is the host's
 *  own business (roster, presence, resync, ready). */
export function hostShouldForwardMemberMessage(
  message: unknown,
  allowMemberControl: boolean
): boolean {
  return allowMemberControl && MEMBER_CONTROL_PARTY_TYPES.has(typeOf(message))
}

/** Client side: may a non-host member act on this frame?
 *
 *  `allowMemberControl` must be the value the HOST last published — the
 *  receiver only ever updates it from host-originated party-state. */
export function clientAcceptsPartyMessage(
  message: unknown,
  sender: PartySenderRole,
  allowMemberControl: boolean
): boolean {
  const type = typeOf(message)
  if (!type) return false
  if (sender === 'host') return true
  if (HOST_ONLY_PARTY_TYPES.has(type)) return false
  if (MEMBER_CONTROL_PARTY_TYPES.has(type)) return allowMemberControl
  // Chat is the one member message every client displays. The rest
  // (presence, resync, ready, hello/leave) are meant for the host.
  return type === 'chat'
}

/** Direct mode: who a frame on the client's socket really came from. The
 *  host stamps `from` on everything it forwards for a member and never on
 *  what it originates itself. */
export function directSenderOf(message: unknown): PartySenderRole {
  const from = (message as { from?: unknown } | null | undefined)?.from
  return from === undefined || from === null || from === '' ? 'host' : 'member'
}

/** Relay mode: a frame is the host's only if the relay says it came from
 *  the host's connection AND the host did not stamp it as forwarded for a
 *  (direct) member. A non-host envelope is a member, whatever it claims. */
export function relaySenderOf(envelopeIsHost: unknown, message: unknown): PartySenderRole {
  return envelopeIsHost === true ? directSenderOf(message) : 'member'
}

/** Renderer side: `event.from` is 'host' for host-originated frames and a
 *  member id otherwise (see sendPartyEvent in watchParty.ts). */
export function partyEventSender(from: unknown): PartySenderRole {
  return from === 'host' ? 'host' : 'member'
}
