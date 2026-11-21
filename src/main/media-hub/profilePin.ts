// Profile PIN hashing, verification and the attempt lockout. Kept apart
// from profiles.ts (which needs Electron through the settings store) so the
// gate itself can be unit-tested.

import crypto from 'node:crypto'
import type { ProfileRecord } from './profiles'

export function hashPin(pin: string, salt: string): string {
  return crypto.scryptSync(pin, salt, 64).toString('hex')
}

export function verifyPin(record: ProfileRecord, pin: string): boolean {
  if (!record.pinHash || !record.pinSalt) return true
  const candidate = hashPin(pin, record.pinSalt)
  const a = Buffer.from(candidate, 'hex')
  const b = Buffer.from(record.pinHash, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// A 4-digit PIN is only 10,000 combinations — with nothing gating repeated
// attempts, a script could brute-force it via profilesVerifyPin/
// profilesSetActive in well under a second, defeating the PIN-lock's whole
// point (see this file's own header comment on what it's meant to gate:
// a casual "confirm it's really you" check, not something meant to survive
// a determined attacker, but it should at least survive a trivial loop).
// In-memory and per-profile, not persisted: resets on app restart, which is
// fine for this threat model and avoids a settings-schema change.
const MAX_PIN_ATTEMPTS = 5
const PIN_LOCKOUT_MS = 30_000
export const pinAttempts = new Map<string, { count: number; lockedUntil: number }>()

export function assertNotLockedOut(profileId: string): void {
  const state = pinAttempts.get(profileId)
  if (!state || state.lockedUntil <= Date.now()) return
  const seconds = Math.ceil((state.lockedUntil - Date.now()) / 1000)
  throw new Error(`Too many incorrect PIN attempts. Try again in ${seconds}s.`)
}

export function recordPinAttempt(profileId: string, ok: boolean): void {
  if (ok) {
    pinAttempts.delete(profileId)
    return
  }
  const state = pinAttempts.get(profileId) ?? { count: 0, lockedUntil: 0 }
  state.count += 1
  if (state.count >= MAX_PIN_ATTEMPTS) {
    state.lockedUntil = Date.now() + PIN_LOCKOUT_MS
    state.count = 0
  }
  pinAttempts.set(profileId, state)
}

/**
 * The gate every change to a PIN-locked profile goes through. Without it,
 * anyone using an unlocked profile could clear or replace another
 * profile's PIN (or delete it) from Settings and then switch in freely —
 * which made the PIN on profilesSetActive decorative. Enforced here in
 * main, with the same lockout as switching, rather than only in the UI.
 */
export function requireProfilePin(
  target: ProfileRecord,
  pin: unknown,
  check: (record: ProfileRecord, pin: string) => boolean = verifyPin
): void {
  if (!target.pinHash) return
  if (typeof pin !== 'string' || !pin) {
    throw new Error('Enter the current PIN for this profile.')
  }
  assertNotLockedOut(target.id)
  const ok = check(target, pin)
  recordPinAttempt(target.id, ok)
  if (!ok) throw new Error('Incorrect PIN.')
}
