import assert from 'node:assert'
import {
  admissionVerdict,
  isRelayMessageWithinLimit,
  MAX_KNOWN_MEMBERS,
  MAX_RELAY_MESSAGES_PER_WINDOW,
  MAX_RELAY_MESSAGE_BYTES,
  nextRelayMessageRate,
  RELAY_RATE_WINDOW_MS
} from '../party-sync-worker/src/room.ts'

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

console.log('party relay message bounds')
check('allows a payload at the byte limit', () =>
  assert.equal(isRelayMessageWithinLimit('a'.repeat(MAX_RELAY_MESSAGE_BYTES)), true)
)
check('rejects a payload one byte above the limit', () =>
  assert.equal(isRelayMessageWithinLimit('a'.repeat(MAX_RELAY_MESSAGE_BYTES + 1)), false)
)
check('counts UTF-8 bytes instead of JavaScript code units', () =>
  assert.equal(
    isRelayMessageWithinLimit('😀'.repeat(Math.ceil(MAX_RELAY_MESSAGE_BYTES / 2))),
    false
  )
)
check('enforces a per-connection message rate', () => {
  const startedAt = 1_000
  const atLimit = nextRelayMessageRate(startedAt, MAX_RELAY_MESSAGES_PER_WINDOW - 1, startedAt + 1)
  assert.equal(atLimit.allowed, true)
  const overLimit = nextRelayMessageRate(
    atLimit.windowStartedAt,
    atLimit.windowMessageCount,
    startedAt + 2
  )
  assert.equal(overLimit.allowed, false)
})
check('resets a message rate after its window closes', () => {
  const rate = nextRelayMessageRate(
    1_000,
    MAX_RELAY_MESSAGES_PER_WINDOW,
    1_000 + RELAY_RATE_WINDOW_MS
  )
  assert.deepEqual(rate, {
    allowed: true,
    windowStartedAt: 1_000 + RELAY_RATE_WINDOW_MS,
    windowMessageCount: 1
  })
})

// --- the membership gate ----------------------------------------------------
//
// The admission POLICY, given an identity the cryptogram layer has
// already VERIFIED (signature, freshness, counter — pinned separately
// in tests/rooms.test.ts against the client mirror, and end-to-end in
// kick.e2e.ts against this worker's own verifier). Each row closes a
// specific door — docs/ROOMS.md names them.

const ID = 'a'.repeat(64)
const OTHER_ID = 'b'.repeat(64)
const JOIN = 'join-secret-current'

check('a legacy room (no joinSecret) admits anyone, as it always has', () => {
  assert.strictEqual(
    admissionVerdict({
      currentJoinSecret: null,
      verifiedId: null,
      presentedJoinSecret: null,
      known: new Set(),
      banned: new Set()
    }),
    'admit'
  )
})

check('a membership room refuses a connection with no verified identity', () => {
  assert.strictEqual(
    admissionVerdict({
      currentJoinSecret: JOIN,
      verifiedId: null,
      presentedJoinSecret: JOIN,
      known: new Set(),
      banned: new Set()
    }),
    'refuse',
    'the joinSecret alone admits nobody — possession proof is not optional'
  )
})

check('banned wins over everything — even the current joinSecret', () => {
  assert.strictEqual(
    admissionVerdict({
      currentJoinSecret: JOIN,
      verifiedId: ID,
      presentedJoinSecret: JOIN,
      known: new Set([ID]),
      banned: new Set([ID])
    }),
    'refuse'
  )
})

check(
  'a known identity is admitted with a STALE joinSecret — rotation gates strangers, not members',
  () => {
    assert.strictEqual(
      admissionVerdict({
        currentJoinSecret: JOIN,
        verifiedId: ID,
        presentedJoinSecret: 'stale-after-a-kick',
        known: new Set([ID]),
        banned: new Set()
      }),
      'admit'
    )
  }
)

check('a stranger with the current joinSecret is admitted and registered', () => {
  assert.strictEqual(
    admissionVerdict({
      currentJoinSecret: JOIN,
      verifiedId: OTHER_ID,
      presentedJoinSecret: JOIN,
      known: new Set([ID]),
      banned: new Set()
    }),
    'admit-and-register'
  )
})

check('a stranger without it is refused', () => {
  assert.strictEqual(
    admissionVerdict({
      currentJoinSecret: JOIN,
      verifiedId: OTHER_ID,
      presentedJoinSecret: 'stale-or-guessed',
      known: new Set([ID]),
      banned: new Set()
    }),
    'refuse'
  )
})

check('registration stops at the cap — a room of 256 installs is not a household', () => {
  const known = new Set<string>()
  for (let i = 0; i < MAX_KNOWN_MEMBERS; i++) known.add(String(i).padStart(64, '0'))
  assert.strictEqual(
    admissionVerdict({
      currentJoinSecret: JOIN,
      verifiedId: 'c'.repeat(64),
      presentedJoinSecret: JOIN,
      known,
      banned: new Set()
    }),
    'refuse'
  )
})

console.log(`\n${pass} passed`)
