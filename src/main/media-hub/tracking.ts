// Ported from r3v07v3r-media-hub's src/main.cjs (the `tracking:*` and
// `home:personalized` handlers, plus the `simkl:*` account/OAuth handlers).
// The original interleaved all of this with every other backend domain
// directly in main.cjs; here it's its own module alongside catalog.ts and
// malSync.ts. Every fallback/merge branch is preserved exactly: the
// tracking:list metadata-enrichment (fetch details only for non-movie
// tracked items, default newEpisodeCount/airing to 0/''), the three-way
// {ok, ...simklResult, ...malResult} merge and its not-connected vs. error
// vs. success simklResult branching on every mark/unmark handler, and
// home:personalized's per-kind catalog fallback + genre-filtered
// recommendation scoring with its empty-recommendations-falls-back-to-`all`
// tail. Do not simplify or drop any of these branches without re-auditing
// against the source app.

import { app } from 'electron'
import type {
  CatalogItem,
  ConnectResult,
  DislikedListResult,
  HistoryEntry,
  HomePersonalizedResult,
  MarkWatchedResult,
  SimklPinStart,
  SimklPollResult,
  SimklStatus,
  TrackedItemEnriched,
  TrackingListResult
} from '../../shared/media-hub/types'
import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import { airingStatus, continueWatchingList } from './core'
import { catalogData, metadata } from './catalog'
import { getDatabase } from './dbState'
import { fetchJson } from './httpClient'
import { handle } from './ipcGuard'
import { logError } from './logger'
import { pushMalProgress } from './malSync'
import { encrypt, readSettings, simklCredentials, writeSettings } from './settingsStore'
import {
  historyPayload,
  scrobblePayload,
  seasonHistoryPayload,
  type PlaybackPosition,
  type SimklPushItem
} from './simkl'
import { simklRequest, simklUrl, simklWatchedHistory } from './simklClient'

/** Result of a single "push this watch-state change to Simkl" attempt, merged into every mark/unmark handler's response. */
interface SimklSyncResult {
  simklSynced: boolean
  simklError?: string
}

/** Runs a Simkl sync/history POST, translating "not connected" vs. a caught error vs. success into the same three-way shape every mark/unmark handler returns. */
async function syncSimklHistory(pathname: string, body: unknown): Promise<SimklSyncResult> {
  if (!simklCredentials().accessToken) return { simklSynced: false }
  try {
    await simklRequest(pathname, { method: 'POST', body: JSON.stringify(body) })
    return { simklSynced: true }
  } catch (error) {
    logError(`simkl:${pathname}`, error)
    return { simklSynced: false, simklError: (error as Error).message }
  }
}

/** A `Partial<CatalogItem>` with a required id — assignable everywhere MediaHubDatabase's looser `{id: unknown}` item shape is expected, without a cast at the call site. */
type TrackableItem = Partial<CatalogItem> & { id: string }

interface MarkWatchedPayload {
  item: SimklPushItem
  playback?: PlaybackPosition
}

/** Each entry needs a concrete episode number (unlike the loose `PlaybackPosition` used elsewhere) since these feed seasonHistoryPayload's `episodeNumbers: number[]`. */
interface SeasonEpisodePlayback {
  season?: number
  episode: number
}

interface MarkSeasonWatchedPayload {
  item: SimklPushItem
  season?: number
  episodes?: SeasonEpisodePlayback[]
}

interface ScrobbleStartPayload {
  item: SimklPushItem
  playback?: PlaybackPosition
}

/** Minimal shape this port reads from Simkl's `/oauth/pin/:userCode` poll response. */
interface SimklPinPollResponse {
  access_token?: string
  result?: string
  message?: string
}

