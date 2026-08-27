// Talking to Trakt: device-code sign-in, token refresh, and one request
// helper. The payload shapes live in trakt.ts.
//
// WHY DEVICE CODE RATHER THAN A REDIRECT. Trakt's other flows want a browser
// redirect back to a registered URI, which a desktop app has to fake with a
// loopback server or a custom scheme. The device flow needs neither: the app
// shows a short code, the person types it into trakt.tv on whatever device
// they like, and the app polls until it is approved. Simkl's PIN flow already
// works exactly this way, so it is also the flow this codebase and its users
// already understand.
//
// A CLIENT SECRET IS REQUIRED, unlike Simkl. Trakt's device token exchange
// takes one, so both halves are asked for in Settings and the secret is stored
// through the same safeStorage path as every other credential.

import { app } from 'electron'

import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import type {
  ImportSummary,
  TraktPollResult,
  TraktStartResult,
  TraktStatusResult
} from '../../shared/media-hub/types'
import { fetchJson } from './httpClient'
import { handle } from './ipcGuard'
import { logError } from './logger'
import { getDatabase } from './dbState'
import { requestRecommendationsRebuild } from './recommendations'
import {
  hasTraktContent,
  historyPayload,
  parseTraktHistory,
  parseTraktRatings,
  ratingsPayload,
  scrobblePayload,
  type TraktPlaybackPosition,
  type TraktPushItem
} from './trakt'
import { encrypt, readSettings, traktCredentials, writeSettings } from './settingsStore'
import type { TaskPriority } from './taskScheduler'

const API = 'https://api.trakt.tv'

/** Trakt's own name for the out-of-band redirect the device flow uses. */
const OOB_REDIRECT = 'urn:ietf:wg:oauth:2.0:oob'

/**
 * Refresh this long before expiry rather than on failure.
 *
 * A token lasts three months, so this is not a hot path — but the alternative,
 * refreshing when a request 401s, means the first push after an expiry is the
 * one that fails, and this app's pushes are fire-and-forget. A window means
 * the failure never reaches a caller.
 */
const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export interface TraktDeviceCode {
  deviceCode: string
  userCode: string
  verificationUrl: string
  /** Seconds Trakt asks us to wait between polls. */
  interval: number
  expiresIn: number
}

export interface TraktStatus {
  connected: boolean
  /** Whether both halves of the app credential are saved — the thing somebody
   *  has to do before sign-in is even offered. */
  configured: boolean
  username?: string
}

interface TokenResponse {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  created_at?: unknown
}

function headers(clientId: string, accessToken?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': clientId,
    'User-Agent': `r3v07v3r-media-hub/${app.getVersion()}`,
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
  }
}

function storeTokens(payload: TokenResponse): void {
  const settings = readSettings()
  settings.traktAccessToken = encrypt(String(payload.access_token ?? ''))
  settings.traktRefreshToken = encrypt(String(payload.refresh_token ?? ''))
  const createdAt = Number(payload.created_at) * 1000
  const lifetime = Number(payload.expires_in) * 1000
  settings.traktExpiresAt =
    Number.isFinite(createdAt) && Number.isFinite(lifetime) ? createdAt + lifetime : undefined
  writeSettings(settings)
}

export function clearTraktTokens(): void {
  const settings = readSettings()
  settings.traktAccessToken = undefined
  settings.traktRefreshToken = undefined
  settings.traktExpiresAt = undefined
  writeSettings(settings)
}

/** Starts a sign-in: returns the code the person types into trakt.tv. */
export async function requestDeviceCode(): Promise<TraktDeviceCode> {
  const { clientId } = traktCredentials()
  if (!clientId) throw new Error('Enter your Trakt client ID and secret first.')
  const payload = await fetchJson<{
    device_code?: unknown
    user_code?: unknown
    verification_url?: unknown
    interval?: unknown
    expires_in?: unknown
  }>(
    `${API}/oauth/device/code`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId })
    },
    { priority: 'interactive', label: 'Trakt' }
  )
  return {
    deviceCode: String(payload.device_code ?? ''),
    userCode: String(payload.user_code ?? ''),
    verificationUrl: String(payload.verification_url ?? 'https://trakt.tv/activate'),
    interval: Math.max(1, Number(payload.interval) || 5),
    expiresIn: Number(payload.expires_in) || 600
  }
}

