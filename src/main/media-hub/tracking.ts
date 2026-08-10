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
  PlaybackPositionResult,
  ReconcileCheckResult,
  ReconcileResolution,
  SimklPinStart,
  SimklPollResult,
  SimklStatus,
  TrackedItemEnriched,
  TrackingListResult,
  WatchStatusDiscrepancy
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

interface GetPositionPayload {
  id: string
  playback?: PlaybackPosition
}

interface SavePositionPayload {
  id: string
  playback?: PlaybackPosition
  positionSeconds: number
  durationSeconds?: number
}

/** Minimal shape this port reads from Simkl's `/oauth/pin/:userCode` poll response. */
interface SimklPinPollResponse {
  access_token?: string
  result?: string
  message?: string
}

// ---------------------------------------------------------------------
// Watch-status reconciliation.
//
// trackingList/homePersonalized above deliberately stopped referencing
// Simkl on every ordinary read (see that comment) — the local database
// is now the sole source of truth for what the app displays. This is the
// other half of that design: a separate, occasional, explicitly-
// triggered pass that DOES look at Simkl, specifically to catch and
// offer to fix the cases where the two genuinely disagree (a mark that
// never successfully pushed while offline, a watch recorded from another
// device, or similar) — surfaced for review, never silently applied in
// either direction, since guessing wrong would mean either erasing a
// real watch or fabricating one.
//
// MOVIES ONLY, for now. A movie's watched state is a clean boolean on
// both sides, which is exactly what makes it tractable to diff safely.
// A series/anime's state is a whole watched-episode SET, and diffing
// that meaningfully (a person genuinely 40 episodes into two different,
// legitimately-diverged watch orders across two devices is not the same
// kind of "wrong" as one missing local write) is a materially harder
// problem that deserves its own design — and anime already has a
// dedicated, deeper reconciler for exactly that in malSync.ts. Scoping
// this pass to movies means it's simple enough to reason about
// completely rather than half-solving the harder case.

/** How long a real reconciliation attempt (success or failure) suppresses
 *  the next one. Opening and closing the app repeatedly — during testing,
 *  or just in normal use — must not turn into repeated Simkl requests;
 *  this is deliberately a floor on ATTEMPTS, not on confirmed successes,
 *  so a broken connection doesn't get hammered either. */
const RECONCILE_COOLDOWN_MS = 5 * 60 * 1000
const RECONCILE_COOLDOWN_KEY = 'reconcile:cooldown:v1'
/** Ids someone has explicitly said to stop asking about — kept far longer
 *  than the cooldown above (this is a decision, not a rate limit), but
 *  not forever: 90 days gives a genuinely stale dismissal a chance to
 *  resurface rather than being silently suppressed for the life of the
 *  install. */
const RECONCILE_IGNORED_KEY = 'reconcile:ignored:v1'
const RECONCILE_IGNORED_TTL_MS = 90 * 24 * 60 * 60 * 1000

function ignoredReconcileIds(): Set<string> {
  return new Set(getDatabase().getCache<string[]>(RECONCILE_IGNORED_KEY) || [])
}

function addIgnoredReconcileId(id: string): void {
  const ids = ignoredReconcileIds()
  ids.add(id)
  getDatabase().putCache(RECONCILE_IGNORED_KEY, [...ids], RECONCILE_IGNORED_TTL_MS)
}

/** The actual diff. Local and remote are each reduced to "which movie ids
 *  does this side consider watched," and only ids where the two sides
 *  disagree are returned — an id watched (or not) on both sides is
 *  already in agreement and never surfaced. */
async function computeMovieDiscrepancies(): Promise<WatchStatusDiscrepancy[]> {
  const ignored = ignoredReconcileIds()
  const localMovies = new Map(
    getDatabase()
      .history()
      .filter((h) => h.type === 'movie')
      .map((h) => [h.id, h] as const)
  )
  const remoteMovies = new Map(
    (await simklWatchedHistory())
      .filter((h) => h.type === 'movie')
      .map((h) => [h.id, h] as const)
  )
  const ids = new Set([...localMovies.keys(), ...remoteMovies.keys()])
  const out: WatchStatusDiscrepancy[] = []
  for (const id of ids) {
    if (ignored.has(id)) continue
    const local = localMovies.has(id)
    const remote = remoteMovies.has(id)
    if (local === remote) continue
    const source = localMovies.get(id) || remoteMovies.get(id)
    out.push({
      id,
      type: 'movie',
      title: source?.title || id,
      poster: source?.poster || '',
      year: source?.year || '',
      localWatched: local,
      remoteWatched: remote
    })
  }
  return out
}

