// Ported from r3v07v3r-media-hub's src/main.cjs (readSettings/writeSettings/
// encrypt/decrypt/token/simklCredentials/malCredentials/tmdbCredentials/
// osCredentials/partySyncCredentials/clearTorBoxToken). Deliberately kept as
// its own hand-rolled JSON file (media-hub-settings.json under userData)
// rather than folded into this project's existing `electron-store`-backed
// ipc/settings.ts — that store is a separate, unrelated settings surface
// (Jellyfin/Sonarr/Radarr/qBittorrent, see MediaServicesSection) that must
// be left alone per the integration plan; this is the media-hub backend's
// own settings file, matching the original app's on-disk shape so any
// TODOs/behavior ported from main.cjs stay traceable field-for-field.
//
// One deliberate behavior change from the original: the original hard-
// throws ("Windows secure storage is unavailable.") if
// safeStorage.isEncryptionAvailable() is false. That's fine for a shipped
// desktop build (safeStorage is available on every supported OS once a
// real user session/keyring exists) but crashes outright in headless/CI/
// no-keyring dev environments. Here, encrypt() falls back to a clearly
// tagged reversible encoding instead of throwing, so the app keeps working
// in dev — see ENCRYPTION_UNAVAILABLE_PREFIX below.

import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import { logError } from './logger'
import { sendToRenderer } from './rendererBridge'
import type { ProfileRecord } from './profiles'

export interface MediaHubRawSettings {
  onboardingVersion?: number
  torboxToken?: string
  simklClientId?: string
  simklAccessToken?: string
  malClientId?: string
  malClientSecret?: string
  malAccessToken?: string
  malRefreshToken?: string
  malTokenExpiresAt?: number
  tmdbApiKey?: string
  omdbApiKey?: string
  osApiKey?: string
  osUsername?: string
  osPassword?: string
  osToken?: string
  partySyncUrl?: string
  partySyncInviteKey?: string
  partyDisplayName?: string
  /** Stable per-install identity for friends groups. The relay's connId
   *  changes every connection, so presence needs something durable to
   *  recognise the same person by. Not a secret and never leaves the
   *  group's encrypted channel. */
  friendId?: string
  /** The friends group this install belongs to, as a v2 relay share code. */
  friendsGroupCode?: string
  /** Opt-in: publish what this device is watching to the group. Off means
   *  the activity field is omitted entirely, so "not sharing" is
   *  indistinguishable from "not watching". */
  friendsShareActivity?: boolean
  theme?: string
  subtitleLanguage?: string
  audioLanguage?: string
  updateChannel?: string
  playbackBuffer?: string
  autoSubtitlesEnabled?: boolean
  uiAnimationsEnabled?: boolean
  performancePanelVisible?: boolean
  videoTranscodeEnabled?: boolean
  maxStreamResolution?: number
  maxStreamSizeGb?: number
  connectionSpeedMbps?: number
  preferredUpscaleHeight?: number
  /** How much local disk streamCache.ts is allowed to use for the local
   *  rolling playback cache (see playbackSession.ts's
   *  resolveStreamCacheMaxBytes). Distinct from maxStreamSizeGb above,
   *  which filters which torrent releases get selected, not how they're
   *  cached once playing. 0 means unbounded/drive-limited (still subject
   *  to streamCache.ts's own free-space safety margin); undefined means
   *  "never configured," which defaults to a moderate 10GB rather than
   *  silently unbounded. */
  streamCacheMaxGb?: number
  hideWatchedDefault?: boolean
  hideCompletedDefault?: boolean
  hideDislikedDefault?: boolean
  profiles?: ProfileRecord[]
  activeProfileId?: string
  [key: string]: unknown
}

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'media-hub-settings.json')
}

// The pre-rewrite app (<= 0.12.x) stored the same keys — same names, same
// safeStorage-encrypted token encoding — in settings.json in this same
// userData folder (the folder is shared because package.json `name` matches
// the old app). settings.json is left in place so rolling back to an old
// build loses nothing.
function legacySettingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

export function readSettings(): MediaHubRawSettings {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as MediaHubRawSettings
  } catch {
    // No media-hub-settings.json yet — fall through to the one-time legacy import.
  }
  try {
    const legacy = JSON.parse(fs.readFileSync(legacySettingsPath(), 'utf8')) as MediaHubRawSettings
    writeSettings(legacy)
    return legacy
  } catch {
    return {}
  }
}