export type TraktPollOutcome =
  | { state: 'pending' }
  | { state: 'connected' }
  | { state: 'expired' }
  | { state: 'denied' }
  | { state: 'error'; message: string }

/**
 * One poll of the device token endpoint.
 *
 * Trakt reports the whole state machine through STATUS CODES with no body
 * worth reading, which is why this reads them explicitly rather than treating
 * every non-200 as a failure: 400 is the ordinary "not yet" that most polls
 * return, and turning that into an error would end a sign-in the moment it
 * started.
 */
export async function pollDeviceToken(deviceCode: string): Promise<TraktPollOutcome> {
  const { clientId, clientSecret } = traktCredentials()
  if (!clientId || !clientSecret) return { state: 'error', message: 'Trakt is not configured.' }

  const response = await fetch(`${API}/oauth/device/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: deviceCode, client_id: clientId, client_secret: clientSecret })
  }).catch(() => null)

  if (!response) return { state: 'error', message: 'Could not reach Trakt.' }
  switch (response.status) {
    case 200: {
      storeTokens((await response.json().catch(() => ({}))) as TokenResponse)
      return { state: 'connected' }
    }
    // Waiting for the person to approve it. The overwhelmingly common answer.
    case 400:
      return { state: 'pending' }
    case 404:
      return { state: 'error', message: 'That sign-in code is no longer valid.' }
    case 409:
      // Already approved and exchanged — treat as success rather than an
      // error, since the desired end state has been reached.
      return { state: 'connected' }
    case 410:
      return { state: 'expired' }
    case 418:
      return { state: 'denied' }
    case 429:
      // Polling too fast. Not an error: the caller simply waits longer.
      return { state: 'pending' }
    default:
      return { state: 'error', message: `Trakt answered with status ${response.status}.` }
  }
}

/**
 * Swaps the refresh token for a new pair, if one is due.
 *
 * Best-effort and silent: a refresh that fails leaves the existing token in
 * place to fail on its own terms, which produces one clear "not connected"
 * rather than two different errors for the same cause.
 */
async function refreshIfDue(): Promise<void> {
  const { clientId, clientSecret, refreshToken, expiresAt } = traktCredentials()
  if (!clientId || !clientSecret || !refreshToken || !expiresAt) return
  if (expiresAt - Date.now() > REFRESH_WINDOW_MS) return
  try {
    const payload = await fetchJson<TokenResponse>(
      `${API}/oauth/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: OOB_REDIRECT,
          grant_type: 'refresh_token'
        })
      },
      { priority: 'background', label: 'Trakt' }
    )
    if (payload.access_token) storeTokens(payload)
  } catch {
    // Left to expire. See the doc comment.
  }
}

/** An authenticated Trakt call. Throws when not connected. */
export async function traktRequest<T = unknown>(
  pathname: string,
  options: RequestInit = {},
  priority: TaskPriority = 'interactive'
): Promise<T> {
  await refreshIfDue()
  const { clientId, accessToken } = traktCredentials()
  if (!clientId || !accessToken) throw new Error('Trakt is not connected.')
  return fetchJson<T>(
    `${API}${pathname}`,
    { ...options, headers: { ...headers(clientId, accessToken), ...options.headers } },
    { priority, label: 'Trakt' }
  )
}

/** Who is signed in, for the Settings card. */
export async function traktStatus(): Promise<TraktStatus> {
  const { clientId, clientSecret, accessToken } = traktCredentials()
  const configured = Boolean(clientId && clientSecret)
  if (!configured || !accessToken) return { connected: false, configured }
  try {
    const profile = await traktRequest<{ username?: unknown }>('/users/me')
    return { connected: true, configured, username: String(profile.username ?? '') }
  } catch {
    // A token that no longer works is the same thing to a person as not being
    // signed in, and saying so lets them press Connect again.
    return { connected: false, configured }
  }
}

// ---------------------------------------------------------------------------
// Pushes. Every one is fire-and-forget and swallows its own failure.
//
// A tracking service is a courtesy: the local database is the record, and an
// expired token or an outage must never turn "I finished this episode" into an
// error over the video. Simkl's pushes already work this way; these match.
// ---------------------------------------------------------------------------