/** Registers every `tracking:*`, `home:personalized`, and `simkl:*` IPC handler. Call once during main-process startup. */
export function registerTrackingIpc(): void {
  handle<undefined, TrackingListResult>(MEDIA_HUB_CHANNELS.trackingList, async () => {
    const db = getDatabase()
    const trackedItems = db.tracked()
    // Local history ONLY — no live/cached Simkl merge here. This used to
    // fold in simklWatchedHistory() unconditionally, which is cached for
    // 20 minutes (see simklClient.ts) and can therefore keep reporting a
    // title as watched for up to 20 minutes after a real, successful
    // local unmark (which DOES push a Simkl removal — see
    // trackingUnmarkWatched below — but that push doesn't invalidate this
    // OTHER read's stale cache). Reported live: a movie the person had
    // deliberately un-marked kept reading back as "Watched" on every
    // refresh, because every refresh re-merged in the same stale Simkl
    // snapshot and silently overrode the local, correct answer. The local
    // database is the source of truth for what this app displays;
    // reconciling it against Simkl/MAL is now a deliberate, separate,
    // rate-limited background pass (see reconcileWatchStatus below) that
    // surfaces disagreements for review instead of one side silently
    // winning on every ordinary read.
    const history = db.history()
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

  // Local-only — no Simkl/MAL sync, unlike every mark-watched handler
  // above. A resume position is a per-device convenience, not a watch
  // event with any meaning to a tracking service; nothing else in this
  // app's account-sync surface has a concept of "seconds into a title,"
  // and inventing one just to push a position upstream isn't worth the
  // API surface for what's meant to be entirely local.
  handle<GetPositionPayload, PlaybackPositionResult | null>(
    MEDIA_HUB_CHANNELS.trackingGetPosition,
    (_e, { id, playback }) => getDatabase().getPlaybackPosition(id, playback)
  )

  handle<SavePositionPayload, { ok: true }>(
    MEDIA_HUB_CHANNELS.trackingSavePosition,
    (_e, { id, playback, positionSeconds, durationSeconds }) => {
      getDatabase().savePlaybackPosition(id, playback, positionSeconds, durationSeconds)
      return { ok: true }
    }
  )

  // Renderer-triggered (a few seconds after startup, and rate-limited by
  // the cooldown regardless of how often it's called — see this file's
  // own header comment on why) rather than main-process-scheduled: the
  // renderer already owns exactly when "the app has settled in and this
  // won't compete with anything the person is actively doing" is true.
  handle<undefined, ReconcileCheckResult>(MEDIA_HUB_CHANNELS.trackingReconcileCheck, async () => {
    if (!simklCredentials().accessToken) return { ran: false, discrepancies: [] }
    const db = getDatabase()
    if (db.getCache(RECONCILE_COOLDOWN_KEY)) return { ran: false, discrepancies: [] }
    db.putCache(RECONCILE_COOLDOWN_KEY, true, RECONCILE_COOLDOWN_MS)
    try {
      return { ran: true, discrepancies: await computeMovieDiscrepancies() }
    } catch (error) {
      logError('tracking:reconcile', error)
      return { ran: true, discrepancies: [] }
    }
  })

  handle<{ discrepancy: WatchStatusDiscrepancy; resolution: ReconcileResolution }, { ok: true }>(
    MEDIA_HUB_CHANNELS.trackingReconcileResolve,
    async (_e, { discrepancy, resolution }) => {
      if (resolution === 'ignore') {
        addIgnoredReconcileId(discrepancy.id)
        return { ok: true }
      }
      const item: SimklPushItem = {
        id: discrepancy.id,
        type: discrepancy.type,
        title: discrepancy.title,
        year: discrepancy.year
      }
      const db = getDatabase()
      if (resolution === 'use-local') {
        // Local's answer is the one to keep — push it to Simkl so the
        // remote side matches instead of drifting further.
        if (discrepancy.localWatched) {
          await syncSimklHistory('/sync/history', historyPayload(item))
        } else {
          await syncSimklHistory('/sync/history/remove', historyPayload(item))
        }
      } else {
        // Simkl's answer is the one to keep — update the local record to match.
        if (discrepancy.remoteWatched) db.markWatched(item)
        else db.unmarkWatched(item.id)
      }
      return { ok: true }
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
    // Local only — see trackingList's own comment above for why: a live/
    // cached Simkl merge here means Continue Watching and the
    // recommendation filter can both keep treating a freshly-unmarked
    // title as watched for up to 20 minutes.
    const history: HistoryEntry[] = db.history()
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