/** Atomic write (write to a temp file, then rename over the target) so a crash mid-write can never leave a truncated/corrupt settings file. */
export function writeSettings(value: MediaHubRawSettings): void {
  const target = settingsPath()
  const directory = path.dirname(target)
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`

  fs.mkdirSync(directory, { recursive: true })
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
    fs.renameSync(temporary, target)
  } finally {
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    } catch {
      // best-effort cleanup only
    }
  }
}

const ENCRYPTION_UNAVAILABLE_PREFIX = 'plain:'
let warnedNoEncryption = false

/** Encrypts a credential-shaped string for storage. Falls back to a tagged, reversible base64 encoding (NOT real encryption) when the OS has no secure-storage backend available, so dev/headless environments don't hard-crash — see module doc comment. */
export function encrypt(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    if (!warnedNoEncryption) {
      warnedNoEncryption = true
      logError(
        'media-hub:settingsStore',
        new Error(
          'OS secure storage is unavailable — credentials will be stored in a reversible but unencrypted form in media-hub-settings.json. Expected in some headless/no-keyring dev environments; should not happen in a packaged build.'
        )
      )
    }
    return ENCRYPTION_UNAVAILABLE_PREFIX + Buffer.from(value, 'utf8').toString('base64')
  }
  return safeStorage.encryptString(value).toString('base64')
}

export function decrypt(value: string | undefined): string {
  if (!value) return ''
  if (value.startsWith(ENCRYPTION_UNAVAILABLE_PREFIX)) {
    try {
      return Buffer.from(value.slice(ENCRYPTION_UNAVAILABLE_PREFIX.length), 'base64').toString(
        'utf8'
      )
    } catch {
      return ''
    }
  }
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  } catch {
    return ''
  }
}

/** The decrypted TorBox API token, or '' if not connected. Gated on onboardingVersion===2 exactly as the original — a token written by an older/incompatible onboarding flow is never trusted. */
export function getTorBoxToken(): string {
  const settings = readSettings()
  return settings.onboardingVersion === 2 ? decrypt(settings.torboxToken) : ''
}

/** Drops the stored TorBox token and notifies the renderer (torbox:unauthorized) so it can prompt to reconnect. No-ops if there was no token to clear. */
export function clearTorBoxToken(): void {
  const settings = readSettings()
  if (!settings.torboxToken) return
  delete settings.torboxToken
  writeSettings(settings)
  sendToRenderer(MEDIA_HUB_CHANNELS.torboxUnauthorized)
}

export interface SimklCredentials {
  clientId: string
  accessToken: string
}

export function simklCredentials(): SimklCredentials {
  const settings = readSettings()
  return {
    clientId: settings.simklClientId || '',
    accessToken: decrypt(settings.simklAccessToken)
  }
}

export interface MalCredentials {
  clientId: string
  clientSecret: string
  accessToken: string
  refreshToken: string
  expiresAt: number
}

export function malCredentials(): MalCredentials {
  const settings = readSettings()
  return {
    clientId: settings.malClientId || '',
    clientSecret: decrypt(settings.malClientSecret),
    accessToken: decrypt(settings.malAccessToken),
    refreshToken: decrypt(settings.malRefreshToken),
    expiresAt: Number(settings.malTokenExpiresAt) || 0
  }
}

export interface TmdbCredentials {
  apiKey: string
}

export function tmdbCredentials(): TmdbCredentials {
  return { apiKey: decrypt(readSettings().tmdbApiKey) }
}

export interface OmdbCredentials {
  apiKey: string
}

export function omdbCredentials(): OmdbCredentials {
  return { apiKey: decrypt(readSettings().omdbApiKey) }
}

export interface OsCredentials {
  apiKey: string
  username: string
  password: string
  token: string
}

export function osCredentials(): OsCredentials {
  const settings = readSettings()
  return {
    apiKey: decrypt(settings.osApiKey),
    username: decrypt(settings.osUsername),
    password: decrypt(settings.osPassword),
    token: decrypt(settings.osToken)
  }
}

export function osConnected(): boolean {
  const creds = osCredentials()
  return Boolean(creds.apiKey && creds.username && creds.password)
}

export interface PartySyncCredentials {
  url: string
  inviteKey: string
}

export function partySyncCredentials(): PartySyncCredentials {
  const settings = readSettings()
  return {
    url: settings.partySyncUrl || '',
    inviteKey: decrypt(settings.partySyncInviteKey)
  }
}
