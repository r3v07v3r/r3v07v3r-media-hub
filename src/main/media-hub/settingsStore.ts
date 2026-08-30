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
  /**
   * Whether plan-to-watch changes here reach the tracking services, and
   * whether their removals reach this app.
   *
   * Absent means ON — every install that had the one-way pull gets the
   * two-way behaviour, which is what somebody who connected an account
   * was asking for. Off leaves the pull running and stops every write:
   * see docs/WATCHLIST-SYNC.md, which is the agreement this implements.
   */
  watchlistTwoWay?: boolean
  onboardingVersion?: number
  /** Which version of the one-time anime watch-history id repair this
   *  install has had — see animeSyncRepair.ts. Absent on installs that
   *  predate it, which is exactly who the repair is for. */
  animeIdRepairVersion?: number
  torboxToken?: string
  simklClientId?: string
  simklAccessToken?: string
  /** Trakt's device flow needs both halves of the app credential, unlike
   *  Simkl's PIN flow — the token exchange takes the secret. Both are stored
   *  through the same safeStorage path as every other credential. */
  traktClientId?: string
  traktClientSecret?: string
  traktAccessToken?: string
  traktRefreshToken?: string
  /** Epoch ms. Trakt tokens last about three months and carry a refresh
   *  token; this is what decides when to use it. */
  traktExpiresAt?: number
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
  /** Named filter combinations — see SavedFilter. Device-level, like the
   *  hide-by-default flags beside them. */
  savedFilters?: { id: string; name: string; kind: string; query: string }[]
  /** Desktop notifications for new episodes of tracked shows. Off until
   *  somebody turns it on — see main/media-hub/notifications.ts. */
  notificationsEnabled?: boolean
  /** ISO 3166-1 alpha-2, for "where to watch" — availability is exactly the
   *  thing that differs by country, so there is no global answer. Unset means
   *  fall back to the machine's own locale. */
  watchRegion?: string
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
  /** 'prefer-local' | 'balanced' | 'prefer-quality'. Read through
   *  normalizeSourcePreference (preferences.ts) rather than directly —
   *  an older or hand-edited file may hold anything. */
  sourcePreference?: string
  /** 'disk' (default) or 'memory'. In memory mode nothing about the media
   *  is written to disk at any point — see streamCache.ts's
   *  createMemoryChunkStore. */
  cacheMode?: string
  /** The paired r3-cache daemon (tier 2 of the source order). URL and name
   *  are plain (LAN machine identity, same class as partySyncUrl); the
   *  bearer token is encrypted like every other credential in this file. */
  lanCacheUrl?: string
  lanCacheName?: string
  lanCacheToken?: string
  /** Bound on the in-memory buffer, in MB. Clamped by
   *  streamCache.ts's memoryCacheMaxBytes; ignored on disk. */
  memoryCacheMaxMb?: number
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
export interface LanCacheConnection {
  url: string
  name: string
  token: string
  /**
   * A token issued but not yet approved by the server's administrator.
   *
   * The token is real and authorises nothing, so the connection has to be
   * REMEMBERED (the app must be able to ask 'am I in yet' after a restart)
   * without being USED (every source lookup and stream would 401). Hence a
   * flag on the stored connection rather than a second slot: there is only
   * ever one cache server, and a pending one is that server in an earlier
   * state, not a different thing.
   */
  pending?: boolean
  /**
   * The TorBox opt-in made when this device asked to join, held until
   * approval can act on it.
   *
   * The choice is made at the moment of asking and cannot be honoured then:
   * a pending token authorises nothing, so posting the credential would be
   * refused. Without somewhere to keep the answer it was simply discarded,
   * and the person who ticked the box stayed unlinked with no control
   * anywhere to try again.
   */
  shareTorbox?: boolean
}

/** The paired cache daemon, or undefined. Unlike the TorBox token this is
 *  not gated on onboardingVersion — pairing is its own explicit act. */
export function getLanCacheConnection(): LanCacheConnection | undefined {
  const settings = readSettings()
  const url = String(settings.lanCacheUrl || '').trim()
  const token = decrypt(settings.lanCacheToken)
  if (!url || !token) return undefined
  return {
    url: url.replace(/\/+$/, ''),
    name: String(settings.lanCacheName || ''),
    token,
    ...(settings.lanCachePending === true ? { pending: true } : {}),
    ...(settings.lanCacheShareTorbox === true ? { shareTorbox: true } : {})
  }
}

export function setLanCacheConnection(connection: LanCacheConnection): void {
  const settings = readSettings()
  settings.lanCacheUrl = connection.url.trim().replace(/\/+$/, '')
  settings.lanCacheName = connection.name
  settings.lanCacheToken = encrypt(connection.token)
  // Written only when true, and deleted otherwise, so approval leaves no
  // stale flag behind to hold a working connection shut.
  if (connection.pending) settings.lanCachePending = true
  else delete settings.lanCachePending
  if (connection.shareTorbox) settings.lanCacheShareTorbox = true
  else delete settings.lanCacheShareTorbox
  writeSettings(settings)
}

export function clearLanCacheConnection(): void {
  const settings = readSettings()
  delete settings.lanCacheUrl
  delete settings.lanCacheName
  delete settings.lanCacheToken
  delete settings.lanCachePending
  delete settings.lanCacheShareTorbox
  writeSettings(settings)
}

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

export interface TraktCredentials {
  clientId: string
  clientSecret: string
  accessToken: string
  refreshToken: string
  /** Epoch ms, or 0 when nothing is stored. */
  expiresAt: number
}

export function traktCredentials(): TraktCredentials {
  const settings = readSettings()
  return {
    clientId: settings.traktClientId || '',
    // The secret is a credential like any other and is never returned to the
    // renderer — only the "is it configured" boolean crosses that boundary.
    clientSecret: decrypt(settings.traktClientSecret),
    accessToken: decrypt(settings.traktAccessToken),
    refreshToken: decrypt(settings.traktRefreshToken),
    expiresAt: Number(settings.traktExpiresAt) || 0
  }
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

/**
 * The same mark, for Trakt and MyAnimeList.
 *
 * Written when two-way watchlist sync gained a memory of its own. That
 * memory says "this app pulled this title in from Trakt", and the reason
 * it exists is to justify DELETING the title later — so it has to be
 * about one Trakt account rather than about Trakt. Nothing stops somebody
 * authorizing a different account, and an unstamped record would let
 * account B's snapshot be read as evidence that account A's title had
 * been removed.
 *
 * Each salt is distinct so that the same token, were it ever accepted by
 * two services, could not produce one mark that matched in both places.
 * They are load-bearing in the same way simklAccountMark's is: changing
 * one orphans every stamp already on disk, which reads as "somebody
 * else's account" and quietly discards state — the safe direction, but
 * not a free one.
 */
export function traktAccountMark(): string {
  const { accessToken } = traktCredentials()
  if (!accessToken) return ''
  return crypto
    .createHash('sha256')
    .update(`trakt-account:${accessToken}`)
    .digest('hex')
    .slice(0, 16)
}

export function malAccountMark(): string {
  const { accessToken } = malCredentials()
  if (!accessToken) return ''
  return crypto.createHash('sha256').update(`mal-account:${accessToken}`).digest('hex').slice(0, 16)
}

/** Every tracking service's mark at once, for the callers that stamp a
 *  record touching more than one. Empty string means "not connected",
 *  which must never compare equal to a stored stamp. */
export function trackingAccountMarks(): { simkl: string; trakt: string; mal: string } {
  return { simkl: simklAccountMark(), trakt: traktAccountMark(), mal: malAccountMark() }
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
