// The rooms system's judgements, pinned without a relay in reach.
//
// rooms.ts is sockets and timers around a handful of decisions, and the
// decisions are what would misbehave quietly: a stale replay resurrecting
// someone who left, a non-admin renaming the family room, a migration
// that duplicates the legacy group on every boot, an old code refusing to
// decode. Those live in roomRules.ts and party.ts precisely so this file
// can reach them.

import assert from 'node:assert/strict'

import {
  decodeShareCode,
  encodeRelayShareCode,
  encodeRoomShareCode
} from '../src/main/media-hub/party'
import {
  PRESENCE_TTL_MS,
  acceptRoomName,
  applyRekey,
  parseBannedEnvelope,
  migrateLegacyRooms,
  reapPresence,
  recordPresence,
  withRoomName,
  type PresenceRecord
} from '../src/main/media-hub/roomRules'
import {
  CRYPTOGRAM_FRESHNESS_MS,
  generateIdentity,
  idOfRawPub,
  mintCryptogram,
  nextSeq,
  signRoomMessage,
  verifyCryptogram,
  verifyRoomMessage
} from '../src/main/media-hub/roomIdentity'

const now = 1_800_000_000_000
const SELF = 'self-friend-id'

// --- presence ---------------------------------------------------------------

{
  const presence = new Map<string, PresenceRecord>()
  const live = recordPresence(presence, 'a', { name: 'Ana' }, SELF, now)
  assert.equal(live.changed, true)
  assert.equal(live.isNewcomer, true, 'a live first announcement is a newcomer')
  assert.equal(presence.get('a')?.lastSeen, now)

  // Our own announcement echoing back must never appear as a member.
  const self = recordPresence(presence, SELF, { name: 'Me' }, SELF, now)
  assert.equal(self.changed, false, 'self is not a member of the view')

  // Retained replay: the relay held this for ageMs, so the member spoke
  // that long ago — and a replayed stranger is NOT a newcomer, or every
  // reconnect would trigger a chorus of replies to people who are not new.
  const replay = recordPresence(presence, 'b', { name: 'Ben' }, SELF, now, 9 * 60_000)
  assert.equal(replay.isNewcomer, false, 'a replayed member is not a newcomer')
  assert.equal(presence.get('b')?.lastSeen, now - 9 * 60_000, 'replay is backdated by its age')

  // The backdated member ages out on the same clock as everyone else. A
  // 9-minute-old replay is far past the TTL: reaping now must drop them,
  // or a ghost sits in the room for a full TTL after every reconnect.
  assert.equal(reapPresence(presence, now + 1), true)
  assert.equal(presence.has('b'), false, 'a stale replay does not resurrect a member')
  assert.equal(presence.has('a'), true, 'a live member survives the same reap')

  assert.equal(reapPresence(presence, now + PRESENCE_TTL_MS + 1), true)
  assert.equal(presence.size, 0, 'silence past the TTL ages everyone out')
}

// --- the rename rule --------------------------------------------------------

{
  const ADMIN = 'admin-id'
  assert.equal(
    acceptRoomName('Family', 'Movie night', ADMIN, ADMIN),
    'Movie night',
    'the admin renames the room'
  )
  assert.equal(
    acceptRoomName('Family', 'Hacked', 'someone-else', ADMIN),
    'Family',
    'nobody else does'
  )
  assert.equal(
    acceptRoomName('Family', 'New name', ADMIN, undefined),
    'Family',
    'a room with no admin keeps its name — nobody has the standing'
  )
  assert.equal(
    acceptRoomName('Family', '   ', ADMIN, ADMIN),
    'Family',
    'a blank rename is not a rename'
  )
}

// --- migration of the single pre-rooms friends group ------------------------

{
  const migrated = migrateLegacyRooms({
    friendsGroupCode: 'legacy-code',
    friendsShareActivity: true
  })
  assert.equal(migrated.changed, true)
  assert.equal(migrated.rooms.length, 1)
  assert.equal(migrated.rooms[0].code, 'legacy-code')
  assert.equal(migrated.rooms[0].name, 'Friends')
  assert.equal(migrated.rooms[0].sharing, true, 'the global opt-in becomes the room setting')
  assert.equal(
    migrated.rooms[0].adminFriendId,
    undefined,
    'the legacy group has no admin — its creator token was discarded by design'
  )

  // Running again against the already-migrated list adds nothing: the
  // migration deletes the legacy field, but a crash between the two
  // writes must not seed a duplicate room on the next boot.
  const again = migrateLegacyRooms({
    rooms: migrated.rooms,
    friendsGroupCode: 'legacy-code',
    friendsShareActivity: true
  })
  assert.equal(again.changed, false, 'migration is idempotent')
  assert.equal(again.rooms.length, 1)

  const fresh = migrateLegacyRooms({})
  assert.equal(fresh.changed, false)
  assert.deepEqual(fresh.rooms, [], 'nothing to migrate migrates nothing')
}

