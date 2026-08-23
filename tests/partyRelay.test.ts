import assert from 'node:assert'
import {
  isRelayMessageWithinLimit,
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

console.log(`\n${pass} passed`)
