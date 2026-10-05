// The quick status actions on a card — Plan to watch and Not interested —
// and what keeps them easy to take back.
//
// Pinned here: the toast each one raises carries an Undo that runs exactly
// the reversal it was given, and it goes away by itself after a few seconds
// rather than waiting to be dismissed like the whole-show Undo does
// (statusToasts.ts, OverlayContext's notificationTtlMs). Removing a dislike
// offers no Undo: it is already the way back.
//
// Run with: npx tsx tests/statusActions.test.ts

import assert from 'node:assert/strict'

import {
  dislikedToast,
  plannedToast,
  QUICK_UNDO_MS
} from '../src/renderer/src/lib/mediaHub/statusToasts'
import { notificationTtlMs } from '../src/renderer/src/context/OverlayContext'

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

// --- undo toasts -------------------------------------------------------------

check('a plan toast names the title, is bound to the profile and undoes the plan', () => {
  let undone = 0
  const toast = plannedToast({ title: 'Dune' }, 'p1', () => undone++)
  assert.match(toast.message, /"Dune" is on your plan/)
  assert.equal(toast.profileId, 'p1')
  assert.equal(toast.action?.label, 'Undo')
  toast.action?.run()
  assert.equal(undone, 1)
})

check('a dislike toast carries an Undo that takes the dislike back', () => {
  let undone = 0
  const toast = dislikedToast({ title: 'Dune' }, true, 'p1', () => undone++)
  assert.equal(toast.action?.label, 'Undo')
  assert.equal(toast.profileId, 'p1')
  assert.match(toast.message, /won't be recommended/)
  toast.action?.run()
  assert.equal(undone, 1)
})

check('removing a dislike says so and offers no Undo', () => {
  const toast = dislikedToast({ title: 'Dune' }, false, 'p1', () => {
    throw new Error('not offered')
  })
  assert.equal(toast.action, undefined)
  assert.match(toast.message, /see "Dune" again/)
})

check('the quick Undo toasts leave by themselves; other Undo toasts still wait', () => {
  const planned = plannedToast({ title: 'Dune' }, 'p1', () => {})
  const disliked = dislikedToast({ title: 'Dune' }, true, 'p1', () => {})
  assert.equal(notificationTtlMs(planned), QUICK_UNDO_MS)
  assert.equal(notificationTtlMs(disliked), QUICK_UNDO_MS)
  // The whole-show mark's Undo names no duration and stays until used.
  assert.equal(
    notificationTtlMs({ tone: 'success', action: { label: 'Undo', run: () => {} } }),
    null
  )
  assert.ok((notificationTtlMs({ tone: 'info' }) ?? 0) > 0)
})

console.log(`\n${pass} passed`)
