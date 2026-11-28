// Validation for the profile records carried in a backup file. Electron-free
// so it can be unit-tested and used from readBackup (backup.ts).
//
// A backup is a plain JSON file somebody can hand you. Its profiles end up in
// media-hub-settings.json and one of them becomes the active profile, so a
// record that is missing avatarTint, has a non-string name, or carries its own
// pinHash/pinSalt/isKid would either crash the renderer on every launch (the
// top bar reads activeProfile.avatarTint[0] unguarded) or plant attributes the
// person never chose. Every record is therefore rebuilt from an allowlist of
// fields; nothing is copied through as-is.

import type { ProfileRecord } from './profiles'

export const MAX_PROFILE_ID_LENGTH = 128
export const MAX_PROFILE_NAME_LENGTH = 40
export const MAX_BACKUP_PROFILES = 64

const COLOUR = /^#[0-9a-f]{6}$/i
const DEFAULT_TINT: [string, string] = ['#18a9ff', '#8d4dff']

function sanitizeTint(value: unknown): [string, string] {
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((colour) => typeof colour === 'string' && COLOUR.test(colour))
  ) {
    return [String(value[0]).toLowerCase(), String(value[1]).toLowerCase()]
  }
  return [...DEFAULT_TINT]
}

function sanitizeCreatedAt(value: unknown): string {
  if (typeof value === 'string' && value.length <= 64) {
    const time = Date.parse(value)
    if (Number.isFinite(time)) return new Date(time).toISOString()
  }
  return new Date().toISOString()
}

/**
 * Rebuilds one backup profile as a well-formed ProfileRecord, or returns null
 * when it cannot be one (no usable string id). Never carries a PIN: a backup
 * deliberately has none, and one that does is not to be trusted.
 */
export function sanitizeBackupProfile(raw: unknown): ProfileRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const input = raw as Record<string, unknown>

  // Kept exactly as written (not trimmed): every restored row names its owner
  // by this id, and readBackup checks those against it.
  if (typeof input.id !== 'string') return null
  const id = input.id
  if (!id.trim() || id.length > MAX_PROFILE_ID_LENGTH) return null

  // A missing or unusable name is normalised rather than fatal: the rows the
  // profile owns are still worth restoring, and it can be renamed afterwards.
  const name =
    (typeof input.name === 'string' ? input.name.trim().slice(0, MAX_PROFILE_NAME_LENGTH) : '') ||
    'Profile'

  return {
    id,
    name,
    avatarInitial: name[0]?.toUpperCase() || 'P',
    avatarTint: sanitizeTint(input.avatarTint),
    isKid: input.isKid === true,
    createdAt: sanitizeCreatedAt(input.createdAt)
  }
}

/**
 * Every usable profile in a backup's `profiles` value, validated and
 * de-duplicated by id (first wins). Invalid entries are dropped; a value that
 * is not an array yields none.
 */
export function sanitizeBackupProfiles(value: unknown): ProfileRecord[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: ProfileRecord[] = []
  for (const raw of value) {
    const profile = sanitizeBackupProfile(raw)
    if (!profile || seen.has(profile.id)) continue
    seen.add(profile.id)
    result.push(profile)
    if (result.length >= MAX_BACKUP_PROFILES) break
  }
  return result
}
