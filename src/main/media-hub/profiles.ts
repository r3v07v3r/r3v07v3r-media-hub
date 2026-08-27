// Real device-profile backend: persistence, CRUD, and PIN-lock. New — not a
// port of anything in the original app (that app had no multi-profile
// concept at all; profiles were previously pure UI/mock state in this
// project's renderer, see AppStateContext.tsx's history).
//
// Deliberate scope boundary: watch history/tracking (src/main/media-hub/
// database.ts's `tracked`/`watch_history` tables) has NO profile column and
// stays global across every profile in this pass — both tables use a bare
// content-id/watch-key as their primary key with no per-profile scoping.
// Making history genuinely per-profile needs a schema migration (composite
// keys + backfill) and threading a profileId through every call site in
// database.ts/catalog.ts/tracking.ts/torbox.ts/malSync.ts — a real, sizeable
// follow-up, not attempted here. What IS real here: which profile is
// "active" persists across restarts, and a PIN genuinely gates switching
// into a locked profile.
//
// PIN hashing deliberately does NOT reuse settingsStore.ts's encrypt()/
// decrypt() — those wrap safeStorage, which is REVERSIBLE (the app needs
// the plaintext back for API tokens). A PIN only ever needs to be verified,
// never read back, so a one-way scrypt hash + a random per-profile salt is
// the correct primitive here, and it works identically in headless/dev
// environments with no OS keyring (unlike safeStorage, which needs a
// fallback path for that case).

import crypto from 'node:crypto'
import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import type {
  ProfilePublic,
  ProfilesListResult,
  ProfileSetActiveResult,
  ProfileVerifyPinResult
} from '../../shared/media-hub/types'
import { getDatabase } from './dbState'
import { handle } from './ipcGuard'
import { readSettings, writeSettings } from './settingsStore'

/** Main-process-only shape — carries the PIN hash/salt. Never sent to the renderer; see ProfilePublic for that. */
export interface ProfileRecord {
  id: string
  name: string
  avatarInitial: string
  avatarTint: [string, string]
  isKid: boolean
  pinSalt?: string
  pinHash?: string
  createdAt: string
}

const DEFAULT_TINTS: [string, string][] = [
  ['#18a9ff', '#8d4dff'],
  ['#ff4fa7', '#8d4dff'],
  ['#f4cb45', '#ff7a28'],
  ['#27e69a', '#18a9ff'],
  ['#8d4dff', '#38e5ff']
]

function toPublic(record: ProfileRecord): ProfilePublic {
  return {
    id: record.id,
    name: record.name,
    avatarInitial: record.avatarInitial,
    avatarTint: record.avatarTint,
    isKid: record.isKid,
    hasPin: Boolean(record.pinHash)
  }
}

/** Seeds one real default profile the first time this is ever read (replacing the old hardcoded mock array) — never re-seeds once a `profiles` array exists, even an empty one after every profile was deleted (deletion itself is blocked below when only one remains, so that can't actually happen, but the guard is here for clarity). */
function ensureProfiles(): { profiles: ProfileRecord[]; activeProfileId: string } {
  const settings = readSettings()
  if (settings.profiles && settings.profiles.length > 0) {
    const activeProfileId =
      settings.activeProfileId && settings.profiles.some((p) => p.id === settings.activeProfileId)
        ? settings.activeProfileId
        : settings.profiles[0].id
    return { profiles: settings.profiles, activeProfileId }
  }
  const seeded: ProfileRecord = {
    id: crypto.randomUUID(),
    name: 'Profile 1',
    avatarInitial: 'P',
    avatarTint: DEFAULT_TINTS[0],
    isKid: false,
    createdAt: new Date().toISOString()
  }
  settings.profiles = [seeded]
  settings.activeProfileId = seeded.id
  writeSettings(settings)
  return { profiles: [seeded], activeProfileId: seeded.id }
}

/**
 * Which profile the app is currently acting as.
 *
 * Exported for main/index.ts, which needs it before the database exists —
 * the connection is scoped to a profile from the moment it opens, and the
 * profile-scoping migration attributes every pre-existing row to it.
 */
export function activeProfileId(): string {
  return ensureProfiles().activeProfileId
}

function hashPin(pin: string, salt: string): string {
  return crypto.scryptSync(pin, salt, 64).toString('hex')
}