// --- room invite codes ------------------------------------------------------

{
  const relay = { url: 'https://relay.example.workers.dev', roomId: crypto.randomUUID() }
  const admin = generateIdentity()
  const code = encodeRoomShareCode({
    relay,
    secret: 'room-secret',
    name: 'Family',
    admin: { id: admin.id, pub: admin.pub }
  })
  const decoded = decodeShareCode(code)
  assert.ok(decoded && decoded.v === 4, 'a room code decodes as v4')
  if (decoded && decoded.v === 4) {
    assert.equal(decoded.admin.id, admin.id, 'the code names its admin')
    assert.equal(
      decoded.admin.pub,
      admin.pub,
      "and carries the admin's PUBLIC KEY to verify against"
    )
    assert.equal(decoded.name, 'Family')
    assert.equal(decoded.relay.roomId, relay.roomId)
  }

  // Old group codes keep decoding: members of the migrated room hand
  // these around, and a v2 code joining a room simply has no admin.
  const v2 = encodeRelayShareCode({ relay, secret: 'old-secret', name: '' })
  const decodedV2 = decodeShareCode(v2)
  assert.ok(decodedV2 && decodedV2.v === 2, 'a v2 code still decodes')

  // A v4 payload without its admin is not a room code at all — accepting
  // it would create rooms whose admin nobody can verify.
  const stripped = JSON.parse(Buffer.from(code, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >
  delete stripped.admin
  const tampered = Buffer.from(JSON.stringify(stripped), 'utf8').toString('base64url')
  assert.equal(decodeShareCode(tampered), null, 'a v4 code must name its admin')

  assert.throws(
    () => encodeRoomShareCode({ relay, secret: 'x', name: 'y', admin: { id: '', pub: '' } }),
    'encoding refuses an anonymous admin'
  )
}

// --- the chip: identities, signatures, cryptograms ---------------------------
//
// The model the user asked for by name: EMV. The private key never
// leaves the device; a tap signs the door, the moment, and a spent
// counter; every room message is signed by its sender. Each assertion
// here closes a door the bearer-string era left open.

{
  const alice = generateIdentity()
  const mallory = generateIdentity()

  assert.equal(alice.id, idOfRawPub(alice.pub), 'the identity IS the key — id = sha256(pub)')

  // Signed messages: the truth of "who spoke".
  const envelope = signRoomMessage(alice, 'room-1', { type: 'friend-presence', name: 'Alice' }, 1)
  const verified = verifyRoomMessage('room-1', envelope, undefined)
  assert.ok(verified.ok && verified.from === alice.id, 'a genuine message verifies to its sender')

  // Wearing someone else's id over your own valid key. Two shapes:
  // swapping `from` after signing breaks the signature itself, but the
  // deeper one SIGNS the lie — mallory's key, alice's id, a signature
  // genuinely made over that claim. Only the id-equals-hash-of-key rule
  // refuses it, which is why the rule exists.
  const spoofed = { ...signRoomMessage(mallory, 'room-1', { type: 'x' }, 1), from: alice.id }
  assert.equal(
    verifyRoomMessage('room-1', spoofed, undefined).ok,
    false,
    'a spoofed sender id is refused even over a valid signature'
  )
  const forgedClaim = signRoomMessage({ ...mallory, id: alice.id }, 'room-1', { type: 'x' }, 1)
  assert.equal(forgedClaim.from, alice.id, 'the forgery claims to be alice, signed by mallory')
  assert.equal(
    verifyRoomMessage('room-1', forgedClaim, undefined).ok,
    false,
    'a SIGNED false claim of identity is refused — the id must be the hash of the signing key'
  )

  // Tampering with the body after signing.
  const tampered = { ...envelope, b: { type: 'friend-presence', name: 'Not Alice' } }
  assert.equal(
    verifyRoomMessage('room-1', tampered, undefined).ok,
    false,
    'a tampered body is refused'
  )

  // Replay: yesterday's genuinely-signed message, played again.
  assert.equal(
    verifyRoomMessage('room-1', envelope, envelope.seq).ok,
    false,
    'a replayed message (seq not above the high-water mark) is refused'
  )

  // A message signed for one room does not verify in another.
  assert.equal(
    verifyRoomMessage('room-2', envelope, undefined).ok,
    false,
    'a signature binds the room it was made for'
  )

  // SEQUENCES SURVIVE RESTARTS by being anchored to the clock, not to
  // a counter that starts over. Review caught the plain counter: a
  // restarted member's first message would sit below the high-water
  // mark every online peer still held, and be rejected as a replay —
  // presence, re-keys and join requests suppressed for hours.
  const restartNow = 1_800_000_000_000
  let seq = nextSeq(0, restartNow) // first session begins
  seq = nextSeq(seq, restartNow + 20_000)
  seq = nextSeq(seq, restartNow + 40_000)
  const beforeRestart = signRoomMessage(alice, 'room-1', { type: 'friend-presence' }, seq)
  // ...the app restarts; the fresh session knows nothing of `seq`, only
  // a later clock. The peer still holds the old high-water mark.
  const afterRestart = signRoomMessage(
    alice,
    'room-1',
    { type: 'friend-presence' },
    nextSeq(0, restartNow + 60_000)
  )
  assert.ok(
    verifyRoomMessage('room-1', afterRestart, beforeRestart.seq).ok,
    'the first message after a restart is accepted by a peer that never restarted'
  )
  assert.ok(
    nextSeq(seq, restartNow) > seq,
    'within a session the sequence is strictly monotonic even if the clock stalls'
  )
}

// --- the tap: admission cryptograms ------------------------------------------

{
  const card = generateIdentity()
  const tap = mintCryptogram(card, 'admit', 'relay.example.com', 'room-1', 7)

  const accepted = verifyCryptogram(tap, 'admit', 'relay.example.com', 'room-1')
  assert.ok(accepted.ok && accepted.id === card.id, 'a genuine tap verifies to its identity')

  // The whole point of binding the door into the signature: a cryptogram
  // harvested at (or minted for) one relay is worthless at another —
  // this is what closed the credential-harvest class for good.
  assert.equal(
    verifyCryptogram(tap, 'admit', 'evil.example.com', 'room-1').ok,
    false,
    'a tap minted for relay X is refused at relay Y'
  )
  assert.equal(
    verifyCryptogram(tap, 'admit', 'relay.example.com', 'room-2').ok,
    false,
    'and refused for a different room'
  )
  assert.equal(
    verifyCryptogram(tap, 'carry', 'relay.example.com', 'room-1').ok,
    false,
    'and refused for a different purpose — an admit tap cannot be replayed as a carry'
  )
  assert.equal(
    verifyCryptogram(
      tap,
      'admit',
      'relay.example.com',
      'room-1',
      tap.ts + CRYPTOGRAM_FRESHNESS_MS + 1
    ).ok,
    false,
    'a stale tap is refused — freshness is half of replay protection; the counter is the other'
  )

  const forged = {
    ...tap,
    sig: mintCryptogram(generateIdentity(), 'admit', 'relay.example.com', 'room-1', 7).sig
  }
  assert.equal(
    verifyCryptogram(forged, 'admit', 'relay.example.com', 'room-1').ok,
    false,
    "someone else's signature over the same data is a forgery, not a tap"
  )
}

// --- the relay's ban announcement, as the kick barrier reads it ---------------
//
// The kick flow refuses to breathe a word of the new secret until it
// OBSERVES the ban on its own room socket — this parser is what does
// the observing, so it must accept exactly the relay's envelope and
// nothing that merely resembles it.

{
  const ID = 'a'.repeat(64)
  assert.deepEqual(
    parseBannedEnvelope(JSON.stringify({ type: 'banned', hashes: [ID, 'not-an-id'] })),
    [ID],
    'the ban envelope parses, and non-id entries are dropped'
  )
  assert.equal(parseBannedEnvelope('ciphertext-not-json'), null, 'ciphertext is not a ban')
  assert.equal(
    parseBannedEnvelope(JSON.stringify({ type: 'relay', body: 'x' })),
    null,
    'other envelopes are not bans'
  )
  assert.equal(
    parseBannedEnvelope(JSON.stringify({ type: 'relay', hashes: [ID] })),
    null,
    'a hashes field inside a NON-ban envelope is not a ban — the type is load-bearing'
  )
  assert.deepEqual(
    parseBannedEnvelope(JSON.stringify({ type: 'banned', hashes: 'not-an-array' })),
    null,
    'a malformed ban is no ban'
  )
}

// --- what a re-key may change -----------------------------------------------
//
// The most powerful message on the channel: accepted carelessly it could
// move members onto an attacker's secret or into a different room. Each
// refusal here closes one of those doors.

{
  const adminId = generateIdentity()
  const ADMIN = adminId.id
  const adminRef = { id: adminId.id, pub: adminId.pub }
  const relay = { url: 'https://relay.example.workers.dev', roomId: crypto.randomUUID() }
  const room = { roomId: relay.roomId, relayUrl: relay.url, adminFriendId: ADMIN }
  const freshCode = encodeRoomShareCode({
    relay,
    secret: 'rotated-secret',
    name: 'Family',
    admin: adminRef,
    join: 'rotated-join'
  })

  const adopted = applyRekey(room, { code: freshCode }, ADMIN)
  assert.ok(adopted, 'the admin re-keys the room')
  assert.equal(adopted?.secret, 'rotated-secret')
  assert.equal(adopted?.joinSecret, 'rotated-join')

  assert.equal(
    applyRekey(room, { code: freshCode }, 'someone-else'),
    null,
    'nobody but the admin is believed'
  )

  assert.equal(
    applyRekey(
      { roomId: relay.roomId, relayUrl: relay.url, adminFriendId: undefined },
      { code: freshCode },
      ADMIN
    ),
    null,
    'a room with no admin cannot be re-keyed by message at all'
  )

  // Same UUID, different relay: still a relocation. The id namespace
  // belongs to the relay, and accepting this would quietly move every
  // copied invite — and, after restart, this client — onto a server of
  // the sender's choosing.
  const crossRelayCode = encodeRoomShareCode({
    relay: { url: 'https://elsewhere.example.workers.dev', roomId: relay.roomId },
    secret: 'rotated-secret',
    name: 'Family',
    admin: adminRef
  })
  assert.equal(
    applyRekey(room, { code: crossRelayCode }, ADMIN),
    null,
    'a re-key that switches relays is a relocation, not a rotation'
  )

  const otherRoomCode = encodeRoomShareCode({
    relay: { url: relay.url, roomId: crypto.randomUUID() },
    secret: 'rotated-secret',
    name: 'Family',
    admin: adminRef
  })
  assert.equal(
    applyRekey(room, { code: otherRoomCode }, ADMIN),
    null,
    'a re-key that changes the roomId is a relocation, not a rotation'
  )

  const usurper = generateIdentity()
  const handoffCode = encodeRoomShareCode({
    relay,
    secret: 'rotated-secret',
    name: 'Family',
    admin: { id: usurper.id, pub: usurper.pub }
  })
  assert.equal(
    applyRekey(room, { code: handoffCode }, ADMIN),
    null,
    'there is no admin handoff by message'
  )
}

// --- recoding an invite after a rename --------------------------------------
//
// The name lives in two places — the display name renames update, and
// the invite code that gets copied for the next member. Recoding must
// change the name and NOTHING else, including fields this version of
// the app has never heard of: a future code carries the room's door
// key, and a recode that dropped it would hand out invites that cannot
// open the door.

{
  const relay = { url: 'https://relay.example.workers.dev', roomId: crypto.randomUUID() }
  const recodeAdmin = generateIdentity()
  const code = encodeRoomShareCode({
    relay,
    secret: 'room-secret',
    name: 'Family',
    admin: { id: recodeAdmin.id, pub: recodeAdmin.pub }
  })
  // Smuggle in a field from the future.
  const raw = JSON.parse(Buffer.from(code, 'base64url').toString('utf8')) as Record<string, unknown>
  raw.futureField = 'must-survive'
  const futureCode = Buffer.from(JSON.stringify(raw), 'utf8').toString('base64url')

  const renamed = withRoomName(futureCode, 'Movie night')
  assert.ok(renamed, 'a valid room code recodes')
  const decoded = JSON.parse(Buffer.from(String(renamed), 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >
  assert.equal(decoded.name, 'Movie night', 'the name changes')
  assert.equal(decoded.secret, 'room-secret', 'the secret does not')
  assert.equal((decoded.admin as { id?: string })?.id, recodeAdmin.id, 'nor the admin')
  assert.equal(decoded.futureField, 'must-survive', 'nor fields this version has never heard of')
  const reparsed = decodeShareCode(String(renamed))
  assert.ok(reparsed && reparsed.v === 4, 'the recoded invite still decodes as a room code')

  assert.equal(withRoomName('not-a-code', 'x'), null, 'garbage recodes to nothing, not to garbage')
}

console.log('ok  rooms rules')
