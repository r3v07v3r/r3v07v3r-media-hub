import assert from 'node:assert'
import crypto from 'node:crypto'
import {
  decodeShareCode,
  encodeRelayShareCodeV3,
  encodeShareCodeV3
} from '../src/main/media-hub/party.ts'

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

// Real codes minted before the compact format existed. They are pasted as
// literals rather than re-encoded so this stays a genuine compatibility test.
const LEGACY_V1 =
  'eyJ2IjoxLCJsYW4iOnsiaXAiOiIxOTIuMTY4LjEuNTAiLCJwb3J0Ijo1NDMyMX0sIndhbiI6eyJpcCI6IjIwMy4wLjExMy45IiwicG9ydCI6NDEyMzR9LCJzZWNyZXQiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBUSIsIm5hbWUiOiJHcmFoYW0ifQ'
const LEGACY_V2 =
  'eyJ2IjoyLCJyZWxheSI6eyJ1cmwiOiJodHRwczovL3BhcnR5LXN5bmMuZXhhbXBsZS53b3JrZXJzLmRldiIsInJvb21JZCI6IjJmMWM5YTRlLThiN2QtNGMzYS05ZTZmLTBhMWIyYzNkNGU1ZiJ9LCJzZWNyZXQiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBUSIsIm5hbWUiOiJHcmFoYW0ifQ'

console.log('party share codes')

check('round-trips a relay code', () => {
  const decoded = decodeShareCode(encodeRelayShareCodeV3({ relay: RELAY, secret: SECRET }))
  assert.ok(decoded && decoded.v === 2)
  assert.deepEqual(decoded.relay, RELAY)
  assert.equal(decoded.secret, SECRET)
})

check('round-trips a direct code with a WAN endpoint', () => {
  const decoded = decodeShareCode(encodeShareCodeV3({ lan: LAN, wan: WAN, secret: SECRET }))
  assert.ok(decoded && decoded.v === 1)
  assert.deepEqual(decoded.lan, LAN)
  assert.deepEqual(decoded.wan, WAN)
  assert.equal(decoded.secret, SECRET)
})

check('round-trips a direct code with no WAN endpoint', () => {
  const decoded = decodeShareCode(encodeShareCodeV3({ lan: LAN, wan: null, secret: SECRET }))
  assert.ok(decoded && decoded.v === 1)
  assert.deepEqual(decoded.lan, LAN)
  assert.equal(decoded.wan, null)
})

check('keeps an IPv6 LAN address intact', () => {
  const lan = { ip: 'fe80::1c2d:3e4f:5a6b:7c8d', port: 8080 }
  const decoded = decodeShareCode(encodeShareCodeV3({ lan, secret: SECRET }))
  assert.ok(decoded && decoded.v === 1)
  assert.deepEqual(decoded.lan, lan)
})

check('is far shorter than the codes it replaces', () => {
  const relay = encodeRelayShareCodeV3({ relay: RELAY, secret: SECRET })
  const direct = encodeShareCodeV3({ lan: LAN, wan: WAN, secret: SECRET })
  assert.ok(relay.length < 110, `relay code was ${relay.length} chars`)
  assert.ok(direct.length < 70, `direct code was ${direct.length} chars`)
  assert.ok(relay.length < LEGACY_V2.length / 1.7)
  assert.ok(direct.length < LEGACY_V1.length / 1.7)
})

check('still decodes a legacy v1 code', () => {
  const decoded = decodeShareCode(LEGACY_V1)
  assert.ok(decoded && decoded.v === 1)
  assert.deepEqual(decoded.lan, LAN)
  assert.deepEqual(decoded.wan, WAN)
  assert.equal(decoded.name, 'Graham')
})

check('still decodes a legacy v2 code', () => {
  const decoded = decodeShareCode(LEGACY_V2)
  assert.ok(decoded && decoded.v === 2)
  assert.deepEqual(decoded.relay, RELAY)
  assert.equal(decoded.name, 'Graham')
})

check('rejects empty, garbage, and truncated codes', () => {
  const relay = encodeRelayShareCodeV3({ relay: RELAY, secret: SECRET })
  assert.equal(decodeShareCode(''), null)
  assert.equal(decodeShareCode(undefined), null)
  assert.equal(decodeShareCode('not a code at all!!'), null)
  assert.equal(decodeShareCode(relay.slice(0, relay.length - 6)), null)
  assert.equal(decodeShareCode(relay + 'AAAA'), null)
})

check('rejects a code whose format tag is unknown', () => {
  const buf = Buffer.from(encodeShareCodeV3({ lan: LAN, secret: SECRET }), 'base64url')
  buf[0] = 0x39
  assert.equal(decodeShareCode(buf.toString('base64url')), null)
})

check('a flipped bit changes the secret rather than forging an endpoint', () => {
  const code = encodeRelayShareCodeV3({ relay: RELAY, secret: SECRET })
  const buf = Buffer.from(code, 'base64url')
  buf[buf.length - 1] ^= 0x01
  const decoded = decodeShareCode(buf.toString('base64url'))
  assert.ok(decoded && decoded.v === 2)
  assert.notEqual(decoded.secret, SECRET)
})

check('falls back to the legacy form when the URL is too long to pack', () => {
  const relay = { url: `https://${'a'.repeat(260)}.example.com`, roomId: RELAY.roomId }
  const decoded = decodeShareCode(encodeRelayShareCodeV3({ relay, secret: SECRET }))
  assert.ok(decoded && decoded.v === 2)
  assert.deepEqual(decoded.relay, relay)
  assert.equal(decoded.secret, SECRET)
})

check('falls back to the legacy form for a non-standard secret', () => {
  const secret = 'a-short-secret'
  const decoded = decodeShareCode(encodeShareCodeV3({ lan: LAN, wan: WAN, secret }))
  assert.ok(decoded && decoded.v === 1)
  assert.equal(decoded.secret, secret)
  assert.deepEqual(decoded.wan, WAN)
})

check('refuses to encode an invalid endpoint', () => {
  assert.throws(() => encodeShareCodeV3({ lan: { ip: 'no spaces here', port: 1 }, secret: SECRET }))
  assert.throws(() =>
    encodeRelayShareCodeV3({
      relay: { url: 'http://insecure.example', roomId: RELAY.roomId },
      secret: SECRET
    })
  )
})

console.log(`\n${pass} passed`)
