// Watch-party authority, direct-mode replay protection, party frame
// decoding and room join consent (2026-11-21 scan: F7, F14, F16, F17, F19,
// F20, F21, F22, F24, F25, F26, F27, F29, F30, F33).
// Run with: npx tsx tests/partyAuthority.test.ts   (or npm.cmd test)

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { decryptMessage, encryptMessage } from '../src/main/media-hub/party'
import {
  PartyClientHandshake,
  PartyDirectChannel,
  PartyHostHandshake,
  deriveSessionKeys,
  isLegacyPartyFrame,
  parseHandshake
} from '../src/main/media-hub/partyChannel'
import { FriendJoinTracker, FRIEND_JOIN_REQUEST_TTL_MS } from '../src/main/media-hub/friendJoin'
import {
  clientAcceptsPartyMessage,
  directSenderOf,
  hostAcceptsFromMember,
  hostShouldForwardMemberMessage,
  partyEventSender,
  relaySenderOf
} from '../src/shared/media-hub/partyAuthority'

let pass = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).stack}`)
    process.exitCode = 1
  }
}

const HOST_ONLY = [
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
]
const CONTROL = ['play', 'pause', 'seek']

console.log('party authority: host side (F7, F20, F25, F26)')
check('host never acts on a host-only type from a member', () => {
  for (const type of HOST_ONLY) {
    assert.equal(hostAcceptsFromMember({ type }, false), false, type)
    assert.equal(hostAcceptsFromMember({ type }, true), false, type)
  }
})
check('host takes member play/pause/seek only while member control is on', () => {
  for (const type of CONTROL) {
    assert.equal(hostAcceptsFromMember({ type }, false), false, type)
    assert.equal(hostAcceptsFromMember({ type }, true), true, type)
  }
})
check('host takes ordinary member messages and drops unknown or malformed ones', () => {
  for (const type of ['chat', 'watching', 'ready', 'resync-request', 'hello', 'leave']) {
    assert.equal(hostAcceptsFromMember({ type }, false), true, type)
  }
  // Legacy queue messages are dropped by current builds anyway.
  for (const type of ['play-request', 'suggest', 'vote']) {
    assert.equal(hostAcceptsFromMember({ type }, true), false, type)
  }
  assert.equal(hostAcceptsFromMember({ type: 'something-new' }, true), false)
  assert.equal(hostAcceptsFromMember({}, true), false)
  assert.equal(hostAcceptsFromMember(null, true), false)
  assert.equal(hostAcceptsFromMember({ type: 42 }, true), false)
})
check('direct host forwards only allowed member playback control', () => {
  for (const type of [...HOST_ONLY, 'chat', 'ready', 'watching', 'resync-request', 'hello']) {
    assert.equal(hostShouldForwardMemberMessage({ type }, true), false, type)
  }
  for (const type of CONTROL) {
    assert.equal(hostShouldForwardMemberMessage({ type }, false), false, type)
    assert.equal(hostShouldForwardMemberMessage({ type }, true), true, type)
  }
})

console.log('party authority: client side (F7, F20, F21, F24, F25, F26)')
check('client accepts anything from the host', () => {
  for (const type of [...HOST_ONLY, ...CONTROL, 'chat']) {
    assert.equal(clientAcceptsPartyMessage({ type }, 'host', false), true, type)
  }
})
check('client never accepts host-only types from a member, even with control on', () => {
  for (const type of HOST_ONLY) {
    assert.equal(clientAcceptsPartyMessage({ type }, 'member', true), false, type)
  }
})
check("client honours the host's member-control setting", () => {
  for (const type of CONTROL) {
    assert.equal(clientAcceptsPartyMessage({ type }, 'member', false), false, type)
    assert.equal(clientAcceptsPartyMessage({ type }, 'member', true), true, type)
  }
  assert.equal(clientAcceptsPartyMessage({ type: 'chat' }, 'member', false), true)
  for (const type of ['resync-request', 'watching', 'ready', 'hello', 'leave', 'vote']) {
    assert.equal(clientAcceptsPartyMessage({ type }, 'member', true), false, type)
  }
})
check('direct-mode sender comes from the host-stamped `from`', () => {
  assert.equal(directSenderOf({ type: 'nowPlaying' }), 'host')
  assert.equal(directSenderOf({ type: 'nowPlaying', from: 'abcd' }), 'member')
  // A forwarded forged nowPlaying is therefore rejected on the client.
  const forwarded = { type: 'nowPlaying', from: 'abcd' }
  assert.equal(clientAcceptsPartyMessage(forwarded, directSenderOf(forwarded), true), false)
  assert.equal(partyEventSender('host'), 'host')
  assert.equal(partyEventSender('3f2c1a'), 'member')
  assert.equal(partyEventSender(undefined), 'member')
})
check('relay-mode sender needs the relay-stamped isHost and no forwarding stamp', () => {
  // A member's own envelope is never the host's, whatever it carries.
  assert.equal(relaySenderOf(false, { type: 'nowPlaying' }), 'member')
  assert.equal(relaySenderOf(undefined, { type: 'nowPlaying' }), 'member')
  assert.equal(relaySenderOf('true', { type: 'nowPlaying' }), 'member')
  assert.equal(relaySenderOf(true, { type: 'nowPlaying' }), 'host')
  // The hybrid host bridges a direct member's frame onto the relay: it
  // arrives on the host's connection, stamped with the member's id.
  const bridged = { type: 'seek-sync', from: 'abcd' }
  assert.equal(relaySenderOf(true, bridged), 'member')
  assert.equal(clientAcceptsPartyMessage(bridged, relaySenderOf(true, bridged), true), false)
  const bridgedPause = { type: 'pause', from: 'abcd' }
  assert.equal(
    clientAcceptsPartyMessage(bridgedPause, relaySenderOf(true, bridgedPause), false),
    false
  )
})

console.log('party frame decoder (F14, F27)')
check('relay frames round trip and fail closed on a wrong key', () => {
  const frame = encryptMessage('party-secret', { type: 'hello', n: 1 })
  assert.deepEqual(decryptMessage('party-secret', frame), { type: 'hello', n: 1 })
  assert.equal(decryptMessage('other-secret', frame), null)
})
check('array-like and non-string fields are rejected before Buffer.from', () => {
  const parsed = JSON.parse(encryptMessage('party-secret', { type: 'x' })) as Record<
    string,
    string
  >
  const started = Date.now()
  for (const field of ['iv', 'ct', 'tag']) {
    assert.equal(
      decryptMessage('party-secret', JSON.stringify({ ...parsed, [field]: { length: 500_000_000 } })),
      null,
      field
    )
  }
  assert.ok(Date.now() - started < 1000, 'rejecting a hostile frame is immediate')
  for (const raw of ['null', '[]', '"x"', '42', 'not json']) {
    assert.equal(decryptMessage('party-secret', raw), null, raw)
  }
})
check('a truncated tag or wrong-length iv is refused', () => {
  const parsed = JSON.parse(encryptMessage('party-secret', { type: 'x' })) as Record<
    string,
    string
  >
  const shortTag = Buffer.from(parsed.tag, 'base64').subarray(0, 4).toString('base64')
  assert.equal(decryptMessage('party-secret', JSON.stringify({ ...parsed, tag: shortTag })), null)
  const longIv = crypto.randomBytes(16).toString('base64')
  assert.equal(decryptMessage('party-secret', JSON.stringify({ ...parsed, iv: longIv })), null)
  const hugeCt = 'A'.repeat(128 * 1024 + 4)
  assert.equal(decryptMessage('party-secret', JSON.stringify({ ...parsed, ct: hugeCt })), null)
})

console.log('direct channel: handshake, replay and direction (F19, F22)')
const secret = 'party-secret-for-tests'

function connect(
  partySecret = secret,
  clientSecret = partySecret
): { host: PartyDirectChannel; client: PartyDirectChannel; hostHs: PartyHostHandshake } {
  const clientHs = new PartyClientHandshake(clientSecret)
  const hostHs = new PartyHostHandshake(partySecret)
  const outcome = hostHs.acceptClientHello(clientHs.hello())
  assert.ok(outcome.ok)
  const client = clientHs.acceptServerHello((outcome as { reply: string }).reply)
  assert.ok(client)
  return { host: hostHs.established!, client: client!, hostHs }
}

check('two v2 ends exchange messages both ways', () => {
  const { host, client } = connect()
  assert.deepEqual(host.open(client.seal({ type: 'hello', name: 'Ann' })), {
    type: 'hello',
    name: 'Ann'
  })
  assert.deepEqual(client.open(host.seal({ type: 'welcome', id: 'x' })), {
    type: 'welcome',
    id: 'x'
  })
  assert.deepEqual(host.open(client.seal({ type: 'chat', n: 2 })), { type: 'chat', n: 2 })
})
check('a captured hello cannot be replayed on a new connection', () => {
  const first = connect()
  const captured = first.client.seal({ type: 'hello', name: 'Victim' })
  assert.ok(first.host.open(captured))
  // The attacker opens a fresh socket. Even replaying the victim's own
  // client-hello gets a new host nonce, so the old frame no longer decrypts.
  const attackerHs = new PartyClientHandshake('not-the-secret')
  const hostHs = new PartyHostHandshake(secret)
  const outcome = hostHs.acceptClientHello(attackerHs.hello())
  assert.ok(outcome.ok)
  assert.equal(hostHs.established!.open(captured), null)
})
check('a frame cannot be replayed or reordered within a connection', () => {
  const { host, client } = connect()
  const one = client.seal({ type: 'hello', name: 'A' })
  const two = client.seal({ type: 'pause' })
  const three = client.seal({ type: 'play' })
  assert.ok(host.open(one))
  assert.equal(host.open(one), null, 'replay of an accepted frame')
  assert.equal(host.open(three), null, 'skipping ahead')
  assert.deepEqual(host.open(two), { type: 'pause' })
  assert.deepEqual(host.open(three), { type: 'play' })
})
check('a host->client frame cannot be reflected back at the host', () => {
  const { host, client } = connect()
  assert.ok(host.open(client.seal({ type: 'hello', name: 'A' })))
  const first = host.seal({ type: 'welcome', id: 'x' })
  // seq 2 — exactly what the host expects next from the client, so only the
  // direction (key and AAD label) can stop it.
  const fromHost = host.seal({ type: 'pause' })
  assert.equal(host.open(fromHost), null)
  assert.ok(client.open(first))
  assert.deepEqual(client.open(fromHost), { type: 'pause' })
})
check('the sequence number is authenticated', () => {
  const { host, client } = connect()
  assert.ok(host.open(client.seal({ type: 'hello', name: 'A' })))
  client.seal({ type: 'dropped' }) // seq 2, never delivered
  const third = JSON.parse(client.seal({ type: 'pause' })) as Record<string, unknown>
  // Relabelled to the seq the host expects next: the AAD no longer matches.
  third.seq = 2
  assert.equal(host.open(JSON.stringify(third)), null)
})
check('a client with the wrong secret is not admitted', () => {
  const { host, client } = connect(secret, 'wrong-secret')
  assert.equal(host.open(client.seal({ type: 'hello', name: 'Eve' })), null)
})
check('session keys differ per connection and per direction', () => {
  const a = deriveSessionKeys(secret, Buffer.alloc(16, 1), Buffer.alloc(16, 2))
  const b = deriveSessionKeys(secret, Buffer.alloc(16, 1), Buffer.alloc(16, 3))
  assert.notDeepEqual(a.c2h, a.h2c)
  assert.notDeepEqual(a.c2h, b.c2h)
})
check('handshake parsing is strict and v1 peers are recognised', () => {
  const v1Hello = encryptMessage(secret, { type: 'hello', name: 'Old client' })
  assert.equal(isLegacyPartyFrame(v1Hello), true)
  const hostHs = new PartyHostHandshake(secret)
  assert.deepEqual(hostHs.acceptClientHello(v1Hello), { ok: false, reason: 'legacy' })
  assert.deepEqual(new PartyHostHandshake(secret).acceptClientHello('garbage'), {
    ok: false,
    reason: 'invalid'
  })
  const clientHello = new PartyClientHandshake(secret).hello()
  assert.ok(parseHandshake(clientHello, 'client-hello'))
  assert.equal(parseHandshake(clientHello, 'server-hello'), null, 'wrong kind')
  const shortNonce = JSON.stringify({ ...JSON.parse(clientHello), nonce: 'AAAA' })
  assert.equal(parseHandshake(shortNonce, 'client-hello'), null)
  const oldVersion = JSON.stringify({ ...JSON.parse(clientHello), v: 1 })
  assert.equal(parseHandshake(oldVersion, 'client-hello'), null)
  // A second client-hello on an established connection is refused.
  const { hostHs: established } = connect()
  assert.equal(established.acceptClientHello(clientHello).ok, false)
})
check('malformed sealed frames fail closed', () => {
  const { host } = connect()
  for (const raw of [
    'not json',
    '[]',
    '{"seq":1,"iv":{"length":500000000},"ct":"","tag":""}',
    '{"seq":"1","iv":"","ct":"","tag":""}',
    JSON.stringify({ seq: 1, iv: 'AAAA', ct: 'AAAA', tag: 'AAAA' })
  ]) {
    assert.equal(host.open(raw), null, raw)
  }
})

console.log('room join consent (F16, F17, F29, F30, F33)')
let ids = 0
const tracker = (): FriendJoinTracker =>
  new FriendJoinTracker(() => `request-${String(++ids).padStart(12, '0')}`)
const self = 'self-friend-id'
const bob = 'bob-friend-id'
const mallory = 'mallory-friend-id'

check('an unsolicited offer is dropped', () => {
  const t = tracker()
  assert.equal(
    t.acceptIncoming(
      {
        type: 'friend-join-offer',
        fromFriendId: mallory,
        toFriendId: self,
        requestId: 'request-000000000099'
      },
      { selfFriendId: self, sharing: true }
    ),
    false
  )
})
check('an offer is accepted only from the friend asked, with the matching id, once', () => {
  const t = tracker()
  const requestId = t.startRequest(bob, 1000)
  const ctx = { selfFriendId: self, sharing: false, now: 2000 }
  const offer = { type: 'friend-join-offer', toFriendId: self, requestId }
  assert.equal(t.acceptIncoming({ ...offer, fromFriendId: mallory }, ctx), false, 'other sender')
  assert.equal(
    t.acceptIncoming({ ...offer, fromFriendId: bob, requestId: 'request-999999999999' }, ctx),
    false,
    'wrong id'
  )
  assert.equal(t.acceptIncoming({ ...offer, fromFriendId: bob }, ctx), true)
  assert.equal(t.acceptIncoming({ ...offer, fromFriendId: bob }, ctx), false, 'second answer')
})
check('an answer after the request expired is dropped', () => {
  const t = tracker()
  const requestId = t.startRequest(bob, 0)
  assert.equal(
    t.acceptIncoming(
      { type: 'friend-join-declined', fromFriendId: bob, toFriendId: self, requestId },
      { selfFriendId: self, sharing: true, now: FRIEND_JOIN_REQUEST_TTL_MS + 1 }
    ),
    false
  )
})
check('a cancelled request no longer accepts an answer', () => {
  const t = tracker()
  const requestId = t.startRequest(bob)
  t.cancelRequest(bob)
  assert.equal(
    t.acceptIncoming(
      { type: 'friend-join-offer', fromFriendId: bob, toFriendId: self, requestId },
      { selfFriendId: self, sharing: true }
    ),
    false
  )
})
check('a join request is dropped silently while activity sharing is off', () => {
  const t = tracker()
  const request = {
    type: 'friend-join-request',
    fromFriendId: mallory,
    toFriendId: self,
    requestId: 'request-000000000500'
  }
  assert.equal(t.acceptIncoming(request, { selfFriendId: self, sharing: false }), false)
  // ...and with nothing recorded, no reply can be sent for it either.
  assert.equal(
    t.authorizeReply({
      type: 'friend-join-declined',
      toFriendId: mallory,
      requestId: request.requestId
    }),
    false
  )
})
check('with sharing on, a request reaches the user and allows exactly one reply', () => {
  const t = tracker()
  const requestId = 'request-000000000600'
  const request = { type: 'friend-join-request', fromFriendId: bob, toFriendId: self, requestId }
  assert.equal(t.acceptIncoming(request, { selfFriendId: self, sharing: true }), true)
  assert.equal(t.acceptIncoming(request, { selfFriendId: self, sharing: true }), false, 'dup')
  assert.equal(
    t.authorizeReply({ type: 'friend-join-offer', toFriendId: mallory, requestId }),
    false,
    'offer to someone else'
  )
  assert.equal(t.authorizeReply({ type: 'friend-join-offer', toFriendId: bob, requestId }), true)
  assert.equal(
    t.authorizeReply({ type: 'friend-join-offer', toFriendId: bob, requestId }),
    false,
    'second reply'
  )
})
check('requests without a usable id, misaddressed or from ourselves are dropped', () => {
  const t = tracker()
  const ctx = { selfFriendId: self, sharing: true }
  assert.equal(
    t.acceptIncoming({ type: 'friend-join-request', fromFriendId: bob, toFriendId: self }, ctx),
    false
  )
  assert.equal(
    t.acceptIncoming(
      {
        type: 'friend-join-request',
        fromFriendId: bob,
        toFriendId: 'other',
        requestId: 'request-000000000700'
      },
      ctx
    ),
    false
  )
  assert.equal(
    t.acceptIncoming(
      {
        type: 'friend-join-request',
        fromFriendId: self,
        toFriendId: self,
        requestId: 'request-000000000701'
      },
      ctx
    ),
    false
  )
})

console.log(`ok  party authority (${pass} checks)`)
