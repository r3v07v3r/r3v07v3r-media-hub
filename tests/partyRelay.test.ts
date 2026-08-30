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
// The admission matrix is the whole point of relay-level membership: a
// ban the relay does not enforce is theatre. Each row here closes a
// specific door — docs/ROOMS.md in the main app names them.

const KEY = 'member-key-000001'
const OTHER = 'member-key-000002'
const JOIN = 'join-secret-current'

check('a legacy room (no joinSecret) admits anyone, as it always has', () => {
  assert.strictEqual(
    admissionVerdict({
      currentJoinSecret: null,
      memberKey: null,
      presentedJoinSecret: null,
      known: new Set(),
      banned: new Set()
    }),
    'admit'
  )
})

check('a membership room refuses a connection with no identity', () => {
  assert.strictEqual(
    admissionVerdict({
      currentJoinSecret: JOIN,
      memberKey: null,
      presentedJoinSecret: JOIN,
      known: new Set(),
      banned: new Set()
    }),
    'refuse'
  )
})

check('banned wins over everything — even the current joinSecret', () => {
  assert.strictEqual(
    admissionVerdict({
      currentJoinSecret: JOIN,
      memberKey: KEY,
      presentedJoinSecret: JOIN,
      known: new Set([KEY]),
      banned: new Set([KEY])
    }),
    'refuse'
  )
})

check(
  'a known member is admitted with a STALE joinSecret — rotation gates strangers, not members',
  () => {
    assert.strictEqual(
      admissionVerdict({
        currentJoinSecret: JOIN,
        memberKey: KEY,
        presentedJoinSecret: 'stale-after-a-kick',
        known: new Set([KEY]),
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
      memberKey: OTHER,
      presentedJoinSecret: JOIN,
      known: new Set([KEY]),
      banned: new Set()
    }),
    'admit-and-register'
  )
})

check('a stranger without it is refused', () => {
  assert.strictEqual(
    admissionVerdict({
      currentJoinSecret: JOIN,
      memberKey: OTHER,
      presentedJoinSecret: 'stale-or-guessed',
      known: new Set([KEY]),
      banned: new Set()
    }),
    'refuse'
  )
})

check('registration stops at the cap — a room of 256 installs is not a household', () => {
  const known = new Set<string>()
  for (let i = 0; i < MAX_KNOWN_MEMBERS; i++) known.add(`member-key-${String(i).padStart(6, '0')}`)
  assert.strictEqual(
    admissionVerdict({
      currentJoinSecret: JOIN,
      memberKey: 'member-key-overflow1',
      presentedJoinSecret: JOIN,
      known,
      banned: new Set()
    }),
    'refuse'
  )
})

console.log(`\n${pass} passed`)
