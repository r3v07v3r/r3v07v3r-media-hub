// Regression tests for the 2026-11-21 security-scan fixes that have no
// better home: the profile PIN gate on edit/delete.
// Run with: npx tsx tests/securityHardening.test.ts   (or npm.cmd test)

import assert from 'node:assert/strict'
import { hashPin, requireProfilePin } from '../src/main/media-hub/profilePin'
import type { ProfileRecord } from '../src/main/media-hub/profiles'

// --- profile PIN gate (F3/F11/F18) -----------------------------------------
{
  const salt = 'ab'.repeat(16)
  const locked: ProfileRecord = {
    id: 'locked-profile',
    name: 'Locked',
    avatarInitial: 'L',
    avatarTint: ['#000000', '#ffffff'],
    isKid: false,
    pinSalt: salt,
    pinHash: hashPin('4321', salt),
    createdAt: new Date(0).toISOString()
  }
  const open: ProfileRecord = { ...locked, id: 'open-profile' }
  delete open.pinHash
  delete open.pinSalt

  assert.doesNotThrow(() => requireProfilePin(open, undefined), 'an unlocked profile needs no PIN')
  assert.throws(
    () => requireProfilePin(locked, undefined),
    /current PIN/,
    'a locked profile cannot be edited or deleted without its PIN'
  )
  assert.throws(() => requireProfilePin(locked, ''), /current PIN/)
  assert.throws(() => requireProfilePin(locked, { length: 4 }), /current PIN/)
  assert.throws(() => requireProfilePin(locked, '0000'), /Incorrect PIN/)
  assert.doesNotThrow(() => requireProfilePin(locked, '4321'), 'the right PIN passes')

  // Same lockout as switching: five wrong guesses lock even the right PIN out.
  const target: ProfileRecord = { ...locked, id: 'lockout-profile' }
  for (let i = 0; i < 5; i++) assert.throws(() => requireProfilePin(target, '0000'))
  assert.throws(() => requireProfilePin(target, '4321'), /Too many incorrect PIN attempts/)
}

console.log('ok  security hardening')
