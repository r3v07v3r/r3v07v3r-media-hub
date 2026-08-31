// Unit tests for the runtime-string parser (src/shared/media-hub/runtime.ts).
// Run with: npx tsx tests/runtimeMinutes.test.ts   (or npm.cmd test)
//
// Worth pinning because the failure is quiet and plausible-looking. The
// renderer used to read this with a bare parseInt, so "1h 40min" became the
// number 1 and every feature film in the library displayed "1 min" — a
// wrong-but-well-formed answer that no type and no assertion would catch.
// The main process's viewing-stats estimate had the same bug for the same
// reason, which is why there is now exactly one parser for both.

import assert from 'node:assert'
import { parseRuntimeMinutes, runtimeMinutesOrZero } from '../src/shared/media-hub/runtime'

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

check('hours-and-minutes forms are read as a whole duration, not their first number', () => {
  // The regression itself: each of these used to come back as 1, 2 or 3.
  assert.strictEqual(parseRuntimeMinutes('1h 40min'), 100)
  assert.strictEqual(parseRuntimeMinutes('2h 15m'), 135)
  assert.strictEqual(parseRuntimeMinutes('3h 22min'), 202)
  assert.strictEqual(parseRuntimeMinutes('1 h 30'), 90)
})

check('an hours-only form carries no phantom minutes', () => {
  assert.strictEqual(parseRuntimeMinutes('2h'), 120)
  assert.strictEqual(parseRuntimeMinutes('2 hours'), 120)
})

check('a plain minute count is taken at face value', () => {
  assert.strictEqual(parseRuntimeMinutes('148'), 148)
  assert.strictEqual(parseRuntimeMinutes('48 min'), 48)
  assert.strictEqual(parseRuntimeMinutes('24 min'), 24)
})

check('case and stray whitespace do not change the answer', () => {
  assert.strictEqual(parseRuntimeMinutes('  2H 15Min '), 135)
})

check('nothing recognisable is undefined rather than a guess', () => {
  for (const value of ['', '   ', 'N/A', 'unknown', null, undefined, {}]) {
    assert.strictEqual(parseRuntimeMinutes(value), undefined, `for ${JSON.stringify(value)}`)
  }
})

check('a zero runtime is no runtime — never a title that lasts no time', () => {
  assert.strictEqual(parseRuntimeMinutes('0'), undefined)
  assert.strictEqual(parseRuntimeMinutes('0 min'), undefined)
  assert.strictEqual(parseRuntimeMinutes('0h 0m'), undefined)
})

check('the summing variant contributes nothing for an unreadable value', () => {
  assert.strictEqual(runtimeMinutesOrZero('N/A'), 0)
  assert.strictEqual(runtimeMinutesOrZero(undefined), 0)
  // ...and still agrees with the parser wherever there IS an answer, which is
  // the whole reason the stats total can be trusted against what the cards show.
  assert.strictEqual(runtimeMinutesOrZero('2h 15m'), 135)
})

console.log(`\n${pass} checks passed`)