/** Sends a watched (or un-watched) title. Silent when Trakt is not connected
 *  or the title is one Trakt cannot identify — see trakt.ts on anime. */
export async function pushTraktHistory(
  item: TraktPushItem,
  playback: TraktPlaybackPosition,
  action: 'add' | 'remove'
): Promise<void> {
  const payload = historyPayload(item, playback)
  if (!hasTraktContent(payload)) return
  if (!traktCredentials().accessToken) return
  try {
    await traktRequest(action === 'add' ? '/sync/history' : '/sync/history/remove', {
      method: 'POST',
      body: JSON.stringify(payload)
    })
  } catch (error) {
    logError('trakt:history', error)
  }
}

/** Sends a rating, or removes it when the score is this app's "cleared" 0. */
export async function pushTraktRating(item: TraktPushItem, rating: number): Promise<void> {
  if (!traktCredentials().accessToken) return
  const score = Math.round(Number(rating))
  // 0 is the clear action (see shared/media-hub/rating.ts), and Trakt has a
  // separate endpoint for withdrawing one — sending it as a rating would
  // record an opinion that was just taken back.
  if (score === 0) {
    const removal = ratingsPayload(item, 1)
    if (!hasTraktContent(removal)) return
    try {
      await traktRequest('/sync/ratings/remove', {
        method: 'POST',
        // The same entry without the score: Trakt keys the removal on the id.
        body: JSON.stringify(historyPayload(item))
      })
    } catch (error) {
      logError('trakt:rating-remove', error)
    }
    return
  }
  const payload = ratingsPayload(item, score)
  if (!hasTraktContent(payload)) return
  try {
    await traktRequest('/sync/ratings', { method: 'POST', body: JSON.stringify(payload) })
  } catch (error) {
    logError('trakt:rating', error)
  }
}

/** Reports in-progress playback. */
export async function pushTraktScrobble(
  item: TraktPushItem,
  playback: TraktPlaybackPosition,
  action: 'start' | 'pause' | 'stop',
  progress: number
): Promise<void> {
  if (!traktCredentials().accessToken) return
  const payload = scrobblePayload(item, playback, progress)
  if (!payload) return
  try {
    await traktRequest(`/scrobble/${action}`, {
      method: 'POST',
      body: JSON.stringify(payload)
    })
  } catch (error) {
    logError('trakt:scrobble', error)
  }
}

// ---------------------------------------------------------------------------
// The pull.
//
// Everything above sends; this reads back. It is the half somebody needs
// exactly once — the day they connect an account they have been using for
// years — and it is the half where a mistake is expensive, because it
// writes into the table every recommendation, badge and statistic is
// derived from.
//
// It writes through db.importWatched / db.importRatings and NOT through the
// mark-watched IPC handler, which is deliberate and load-bearing: that
// handler pushes to Trakt. Importing five hundred rows through it would
// send all five hundred straight back where they came from, and do it
// while the import is still running.
// ---------------------------------------------------------------------------

/** Rows per request. Trakt caps its pagination well below this on some
 *  endpoints and simply returns fewer; the loop below reads the short page
 *  as "that was the end", which is true either way. */
const IMPORT_PAGE_SIZE = 100

/**
 * How many pages one endpoint may be walked.
 *
 * A backstop against a server that keeps answering with full pages
 * forever, not a considered library size — 20,000 viewings is far past any
 * real Trakt account. Reaching it is REPORTED rather than swallowed: a
 * silent truncation would read as "your history is now imported" over a
 * partial copy.
 */
const IMPORT_MAX_PAGES = 200

async function readAllPages(pathname: string): Promise<{ rows: unknown[]; truncated: boolean }> {
  const rows: unknown[] = []
  const join = pathname.includes('?') ? '&' : '?'
  for (let page = 1; page <= IMPORT_MAX_PAGES; page += 1) {
    const batch = await traktRequest<unknown[]>(
      `${pathname}${join}page=${page}&limit=${IMPORT_PAGE_SIZE}`,
      {},
      // An import is somebody waiting at a settings screen, but it is also
      // potentially hundreds of requests. 'background' keeps it behind
      // anything the app is doing to paint a window.
      'background'
    )
    if (!Array.isArray(batch) || !batch.length) return { rows, truncated: false }
    rows.push(...batch)
    // A short page is the last page on every Trakt endpoint this walks.
    if (batch.length < IMPORT_PAGE_SIZE) return { rows, truncated: false }
  }
  return { rows, truncated: true }
}

