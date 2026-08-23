// Ported from r3v07v3r-media-hub's src/main.cjs (the MAL_REDIRECT_*
// constants, malPendingServer/malCredentials/malTokenRequest/malEnsureToken/
// malRequest/resolveKitsuIdForMal/resolveMalIdForKitsu/pushMalProgress/
// fetchAllMalAnimeList/stopMalServer/waitForMalCallback, and every
// `mal:*` ipcMain.handle). The original interleaved all of this with every
// other backend domain directly in main.cjs; here it's its own module so
// tracking.ts (mark-watched/unmark-watched/mark-season-watched) can import
// just `pushMalProgress` without pulling in the whole OAuth/reconciliation
// surface — see simklClient.ts's header comment for why simklCredentials/
// simklRequest/simklWatchedSnapshot are centralized elsewhere instead of
// living here as they did in the original, to avoid an import cycle.
//
// The OAuth flow itself (PKCE 'plain' challenge, local-loopback redirect
// server on 127.0.0.1:48765) is preserved exactly, byte-for-byte in intent,
// from the original — do not "simplify" any of it without re-auditing
// against the source app.

import { app, shell } from 'electron'
import crypto from 'node:crypto'
import http from 'node:http'
import type {
  MalReconcileApplyResult,
  MalReconcilePreview,
  MalStartPayload,
  MalStatus,
  MediaKind
} from '../../shared/media-hub/types'
import { getDatabase } from './dbState'
import { fetchJson } from './httpClient'
import { handle } from './ipcGuard'
import { logError } from './logger'
import {
  buildAuthorizeUrl,
  computeReconciliation,
  localWatchedEpisodeCounts,
  malStatusForProgress,
  normalizeMalEntry
} from './mal'
import { isAllowedExternalUrl } from './security'
import { seasonHistoryPayload } from './simkl'
import { simklRequest, simklWatchedSnapshot } from './simklClient'
import {
  encrypt,
  malCredentials,
  readSettings,
  simklCredentials,
  writeSettings
} from './settingsStore'
import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'

const MAL_REDIRECT_PORT = 48765
const MAL_REDIRECT_URI = `http://127.0.0.1:${MAL_REDIRECT_PORT}/mal/callback`

let malPendingServer: http.Server | null = null

/** POSTs the token endpoint (authorization_code or refresh_token grants share this shape). */
function malTokenRequest(params: Record<string, string>): Promise<{
  access_token: string
  refresh_token?: string
  expires_in?: number
}> {
  return fetchJson('https://myanimelist.net/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params)
  })
}

/**
 * Returns a valid access token, refreshing it first if it's within 5
 * minutes of expiry (or already expired). Throws if MAL was never
 * connected, or if the session can't be refreshed without the user
 * reconnecting in Settings.
 */
async function malEnsureToken(): Promise<string> {
  const creds = malCredentials()
  if (!creds.accessToken) throw new Error('MyAnimeList is not connected.')
  if (creds.expiresAt - Date.now() > 5 * 60 * 1000) return creds.accessToken
  if (!creds.refreshToken) throw new Error('MyAnimeList session expired. Reconnect in Settings.')

  const params: Record<string, string> = {
    client_id: creds.clientId,
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken
  }
  if (creds.clientSecret) params.client_secret = creds.clientSecret

  const result = await malTokenRequest(params)
  const settings = readSettings()
  settings.malAccessToken = encrypt(result.access_token)
  settings.malRefreshToken = encrypt(result.refresh_token || creds.refreshToken)
  settings.malTokenExpiresAt = Date.now() + (Number(result.expires_in) || 3600) * 1000
  writeSettings(settings)
  return result.access_token
}

