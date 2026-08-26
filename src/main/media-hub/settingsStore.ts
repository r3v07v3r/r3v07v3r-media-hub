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

import crypto from 'node:crypto'
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
  /** SubDL's free developer key. Unlike OpenSubtitles this is the ONLY
   *  credential the provider needs: the key authenticates search, and the
   *  archives it points at are fetched anonymously from dl.subdl.com, so
   *  there is no username/password or session token to store. */
  subdlApiKey?: string
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
  /** GPU scaling quality — see shared/media-hub/videoScaling.ts. */
  videoScaling?: string
  autoSubtitlesEnabled?: boolean
  autoplayNextEnabled?: boolean
  /** Loudness normalization — see NIGHT_MODE_AUDIO_FILTER. */
  nightModeEnabled?: boolean
  /** Subtitle size/position/colour/background — see
   *  shared/media-hub/subtitleStyle.ts. Stored whole because the four are one
   *  visual decision. */
  subtitleStyle?: unknown
  uiAnimationsEnabled?: boolean
  performancePanelVisible?: boolean
  maxStreamResolution?: number
  maxStreamSizeGb?: number
  connectionSpeedMbps?: number
  /** How much local disk streamCache.ts is allowed to use for the local
   *  rolling playback cache (see playbackSession.ts's
   *  resolveStreamCacheMaxBytes). Distinct from maxStreamSizeGb above,
   *  which filters which torrent releases get selected, not how they're
   *  cached once playing. 0 means unbounded/drive-limited (still subject
   *  to streamCache.ts's own free-space safety margin); undefined means
   *  "never configured," which defaults to a moderate 10GB rather than
   *  silently unbounded. */
  streamCacheMaxGb?: number
  /** Absolute path to a folder streamCache.ts should use INSTEAD of the
   *  default (app.getPath('userData')) — e.g. a secondary drive with more
   *  free space. streamCache.ts always nests its own 'stream-cache'
   *  subfolder inside whatever this resolves to, so it never treats an
   *  arbitrary user-chosen folder's other contents as its own to manage/
   *  delete. undefined means "use the default location." Validated
   *  (writable, real directory) before being saved — see appIpc.ts's
   *  settingsChooseStreamCacheDir. Changing this does NOT move any
   *  already-cached data from the old location. */
  streamCacheDir?: string
  /** Address of the local Ollama instance the AI features call, already
   *  normalized (see shared/media-hub/ollama.ts). Deliberately NOT
   *  encrypted: it is a LAN address, not a credential, and an Ollama
   *  instance has no token to store in the first place. */
  ollamaBaseUrl?: string
  /** Which installed model to use, e.g. 'qwen2.5:7b'. */
  ollamaModel?: string
  /** Set to false — and only ever to false — when the person pressed
   *  Disconnect in Settings. Absent means "never turned off", which is
   *  what a fresh install looks like, so the default address gets tried on
   *  its own (see ollamaService.ts's detectOllama). The flag exists because
   *  the two states are otherwise identical on disk: with auto-detection
   *  running, simply forgetting the saved address would reconnect to the
   *  same local server seconds later, and Disconnect would do nothing. */
  ollamaAutoDetect?: boolean
  hideWatchedDefault?: boolean
  hideCompletedDefault?: boolean
  hideDislikedDefault?: boolean
  profiles?: ProfileRecord[]
  activeProfileId?: string
  [key: string]: unknown
}

/**
 * Electron resolved on use rather than at import.
 *
 * A top-level `import { app } from 'electron'` throws at IMPORT time when
 * the Electron binary is absent, which takes down everything that merely
 * mentions this module — however far away, and however little it wanted
 * anything from Electron. CI installs with `npm ci --ignore-scripts`,
 * which by design never downloads that binary, so pure-logic tests were
 * dying on the import chain rather than on anything they assert.
 *
 * Every use below is inside a function that only runs in the real app,
 * where the binary is always present, so nothing changes for the packaged
 * build. See logger.ts, which carries the same pattern for the same
 * reason.
 */
function electron(): typeof import('electron') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('electron')
}

function settingsPath(): string {
  return path.join(electron().app.getPath('userData'), 'media-hub-settings.json')
}

// The pre-rewrite app (<= 0.12.x) stored the same keys — same names, same
// safeStorage-encrypted token encoding — in settings.json in this same
// userData folder (the folder is shared because package.json `name` matches
// the old app). settings.json is left in place so rolling back to an old
// build loses nothing.
function legacySettingsPath(): string {
  return path.join(electron().app.getPath('userData'), 'settings.json')
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
  if (!electron().safeStorage.isEncryptionAvailable()) {
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
  return electron().safeStorage.encryptString(value).toString('base64')
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
    return electron().safeStorage.decryptString(Buffer.from(value, 'base64'))
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

/**
 * A stable, non-reversible mark for "the Simkl account currently
 * connected", derived from its access token — nothing in this app
 * persists a Simkl user id to use instead, and a truncated salted digest
 * of a high-entropy token identifies the connection without storing
 * anything usable as one. Empty string when nothing is connected, which
 * every caller must treat as "matches no stored stamp" rather than as an
 * account in its own right.
 *
 * The point is that anything persisted about one account is stamped with
 * the connection it was made under and checked against this before it is
 * used, so the safety property survives things going wrong: a clear that
 * failed to write, a crash between signing out and signing in, a database
 * that was read-only at the wrong moment, a request still in flight when
 * the account changed underneath it. State that outlives its account is
 * inert rather than dangerous. Two things rely on it — the pending-push
 * queue in tracking.ts and the watched-history cache in simklClient.ts —
 * which is why it lives here, alongside the credential it is derived
 * from, rather than in either of them.
 *
 * Conservative in the one direction that matters: re-authorizing the
 * SAME account mints a new token and therefore abandons that account's
 * own stamped state, which costs a title being asked about once more.
 * Delivering a decision to the wrong person's history has no equivalent
 * undo.
 *
 * The salt string below is load-bearing and must not be "tidied" to match
 * this function's new home: stamps written by earlier versions are on
 * disk, and changing it would silently orphan every one of them — reading
 * as somebody else's account and quietly discarding decisions a person
 * already made.
 */
export function simklAccountMark(): string {
  const { accessToken } = simklCredentials()
  if (!accessToken) return ''
  return crypto
    .createHash('sha256')
    .update(`reconcile-account:${accessToken}`)
    .digest('hex')
    .slice(0, 16)
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

export interface SubdlCredentials {
  apiKey: string
}

export function subdlCredentials(): SubdlCredentials {
  return { apiKey: decrypt(readSettings().subdlApiKey) }
}

export function subdlConnected(): boolean {
  return Boolean(subdlCredentials().apiKey)
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
