// What the app sends to the tracking services on its own, and what it keeps
// when a send fails.
//
// Scrobbles are opt-in. A finished episode reaches Simkl and Trakt as a
// history add at 80% whatever the setting says; scrobbles are a start, a stop
// and a pause and resume pair per pause on top of that, per service, and
// Simkl counts every one against an allowance of 500 requests a day that a
// linked phone shares. So the default, for every install that has never been
// asked, is off (preferences.ts's scrobblingEnabled, which the scrobble
// handler in tracking.ts reads before sending anything).
//
// Run with: npx tsx tests/trackingPushes.test.ts

import assert from 'node:assert/strict'

import { scrobblingEnabled } from '../src/main/media-hub/preferences'

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

// --- scrobbles are opt-in ---------------------------------------------------

check('a settings file that has never been asked sends no scrobbles', () => {
  assert.equal(scrobblingEnabled({}), false)
  assert.equal(scrobblingEnabled(), false)
})

check('only an explicit yes turns them on', () => {
  assert.equal(scrobblingEnabled({ scrobbleEnabled: true }), true)
  assert.equal(scrobblingEnabled({ scrobbleEnabled: false }), false)
  // A hand-edited file is not a yes.
  assert.equal(scrobblingEnabled({ scrobbleEnabled: 'true' }), false)
  assert.equal(scrobblingEnabled({ scrobbleEnabled: 1 }), false)
})

console.log(`\n${pass} passing`)