/** Authenticated MAL v2 API request. Refreshes the access token first if needed (see malEnsureToken). */
async function malRequest<T = unknown>(pathname: string, options: RequestInit = {}): Promise<T> {
  const accessToken = await malEnsureToken()
  return fetchJson<T>(`https://api.myanimelist.net/v2${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      // TODO(media-hub-integration): copied verbatim from the original
      // app's User-Agent string — see simklClient.ts's header comment for
      // why this isn't rebranded to this project's name.
      'User-Agent': `r3v07v3r-media-hub/${app.getVersion()}`,
      ...options.headers
    }
  })
}

interface KitsuMappingResponse {
  data?: Array<{ id?: string | number }>
}

/** Resolves a MAL id to this app's `kitsu:<id>` catalog id, via Kitsu's cross-reference mapping API. 30-day cached; '' on any failure (not matched, or Kitsu unreachable). */
async function resolveKitsuIdForMal(malId: number): Promise<string> {
  const key = `mal:mapping:kitsu-for-mal:${malId}`
  const db = getDatabase()
  const cached = db.getCache<string>(key)
  if (cached !== null) return cached

  try {
    const result = await fetchJson<KitsuMappingResponse>(
      `https://kitsu.io/api/edge/anime?filter[mappingExternalId]=${encodeURIComponent(String(malId))}&filter[mappingExternalSite]=myanimelist/anime`
    )
    const kitsuId = result.data?.[0]?.id ? `kitsu:${result.data[0].id}` : ''
    db.putCache(key, kitsuId, 30 * 24 * 60 * 60 * 1000)
    return kitsuId
  } catch {
    return ''
  }
}

interface KitsuMappingsResponse {
  data?: Array<{ attributes?: { externalSite?: string; externalId?: string | number } }>
}

/** Inverse of resolveKitsuIdForMal — resolves a `kitsu:<id>` (or bare numeric Kitsu id) to a MAL id. 30-day cached; 0 on any failure/no match. */
async function resolveMalIdForKitsu(kitsuId: string): Promise<number> {
  const numericId = String(kitsuId)
    .replace(/^kitsu:/, '')
    .split(':')[0]
  const key = `mal:mapping:mal-for-kitsu:${numericId}`
  const db = getDatabase()
  const cached = db.getCache<number>(key)
  if (cached !== null) return cached

  try {
    const result = await fetchJson<KitsuMappingsResponse>(
      `https://kitsu.io/api/edge/anime/${encodeURIComponent(numericId)}/mappings`
    )
    const match = (result.data || []).find(
      (m) => m.attributes?.externalSite === 'myanimelist/anime'
    )
    const malId = match ? Number(match.attributes?.externalId) || 0 : 0
    db.putCache(key, malId, 30 * 24 * 60 * 60 * 1000)
    return malId
  } catch {
    return 0
  }
}

/**
 * Pushes this app's local watched-episode count for one anime item up to
 * MAL, as a `my_list_status` PATCH. No-ops (not an error) for non-anime
 * items, non-Kitsu ids, or when MAL isn't connected — callers (tracking.ts's
 * mark-watched/unmark-watched/mark-season-watched handlers) call this
 * unconditionally after every local watch-state change and merge the result
 * into their own response.
 */