function verifyPin(record: ProfileRecord, pin: string): boolean {
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
const pinAttempts = new Map<string, { count: number; lockedUntil: number }>()

function assertNotLockedOut(profileId: string): void {
  const state = pinAttempts.get(profileId)
  if (!state || state.lockedUntil <= Date.now()) return
  const seconds = Math.ceil((state.lockedUntil - Date.now()) / 1000)
  throw new Error(`Too many incorrect PIN attempts. Try again in ${seconds}s.`)
}

function recordPinAttempt(profileId: string, ok: boolean): void {
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

interface SetActiveArgs {
  id?: string
  pin?: string
}

interface CreateArgs {
  name?: string
  avatarInitial?: string
  avatarTint?: [string, string]
  isKid?: boolean
  pin?: string
}

interface UpdateArgs {
  id?: string
  name?: string
  avatarTint?: [string, string]
  isKid?: boolean
  pin?: string | null // null explicitly clears an existing PIN
}

interface DeleteArgs {
  id?: string
}

interface VerifyPinArgs {
  id?: string
  pin?: string
}

export function registerProfilesIpc(): void {
  handle<undefined, ProfilesListResult>(MEDIA_HUB_CHANNELS.profilesList, () => {
    const { profiles, activeProfileId } = ensureProfiles()
    return { profiles: profiles.map(toPublic), activeProfileId }
  })

  handle<undefined, ProfileSetActiveResult>(MEDIA_HUB_CHANNELS.profilesGetActive, () => {
    const { activeProfileId } = ensureProfiles()
    return { ok: true, activeProfileId }
  })

  handle<SetActiveArgs, ProfileSetActiveResult>(
    MEDIA_HUB_CHANNELS.profilesSetActive,
    (_event, payload) => {
      const { profiles } = ensureProfiles()
      const id = String(payload?.id || '')
      const target = profiles.find((p) => p.id === id)
      if (!target) throw new Error('That profile no longer exists.')
      if (target.pinHash) {
        assertNotLockedOut(id)
        const ok = verifyPin(target, String(payload?.pin || ''))
        recordPinAttempt(id, ok)
        if (!ok) throw new Error('Incorrect PIN.')
      }
      const settings = readSettings()
      settings.activeProfileId = id
      writeSettings(settings)
      // The database is scoped to one profile at a time (see its
      // setActiveProfile). Re-scoping it here, in the same handler that
      // records the switch, is what makes a profile's library actually its
      // own — without it the setting would change and every query would keep
      // answering for whoever was active at launch.
      getDatabase().setActiveProfile(id)
      return { ok: true, activeProfileId: id }
    }
  )

  handle<CreateArgs, ProfilePublic>(MEDIA_HUB_CHANNELS.profilesCreate, (_event, payload) => {
    const { profiles } = ensureProfiles()
    const name = String(payload?.name || '')
      .trim()
      .slice(0, 40)
    if (!name) throw new Error('Give the profile a name.')
    const pin = payload?.pin ? String(payload.pin) : ''
    if (pin && !/^\d{4,8}$/.test(pin)) throw new Error('PIN must be 4-8 digits.')
    const tint = DEFAULT_TINTS[profiles.length % DEFAULT_TINTS.length]
    const record: ProfileRecord = {
      id: crypto.randomUUID(),
      name,
      avatarInitial: name[0]?.toUpperCase() || 'P',
      avatarTint: payload?.avatarTint || tint,
      isKid: Boolean(payload?.isKid),
      createdAt: new Date().toISOString()
    }
    if (pin) {
      const salt = crypto.randomBytes(16).toString('hex')
      record.pinSalt = salt
      record.pinHash = hashPin(pin, salt)
    }
    const settings = readSettings()
    settings.profiles = [...profiles, record]
    writeSettings(settings)
    return toPublic(record)
  })

  handle<UpdateArgs, ProfilePublic>(MEDIA_HUB_CHANNELS.profilesUpdate, (_event, payload) => {
    const { profiles } = ensureProfiles()
    const id = String(payload?.id || '')
    const index = profiles.findIndex((p) => p.id === id)
    if (index === -1) throw new Error('That profile no longer exists.')
    const existing = profiles[index]
    const updated: ProfileRecord = { ...existing }
    if (payload?.name !== undefined) {
      const name = String(payload.name).trim().slice(0, 40)
      if (!name) throw new Error('Give the profile a name.')
      updated.name = name
      updated.avatarInitial = name[0]?.toUpperCase() || existing.avatarInitial
    }
    if (payload?.avatarTint) updated.avatarTint = payload.avatarTint
    if (payload?.isKid !== undefined) updated.isKid = payload.isKid
    if (payload?.pin === null) {
      delete updated.pinSalt
      delete updated.pinHash
    } else if (payload?.pin) {
      const pin = String(payload.pin)
      if (!/^\d{4,8}$/.test(pin)) throw new Error('PIN must be 4-8 digits.')
      const salt = crypto.randomBytes(16).toString('hex')
      updated.pinSalt = salt
      updated.pinHash = hashPin(pin, salt)
    }
    const settings = readSettings()
    const next = [...profiles]
    next[index] = updated
    settings.profiles = next
    writeSettings(settings)
    return toPublic(updated)
  })

  handle<DeleteArgs, ProfilesListResult>(MEDIA_HUB_CHANNELS.profilesDelete, (_event, payload) => {
    const { profiles, activeProfileId } = ensureProfiles()
    const id = String(payload?.id || '')
    if (profiles.length <= 1) throw new Error('At least one profile must remain.')
    if (id === activeProfileId) {
      throw new Error('Switch to a different profile before deleting this one.')
    }
    const remaining = profiles.filter((p) => p.id !== id)
    if (remaining.length === profiles.length) throw new Error('That profile no longer exists.')
    // The rows BEFORE the settings entry, so a failure leaves a profile that
    // still owns its data rather than data owned by a profile that no longer
    // exists. Everything a profile owns goes with it: leaving it behind means
    // a library nothing can reach, which the next backup would faithfully
    // export and a re-created profile would never see.
    getDatabase().deleteProfileData(id)
    const settings = readSettings()
    settings.profiles = remaining
    writeSettings(settings)
    pinAttempts.delete(id)
    return { profiles: remaining.map(toPublic), activeProfileId }
  })

  handle<VerifyPinArgs, ProfileVerifyPinResult>(
    MEDIA_HUB_CHANNELS.profilesVerifyPin,
    (_event, payload) => {
      const { profiles } = ensureProfiles()
      const id = String(payload?.id || '')
      const target = profiles.find((p) => p.id === id)
      if (!target) return { ok: false }
      assertNotLockedOut(id)
      const ok = verifyPin(target, String(payload?.pin || ''))
      recordPinAttempt(id, ok)
      return { ok }
    }
  )
}
