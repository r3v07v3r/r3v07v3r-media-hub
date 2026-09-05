import assert from 'node:assert'
import crypto from 'node:crypto'
import {
  decodeShareCode,
  encodeHybridShareCode,
  encodeRelayShareCode,
  encodeRoomShareCode,
  encodeShareCode
} from '../src/main/media-hub/party.ts'
import { generateIdentity, idOfRawPub } from '../src/main/media-hub/roomIdentity.ts'

let pass = 0

function check(name: string, fn: () => void): void {
  try {
    fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

const SECRET = crypto.randomBytes(24).toString('base64url')
const RELAY = {
  url: 'https://party-sync.example.workers.dev',
  roomId: '2f1c9a4e-8b7d-4c3a-9e6f-0a1b2c3d4e5f'
}
const LAN = { ip: '192.168.1.50', port: 54321 }
const WAN = { ip: '203.0.113.9', port: 41234 }

// Real codes minted by the JSON codec that this format replaced. They are
// pasted as literals because nothing can encode them any more — the point
// is that they are now REJECTED rather than quietly understood.
const LEGACY_V1 =
  'eyJ2IjoxLCJsYW4iOnsiaXAiOiIxOTIuMTY4LjEuNTAiLCJwb3J0Ijo1NDMyMX0sIndhbiI6eyJpcCI6IjIwMy4wLjExMy45IiwicG9ydCI6NDEyMzR9LCJzZWNyZXQiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBUSIsIm5hbWUiOiJHcmFoYW0ifQ'
const LEGACY_V2 =
  'eyJ2IjoyLCJyZWxheSI6eyJ1cmwiOiJodHRwczovL3BhcnR5LXN5bmMuZXhhbXBsZS53b3JrZXJzLmRldiIsInJvb21JZCI6IjJmMWM5YTRlLThiN2QtNGMzYS05ZTZmLTBhMWIyYzNkNGU1ZiJ9LCJzZWNyZXQiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBUSIsIm5hbWUiOiJHcmFoYW0ifQ'

console.log('party share codes')

check('round-trips a relay code', () => {
  const decoded = decodeShareCode(encodeRelayShareCode({ relay: RELAY, secret: SECRET }))
  assert.ok(decoded && decoded.v === 2)
  assert.deepEqual(decoded.relay, RELAY)
  assert.equal(decoded.secret, SECRET)
})

check('round-trips a direct code with a WAN endpoint', () => {
  const decoded = decodeShareCode(encodeShareCode({ lan: LAN, wan: WAN, secret: SECRET }))
  assert.ok(decoded && decoded.v === 1)
  assert.deepEqual(decoded.lan, LAN)
  assert.deepEqual(decoded.wan, WAN)
  assert.equal(decoded.secret, SECRET)
})

check('round-trips a direct code with no WAN endpoint', () => {
  const decoded = decodeShareCode(encodeShareCode({ lan: LAN, wan: null, secret: SECRET }))
  assert.ok(decoded && decoded.v === 1)
  assert.deepEqual(decoded.lan, LAN)
  assert.equal(decoded.wan, null)
})

check('keeps an IPv6 LAN address intact', () => {
  const lan = { ip: 'fe80::1c2d:3e4f:5a6b:7c8d', port: 8080 }
  const decoded = decodeShareCode(encodeShareCode({ lan, secret: SECRET }))
  assert.ok(decoded && decoded.v === 1)
  assert.deepEqual(decoded.lan, lan)
})

check('is far shorter than the codes it replaces', () => {
  const relay = encodeRelayShareCode({ relay: RELAY, secret: SECRET })
  const direct = encodeShareCode({ lan: LAN, wan: WAN, secret: SECRET })
  assert.ok(relay.length < 110, `relay code was ${relay.length} chars`)
  assert.ok(direct.length < 70, `direct code was ${direct.length} chars`)
  assert.ok(relay.length < LEGACY_V2.length / 1.7)
  assert.ok(direct.length < LEGACY_V1.length / 1.7)
})

check('round-trips a hybrid code — every transport in one invite', () => {
  const decoded = decodeShareCode(
    encodeHybridShareCode({ lan: LAN, wan: WAN, relay: RELAY, secret: SECRET })
  )
  assert.ok(decoded && decoded.v === 5)
  assert.deepEqual(decoded.lan, LAN)
  assert.deepEqual(decoded.wan, WAN)
  assert.deepEqual(decoded.relay, RELAY)
  assert.equal(decoded.secret, SECRET)
})

check('round-trips a hybrid code with no WAN endpoint', () => {
  const decoded = decodeShareCode(
    encodeHybridShareCode({ lan: LAN, wan: null, relay: RELAY, secret: SECRET })
  )
  assert.ok(decoded && decoded.v === 5)
  assert.deepEqual(decoded.lan, LAN)
  assert.equal(decoded.wan, null)
  assert.deepEqual(decoded.relay, RELAY)
})

check('rejects truncated and over-long hybrid codes', () => {
  const code = encodeHybridShareCode({ lan: LAN, wan: WAN, relay: RELAY, secret: SECRET })
  assert.equal(decodeShareCode(code.slice(0, code.length - 4)), null)
  assert.equal(decodeShareCode(code + 'AAAA'), null)
})

check('a hybrid code fits the activity partyCode clamp', () => {
  // roomRules caps a presence-carried invite at 600 characters; a hybrid
  // code with a long-but-legal worker host must stay under it or "Watch →
  // Join them" silently truncates the invite into garbage.
  const longRelay = { ...RELAY, url: `https://${'x'.repeat(240)}.workers.dev` }
  const code = encodeHybridShareCode({ lan: LAN, wan: WAN, relay: longRelay, secret: SECRET })
  assert.ok(code.length <= 600, `hybrid code was ${code.length} chars`)
})

check('rejects the JSON codes this format replaced', () => {
  // Deliberate: the JSON path is gone, so an old invite is not a code.
  assert.equal(decodeShareCode(LEGACY_V1), null)
  assert.equal(decodeShareCode(LEGACY_V2), null)
})

check('parses no JSON at all — a valid JSON payload is still not a code', () => {
  const handCrafted = Buffer.from(
    JSON.stringify({ v: 2, relay: RELAY, secret: SECRET, name: 'x' }),
    'utf8'
  ).toString('base64url')
  assert.equal(decodeShareCode(handCrafted), null)
})

check('rejects empty, garbage, and truncated codes', () => {
  const relay = encodeRelayShareCode({ relay: RELAY, secret: SECRET })
  assert.equal(decodeShareCode(''), null)
  assert.equal(decodeShareCode(undefined), null)
  assert.equal(decodeShareCode('not a code at all!!'), null)
  assert.equal(decodeShareCode(relay.slice(0, relay.length - 6)), null)
  assert.equal(decodeShareCode(relay + 'AAAA'), null)
})

check('rejects a code whose format tag is unknown', () => {
  const buf = Buffer.from(encodeShareCode({ lan: LAN, secret: SECRET }), 'base64url')
  buf[0] = 0x39
  assert.equal(decodeShareCode(buf.toString('base64url')), null)
})

check('a flipped bit changes the secret rather than forging an endpoint', () => {
  const code = encodeRelayShareCode({ relay: RELAY, secret: SECRET })
  const buf = Buffer.from(code, 'base64url')
  buf[buf.length - 1] ^= 0x01
  const decoded = decodeShareCode(buf.toString('base64url'))
  assert.ok(decoded && decoded.v === 2)
  assert.notEqual(decoded.secret, SECRET)
})

check('packs a relay URL past 255 bytes, which a one-byte length could not', () => {
  // isValidRelayEndpoint admits up to 300 characters, so the packed form
  // has to cover all of them — there is no longer a longer encoding to
  // retreat to. See relayHostBytes.
  const relay = { url: `https://${'a'.repeat(260)}.example.com`, roomId: RELAY.roomId }
  const decoded = decodeShareCode(encodeRelayShareCode({ relay, secret: SECRET }))
  assert.ok(decoded && decoded.v === 2)
  assert.deepEqual(decoded.relay, relay)
  assert.equal(decoded.secret, SECRET)
})

check('refuses a secret that is not 24 canonical bytes', () => {
  assert.throws(() => encodeShareCode({ lan: LAN, wan: WAN, secret: 'a-short-secret' }))
  assert.throws(() => encodeRelayShareCode({ relay: RELAY, secret: 'a-short-secret' }))
})

check('refuses to encode an invalid endpoint', () => {
  assert.throws(() => encodeShareCode({ lan: { ip: 'no spaces here', port: 1 }, secret: SECRET }))
  assert.throws(() =>
    encodeRelayShareCode({
      relay: { url: 'http://insecure.example', roomId: RELAY.roomId },
      secret: SECRET
    })
  )
})

const IDENTITY = generateIdentity()
const ADMIN = { id: IDENTITY.id, pub: IDENTITY.pub }
const JOIN = crypto.randomUUID()
const ROOM = { relay: RELAY, secret: SECRET, name: 'Movie night', admin: ADMIN, join: JOIN }

check('round-trips a room code', () => {
  const decoded = decodeShareCode(encodeRoomShareCode(ROOM))
  assert.ok(decoded && decoded.v === 4)
  assert.deepEqual(decoded.relay, RELAY)
  assert.equal(decoded.secret, SECRET)
  assert.equal(decoded.name, 'Movie night')
  assert.deepEqual(decoded.admin, ADMIN)
  assert.equal(decoded.join, JOIN)
})

check('round-trips a room code with no join secret', () => {
  const decoded = decodeShareCode(encodeRoomShareCode({ ...ROOM, join: undefined }))
  assert.ok(decoded && decoded.v === 4)
  assert.deepEqual(decoded.admin, ADMIN)
  assert.equal(decoded.join, undefined)
})

check('keeps a non-ASCII room name intact', () => {
  const name = 'Filmabend 🎬 déjà vu'
  const decoded = decodeShareCode(encodeRoomShareCode({ ...ROOM, name }))
  assert.ok(decoded && decoded.v === 4)
  assert.equal(decoded.name, name)
})

check('a room code is far shorter than the JSON it replaces', () => {
  const compact = encodeRoomShareCode(ROOM)
  // What the deleted v4 JSON encoder would have produced for this exact
  // room, reconstructed here so the saving is measured, not asserted.
  const asJson = Buffer.from(JSON.stringify({ v: 4, ...ROOM }), 'utf8').toString('base64url')
  assert.ok(compact.length < asJson.length / 2.5, `${compact.length} vs ${asJson.length}`)
  assert.ok(compact.length < 200, `room code was ${compact.length} chars`)
})

check('the admin id is recomputed from the key, never carried', () => {
  const decoded = decodeShareCode(encodeRoomShareCode(ROOM))
  assert.ok(decoded && decoded.v === 4)
  // The id is sha256 of the raw key, so a packed code cannot express a
  // pair that disagrees — which is exactly the v4 payload's promise.
  assert.equal(decoded.admin.id, idOfRawPub(decoded.admin.pub))
})

check('refuses an admin id that contradicts its key', () => {
  const other = generateIdentity()
  // Not encodable, and never silently rewritten to agree: a caller holding
  // a mismatched pair has a bug, and the id is derived on decode anyway.
  assert.throws(() => encodeRoomShareCode({ ...ROOM, admin: { id: other.id, pub: IDENTITY.pub } }))
})

check('refuses a join secret that is not a UUID', () => {
  assert.throws(() => encodeRoomShareCode({ ...ROOM, join: 'not-a-uuid' }))
})

check('rejects truncated and over-long room codes', () => {
  const code = encodeRoomShareCode(ROOM)
  assert.equal(decodeShareCode(code.slice(0, code.length - 4)), null)
  assert.equal(decodeShareCode(code + 'AAAA'), null)
})

check('refuses to encode a room code with no admin', () => {
  assert.throws(() => encodeRoomShareCode({ ...ROOM, admin: { id: '', pub: '' } }))
})

console.log(`\n${pass} passed`)