/** Registers every `tracking:*`, `home:personalized`, and `simkl:*` IPC handler. Call once during main-process startup. */
export function registerTrackingIpc(): void {
  handle<undefined, TrackingListResult>(MEDIA_HUB_CHANNELS.trackingList, async () => {
    const db = getDatabase()
    const trackedItems = db.tracked()
    const history = [...db.history(), ...(await simklWatchedHistory())]
    const details = (
      await Promise.all(
        trackedItems
          .filter((x) => x.type !== 'movie')
          .map((x) => metadata(x.type, x.id).catch(() => null))
      )
    ).filter((x): x is CatalogItem => Boolean(x))
    const newEpisodesById = new Map(
      db.trackedUpdates(details).map((u) => [String(u.id), u.newEpisodeCount])
    )
    const airingById = new Map(details.map((d) => [String(d.id), airingStatus(d)]))
    const tracked: TrackedItemEnriched[] = trackedItems.map((item) => ({
      ...item,
      newEpisodeCount: newEpisodesById.get(String(item.id)) || 0,
      airing: airingById.get(String(item.id)) || ''
    }))
    return { tracked, history }
  })

  handle<TrackableItem, { tracked: boolean }>(MEDIA_HUB_CHANNELS.trackingToggle, (_e, item) => {
    const db = getDatabase()
    const tracked = db.isTracked(item.id)
    if (tracked) db.untrack(item.id)
    else db.track(item)
    return { tracked: !tracked }
  })

  handle<MarkWatchedPayload, MarkWatchedResult>(
    MEDIA_HUB_CHANNELS.trackingMarkWatched,
    async (_e, { item, playback }) => {
      getDatabase().markWatched(item, playback || {})
      const simklResult = await syncSimklHistory(
        '/sync/history',
        historyPayload(item, playback || {})
      )
      return { ok: true, ...simklResult, ...(await pushMalProgress(item)) }
    }
  )

  handle<MarkWatchedPayload, MarkWatchedResult>(
    MEDIA_HUB_CHANNELS.trackingUnmarkWatched,
    async (_e, { item, playback }) => {
      const p = playback || {}
      getDatabase().unmarkWatched(item.id, p.season, p.episode)
      const simklResult = await syncSimklHistory('/sync/history/remove', historyPayload(item, p))
      return { ok: true, ...simklResult, ...(await pushMalProgress(item)) }
    }
  )

  handle<MarkSeasonWatchedPayload, MarkWatchedResult>(
    MEDIA_HUB_CHANNELS.trackingMarkSeasonWatched,
    async (_e, { item, season, episodes }) => {
      const list = Array.isArray(episodes) ? episodes : []
      const db = getDatabase()
      for (const playback of list) db.markWatched(item, playback)
      const simklResult = await syncSimklHistory(
        '/sync/history',
        seasonHistoryPayload(
          item,
          season,
          list.map((p) => p.episode)
        )
      )
      return { ok: true, ...simklResult, ...(await pushMalProgress(item)) }
    }
  )

  handle<undefined, DislikedListResult>(MEDIA_HUB_CHANNELS.dislikedList, async () => {
    return { disliked: getDatabase().disliked() }
  })

  handle<TrackableItem, { disliked: boolean }>(MEDIA_HUB_CHANNELS.dislikedAdd, (_e, item) => {
    getDatabase().dislike(item)
    return { disliked: true }
  })

  handle<{ id: string }, { disliked: boolean }>(MEDIA_HUB_CHANNELS.dislikedRemove, (_e, payload) => {
    getDatabase().undislike(payload.id)
    return { disliked: false }
  })

  handle<undefined, HomePersonalizedResult>(MEDIA_HUB_CHANNELS.homePersonalized, async () => {
    const [movies, series, anime] = await Promise.all(
      (['movie', 'series', 'anime'] as const).map((kind) => catalogData(kind).catch(() => []))
    )
    const all: CatalogItem[] = [...movies, ...series, ...anime]
    if (!all.length) throw new Error('All catalog sources are currently unavailable.')

    const db = getDatabase()
    const history: HistoryEntry[] = [...db.history(), ...(await simklWatchedHistory())]
    const tracked = db.tracked()
    const watchedIds = new Set(history.map((x) => String(x.id)))
    const trackedIds = new Set(tracked.map((x) => String(x.id)))
    const dislikedIds = new Set(db.disliked().map((x) => String(x.id)))
    const genres = db.preferredGenres(4)
    const recommendations = all
      .filter(
        (x) =>
          !watchedIds.has(String(x.id)) &&
          !trackedIds.has(String(x.id)) &&
          !dislikedIds.has(String(x.id)) &&
          (genres.length === 0 || x.genres.some((g) => genres.includes(g)))
      )
      .slice(0, 18)

    const details = (
      await Promise.all(
        tracked
          .filter((x) => x.type !== 'movie')
          .map((x) => metadata(x.type, x.id).catch(() => null))
      )
    ).filter((x): x is CatalogItem => Boolean(x))

    return {
      tracked,
      updates: db.trackedUpdates(details),
      continueWatching: continueWatchingList(details, history).slice(0, 18),
      recommendations: recommendations.length ? recommendations : all.slice(0, 18),
      preferredGenres: genres
    }
  })

  handle<undefined, SimklStatus>(MEDIA_HUB_CHANNELS.simklStatus, async () => {
    const creds = simklCredentials()
    if (!creds.accessToken) return { connected: false, clientId: creds.clientId }
    try {
      const user = await simklRequest<Record<string, unknown>>('/users/settings', {
        method: 'POST',
        body: '{}'
      })
      return { connected: true, clientId: creds.clientId, user }
    } catch (error) {
      return { connected: false, clientId: creds.clientId, error: (error as Error).message }
    }
  })

  handle<string, SimklPinStart>(MEDIA_HUB_CHANNELS.simklStart, async (_e, rawClientId) => {
    const clientId = String(rawClientId || '').trim()
    if (clientId.length < 8) throw new Error('Enter the client ID from your Simkl developer app.')
    const result = await fetchJson<SimklPinStart>(simklUrl('/oauth/pin', clientId), {
      headers: {
        // TODO(media-hub-integration): copied verbatim from the original
        // app's User-Agent string — see simklClient.ts's header comment for
        // why this isn't rebranded to this project's name.
        'User-Agent': `r3v07v3r-media-hub/${app.getVersion()}`
      }
    })
    const s = readSettings()
    s.simklClientId = clientId
    writeSettings(s)
    return result
  })

  handle<string, SimklPollResult>(MEDIA_HUB_CHANNELS.simklPoll, async (_e, userCode) => {
    const { clientId } = simklCredentials()
    if (!clientId) throw new Error('Simkl client ID is missing.')
    const result = await fetchJson<SimklPinPollResponse>(
      simklUrl(`/oauth/pin/${encodeURIComponent(userCode)}`, clientId),
      {
        headers: {
          // TODO(media-hub-integration): copied verbatim from the original
          // app's User-Agent string — see simklClient.ts's header comment for
          // why this isn't rebranded to this project's name.
          'User-Agent': `r3v07v3r-media-hub/${app.getVersion()}`
        }
      }
    )
    if (result.access_token) {
      const s = readSettings()
      s.simklAccessToken = encrypt(result.access_token)
      writeSettings(s)
      const user = await simklRequest<Record<string, unknown>>('/users/settings', {
        method: 'POST',
        body: '{}'
      })
      return { connected: true, user }
    }
    return {
      connected: false,
      pending: result.result === 'KO',
      message: result.message || 'Waiting for authorization.'
    }
  })

  handle<undefined, ConnectResult>(MEDIA_HUB_CHANNELS.simklDisconnect, () => {
    const s = readSettings()
    delete s.simklAccessToken
    writeSettings(s)
    return { ok: true }
  })

  handle<ScrobbleStartPayload, { connected: boolean }>(
    MEDIA_HUB_CHANNELS.simklScrobbleStart,
    async (_e, { item, playback }) => {
      if (!simklCredentials().accessToken) return { connected: false }
      await simklRequest('/scrobble/start', {
        method: 'POST',
        body: JSON.stringify(scrobblePayload(item, playback || {}, 0))
      })
      return { connected: true }
    }
  )
}
