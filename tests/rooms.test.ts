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
  memberKeysFor,
  migrateLegacyRooms,
  reapPresence,
  recordPresence,
  withRoomName,
  type PresenceRecord
} from '../src/main/media-hub/roomRules'

const now = 1_800_000_000_000
const SELF = 'self-friend-id'

// --- presence ---------------------------------------------------------------

{
  const presence = new Map<string, PresenceRecord>()
  const live = recordPresence(presence, { friendId: 'a', name: 'Ana' }, SELF, now)
  assert.equal(live.changed, true)
  assert.equal(live.isNewcomer, true, 'a live first announcement is a newcomer')
  assert.equal(presence.get('a')?.lastSeen, now)

  // Our own announcement echoing back must never appear as a member.
  const self = recordPresence(presence, { friendId: SELF, name: 'Me' }, SELF, now)
  assert.equal(self.changed, false, 'self is not a member of the view')

  // Retained replay: the relay held this for ageMs, so the member spoke
  // that long ago — and a replayed stranger is NOT a newcomer, or every
  // reconnect would trigger a chorus of replies to people who are not new.
  const replay = recordPresence(presence, { friendId: 'b', name: 'Ben' }, SELF, now, 9 * 60_000)
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
  const code = encodeRoomShareCode({
    relay,
    secret: 'room-secret',
    name: 'Family',
    adminFriendId: 'admin-id'
  })
  const decoded = decodeShareCode(code)
  assert.ok(decoded && decoded.v === 3, 'a room code decodes as v3')
  if (decoded && decoded.v === 3) {
    assert.equal(decoded.adminFriendId, 'admin-id', 'the code names its admin')
    assert.equal(decoded.name, 'Family')
    assert.equal(decoded.relay.roomId, relay.roomId)
  }

  // Old group codes keep decoding: members of the migrated room hand
  // these around, and a v2 code joining a room simply has no admin.
  const v2 = encodeRelayShareCode({ relay, secret: 'old-secret', name: '' })
  const decodedV2 = decodeShareCode(v2)
  assert.ok(decodedV2 && decodedV2.v === 2, 'a v2 code still decodes')

  // A v3 payload without its admin is not a room code at all — accepting
  // it would create rooms whose admin nobody can name.
  const stripped = JSON.parse(Buffer.from(code, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >
  delete stripped.adminFriendId
  const tampered = Buffer.from(JSON.stringify(stripped), 'utf8').toString('base64url')
  assert.equal(decodeShareCode(tampered), null, 'a v3 code must name its admin')

  assert.throws(
    () => encodeRoomShareCode({ relay, secret: 'x', name: 'y', adminFriendId: '' }),
    'encoding refuses an anonymous admin'
  )
}

// --- who a kick can name ----------------------------------------------------
//
// A kick removes a PERSON, which at the relay means every memberKey the
// room has seen their announcements carry — one person is several
// installs, and banning only the laptop leaves the TV in the room.

{
  const presence = new Map<string, PresenceRecord>()
  recordPresence(presence, { friendId: 'a', name: 'Ana', memberKey: 'ana-laptop-key01' }, SELF, now)
  recordPresence(presence, { friendId: 'a', name: 'Ana', memberKey: 'ana-tv-key000001' }, SELF, now)
  recordPresence(presence, { friendId: 'a', name: 'Ana', memberKey: 'ana-tv-key000001' }, SELF, now)
  assert.deepEqual(
    memberKeysFor(presence, 'a'),
    ['ana-laptop-key01', 'ana-tv-key000001'],
    'every install announced is named, once each'
  )
  assert.deepEqual(memberKeysFor(presence, 'ghost'), [], 'never seen means nothing to remove')
}

// --- what a re-key may change -----------------------------------------------
//
// The most powerful message on the channel: accepted carelessly it could
// move members onto an attacker's secret or into a different room. Each
// refusal here closes one of those doors.

{
  const ADMIN = 'admin-id'
  const relay = { url: 'https://relay.example.workers.dev', roomId: crypto.randomUUID() }
  const room = { roomId: relay.roomId, adminFriendId: ADMIN }
  const freshCode = encodeRoomShareCode({
    relay,
    secret: 'rotated-secret',
    name: 'Family',
    adminFriendId: ADMIN,
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
    applyRekey({ roomId: relay.roomId, adminFriendId: undefined }, { code: freshCode }, ADMIN),
    null,
    'a room with no admin cannot be re-keyed by message at all'
  )

  const otherRoomCode = encodeRoomShareCode({
    relay: { url: relay.url, roomId: crypto.randomUUID() },
    secret: 'rotated-secret',
    name: 'Family',
    adminFriendId: ADMIN
  })
  assert.equal(
    applyRekey(room, { code: otherRoomCode }, ADMIN),
    null,
    'a re-key that changes the roomId is a relocation, not a rotation'
  )

  const handoffCode = encodeRoomShareCode({
    relay,
    secret: 'rotated-secret',
    name: 'Family',
    adminFriendId: 'new-admin'
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
  const code = encodeRoomShareCode({
    relay,
    secret: 'room-secret',
    name: 'Family',
    adminFriendId: 'admin-id'
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
  assert.equal(decoded.adminFriendId, 'admin-id', 'nor the admin')
  assert.equal(decoded.futureField, 'must-survive', 'nor fields this version has never heard of')
  const reparsed = decodeShareCode(String(renamed))
  assert.ok(reparsed && reparsed.v === 3, 'the recoded invite still decodes as a room code')

  assert.equal(withRoomName('not-a-code', 'x'), null, 'garbage recodes to nothing, not to garbage')
}

console.log('ok  rooms rules')
