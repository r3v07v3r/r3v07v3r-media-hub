import assert from 'node:assert'
import { isRelayMessageWithinLimit, MAX_RELAY_MESSAGE_BYTES } from '../party-sync-worker/src/room'

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

console.log(`\n${pass} passed`)