/**
 * Brings a Trakt account's watched history and ratings into this profile.
 *
 * Gap-filling, never overwriting, and repeatable — see db.importWatched.
 * Pressing Import twice does nothing the second time, which matters because
 * the honest thing to do about a partial import is to run it again.
 */
export async function importTraktLibrary(): Promise<ImportSummary> {
  const db = getDatabase()
  // The profile this import is FOR, captured before the first request. Every
  // page below is an await, and a switch mid-import would otherwise pour one
  // person's viewing history into whoever is active by the time it lands —
  // the same failure the stored recommendations and the reconcile results
  // each had to be taught about.
  const profile = db.activeProfile()

  const history = await readAllPages('/sync/history')
  const movieRatings = await readAllPages('/sync/ratings/movies')
  const showRatings = await readAllPages('/sync/ratings/shows')

  if (db.activeProfile() !== profile) {
    throw new Error('Profile changed while importing — nothing was written.')
  }

  const plays = parseTraktHistory(history.rows)
  const rated = [parseTraktRatings(movieRatings.rows), parseTraktRatings(showRatings.rows)]

  const summary: ImportSummary = {
    plays: db.importWatched(plays.rows),
    ratings: db.importRatings(rated.flatMap((parsed) => parsed.rows)),
    skipped: plays.skipped + rated.reduce((total, parsed) => total + parsed.skipped, 0)
  }

  // Not silent. See IMPORT_MAX_PAGES — a truncated read that reports success
  // tells somebody their history is imported when part of it is not.
  if (history.truncated || movieRatings.truncated || showRatings.truncated) {
    logError(
      'trakt:import',
      new Error(`Stopped after ${IMPORT_MAX_PAGES} pages — the import is partial.`)
    )
  }

  // What was just written changes what the ranking should suggest, and by a
  // lot: an import is usually the single largest thing that has ever
  // happened to this person's history.
  requestRecommendationsRebuild()
  return summary
}

export function registerTraktIpc(): void {
  handle<undefined, TraktStatusResult>(MEDIA_HUB_CHANNELS.traktStatus, () => traktStatus())

  handle<{ clientId: string; clientSecret: string }, TraktStatusResult>(
    MEDIA_HUB_CHANNELS.traktConfigure,
    async (_event, payload) => {
      const settings = readSettings()
      const id = String(payload?.clientId ?? '').trim()
      const secret = String(payload?.clientSecret ?? '').trim()
      settings.traktClientId = id
      settings.traktClientSecret = secret ? encrypt(secret) : undefined
      // Changing the app credential invalidates any token obtained with the
      // previous one — keeping it would leave a "connected" card backed by a
      // token this client can no longer refresh.
      writeSettings(settings)
      clearTraktTokens()
      return traktStatus()
    }
  )

  handle<undefined, TraktStartResult>(MEDIA_HUB_CHANNELS.traktStart, async () => {
    const code = await requestDeviceCode()
    // The device code is held in main rather than handed to the renderer: it
    // is the bearer of the pending sign-in, and the renderer has no use for it
    // beyond passing it straight back.
    pendingDeviceCode = code.deviceCode
    return {
      userCode: code.userCode,
      verificationUrl: code.verificationUrl,
      interval: code.interval,
      expiresIn: code.expiresIn
    }
  })

  handle<undefined, TraktPollResult>(MEDIA_HUB_CHANNELS.traktPoll, async () => {
    if (!pendingDeviceCode) return { state: 'error', message: 'Start the sign-in first.' }
    const outcome = await pollDeviceToken(pendingDeviceCode)
    // Anything terminal releases the code, so a later poll cannot resurrect a
    // sign-in that already ended.
    if (outcome.state !== 'pending') pendingDeviceCode = ''
    return outcome
  })

  handle<undefined, ImportSummary>(MEDIA_HUB_CHANNELS.traktImport, () => importTraktLibrary())

  handle<undefined, { ok: true }>(MEDIA_HUB_CHANNELS.traktDisconnect, () => {
    clearTraktTokens()
    pendingDeviceCode = ''
    return { ok: true }
  })
}

/** The sign-in currently waiting to be approved, if any. */
let pendingDeviceCode = ''