export async function pushMalProgress(item: {
  id: string
  type: MediaKind
  totalEpisodes?: number
}): Promise<{ malSynced: boolean; malError?: string }> {
  if (item.type !== 'anime' || !String(item.id).startsWith('kitsu:')) return { malSynced: false }
  if (!malCredentials().accessToken) return { malSynced: false }

  try {
    const malId = await resolveMalIdForKitsu(item.id)
    if (!malId) return { malSynced: false }

    const counts = localWatchedEpisodeCounts(getDatabase().history())
    const watchedEpisodes = counts[item.id] || 0
    const status = malStatusForProgress(watchedEpisodes, item.totalEpisodes)

    await malRequest(`/anime/${malId}/my_list_status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        num_watched_episodes: String(watchedEpisodes),
        ...(status ? { status } : {})
      })
    })
    return { malSynced: true }
  } catch (error) {
    logError('mal:push-progress', error)
    return { malSynced: false, malError: (error as Error).message }
  }
}

interface MalAnimeListResponse {
  data?: unknown[]
  paging?: { next?: string }
}

/** Fetches this account's entire MAL anime list (paginated, capped at 10 pages of 1000 as a runaway-pagination guard matching the original). */
async function fetchAllMalAnimeList(): Promise<unknown[]> {
  const entries: unknown[] = []
  let pathname: string | null = '/users/@me/animelist?fields=list_status&limit=1000'
  for (let page = 0; page < 10 && pathname; page++) {
    const result = await malRequest<MalAnimeListResponse>(pathname)
    entries.push(...(result.data || []))
    pathname = result.paging?.next
      ? result.paging.next.replace('https://api.myanimelist.net/v2', '')
      : null
  }
  return entries
}

function stopMalServer(): void {
  if (malPendingServer) {
    try {
      malPendingServer.close()
    } catch {
      // best-effort close only
    }
    malPendingServer = null
  }
}

/**
 * Starts (or restarts) the loopback HTTP server that receives MAL's OAuth
 * redirect, and resolves with the authorization `code` once a valid
 * callback hits it. Rejects on a denied/timed-out/state-mismatched/
 * missing-code callback, or if the redirect port is already in use.
 */
function waitForMalCallback(expectedState: string, timeoutMs = 120000): Promise<string> {
  return new Promise((resolve, reject) => {
    stopMalServer()

    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url || '', 'http://127.0.0.1')
        if (url.pathname !== '/mal/callback') {
          res.writeHead(404)
          res.end()
          return
        }

        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')
        const error = url.searchParams.get('error')

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(
          '<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>You can close this tab</h2><p>Return to R3 Media Hub to continue.</p></body></html>'
        )

        clearTimeout(timer)
        stopMalServer()

        if (error) return reject(new Error(`MyAnimeList authorization was denied: ${error}`))
        if (!state || state !== expectedState) {
          return reject(new Error('MyAnimeList authorization state mismatch.'))
        }
        if (!code) return reject(new Error('MyAnimeList did not return an authorization code.'))
        resolve(code)
      } catch (error) {
        reject(error)
      }
    })

    malPendingServer = server

    const timer = setTimeout(() => {
      stopMalServer()
      reject(new Error('MyAnimeList authorization timed out.'))
    }, timeoutMs)

    server.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      malPendingServer = null
      reject(
        new Error(
          error.code === 'EADDRINUSE'
            ? `Port ${MAL_REDIRECT_PORT} is already in use. Close whatever is using it and try again.`
            : error.message
        )
      )
    })

    server.listen(MAL_REDIRECT_PORT, '127.0.0.1')
  })
}

/** Registers every `mal:*` IPC handler. Call once during main-process startup. */
export function registerMalIpc(): void {
  handle<undefined, MalStatus>(MEDIA_HUB_CHANNELS.malStatus, async () => {
    const creds = malCredentials()
    if (!creds.accessToken) return { connected: false, clientId: creds.clientId }
    try {
      const user = await malRequest<Record<string, unknown>>('/users/@me?fields=name')
      return { connected: true, clientId: creds.clientId, user }
    } catch (error) {
      return { connected: false, clientId: creds.clientId, error: (error as Error).message }
    }
  })

  handle<MalStartPayload, { connected: true; user?: Record<string, unknown> }>(
    MEDIA_HUB_CHANNELS.malStart,
    async (_event, payload) => {
      const clientId = String(payload?.clientId || '').trim()
      const clientSecret = String(payload?.clientSecret || '').trim()
      if (clientId.length < 8) throw new Error('Enter the client ID from your MyAnimeList API app.')

      const s = readSettings()
      s.malClientId = clientId
      if (clientSecret) s.malClientSecret = encrypt(clientSecret)
      else delete s.malClientSecret
      writeSettings(s)

      const state = crypto.randomBytes(16).toString('hex')
      const codeVerifier = crypto.randomBytes(48).toString('base64url')
      const authorizeUrl = buildAuthorizeUrl(clientId, state, codeVerifier, MAL_REDIRECT_URI)
      if (!isAllowedExternalUrl(authorizeUrl)) {
        throw new Error('MyAnimeList authorization URL was rejected.')
      }

      const callback = waitForMalCallback(state)
      await shell.openExternal(authorizeUrl)
      const code = await callback

      const params: Record<string, string> = {
        client_id: clientId,
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        redirect_uri: MAL_REDIRECT_URI
      }
      if (clientSecret) params.client_secret = clientSecret

      const result = await malTokenRequest(params)
      const settings = readSettings()
      settings.malAccessToken = encrypt(result.access_token)
      settings.malRefreshToken = encrypt(result.refresh_token || '')
      settings.malTokenExpiresAt = Date.now() + (Number(result.expires_in) || 3600) * 1000
      writeSettings(settings)

      const user = await malRequest<Record<string, unknown>>('/users/@me?fields=name').catch(
        () => ({})
      )
      return { connected: true, user }
    }
  )

  handle<undefined, { ok: true }>(MEDIA_HUB_CHANNELS.malDisconnect, () => {
    const s = readSettings()
    delete s.malAccessToken
    delete s.malRefreshToken
    delete s.malTokenExpiresAt
    delete s.malClientSecret
    writeSettings(s)
    stopMalServer()
    return { ok: true }
  })

  handle<undefined, MalReconcilePreview>(MEDIA_HUB_CHANNELS.malReconcilePreview, async () => {
    const rawEntries = await fetchAllMalAnimeList()
    const malEntries = rawEntries.map((entry) => normalizeMalEntry(entry as never))
    const withKitsuIds = await Promise.all(
      malEntries.map(async (entry) => ({
        ...entry,
        kitsuId: await resolveKitsuIdForMal(entry.malId)
      }))
    )
    // Simkl's watched history counts as local progress here, so a Simkl
    // side that couldn't be read isn't a degraded comparison — it's a
    // wrong one. Every episode this app knows about only through Simkl
    // silently disappears from the local count, and the preview fills up
    // with "MAL is ahead, pull these down" rows for episodes that are
    // already watched on both sides. Better to say the comparison couldn't
    // be made and let the person retry.
    const remote = await simklWatchedSnapshot()
    if (!remote.complete) {
      throw new Error('Could not read your Simkl watch history — try again in a moment.')
    }
    const history = [...getDatabase().history(), ...remote.entries]
    const localProgress = localWatchedEpisodeCounts(history)
    return computeReconciliation(withKitsuIds, localProgress)
  })

  handle<MalReconcilePreview, MalReconcileApplyResult>(
    MEDIA_HUB_CHANNELS.malReconcileApply,
    async (_event, diff) => {
      const results: MalReconcileApplyResult = { toLocal: [], toMal: [], errors: [] }

      for (const item of diff?.toLocal || []) {
        try {
          const episodeNumbers = Array.from(
            { length: item.toEpisode - item.fromEpisode + 1 },
            (_, i) => item.fromEpisode + i
          )
          // `year` isn't part of the original JS object literal (mediaRef's
          // Number.parseInt(String(undefined)) is NaN either way, so this
          // empty string is behaviorally identical) — added only so the
          // literal satisfies SimklPushItem's typed `year` field.
          const media = { id: item.kitsuId, type: 'anime' as const, title: item.title, year: '' }
          for (const episode of episodeNumbers) {
            getDatabase().markWatched(media, { season: 1, episode })
          }
          if (simklCredentials().accessToken) {
            try {
              await simklRequest('/sync/history', {
                method: 'POST',
                body: JSON.stringify(seasonHistoryPayload(media, 1, episodeNumbers))
              })
            } catch (error) {
              logError('mal:reconcile:simkl-push', error)
            }
          }
          results.toLocal.push(item.kitsuId)
        } catch (error) {
          results.errors.push({ kitsuId: item.kitsuId, error: (error as Error).message })
        }
      }

      for (const item of diff?.toMal || []) {
        try {
          await malRequest(`/anime/${item.malId}/my_list_status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ num_watched_episodes: String(item.watchedEpisodes) })
          })
          results.toMal.push(item.malId)
        } catch (error) {
          results.errors.push({ malId: item.malId, error: (error as Error).message })
        }
      }

      return results
    }
  )
}
