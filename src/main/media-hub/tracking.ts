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
  CatchUpReport,
  ConnectResult,
  DislikedListResult,
  EpisodePlaybackPosition,
  HistoryEntry,
  HomePersonalizedResult,
  MarkWatchedResult,
  PlaybackPositionResult,
  CustomList,
  MediaKind,
  CustomListItem,
  PlayRecord,
  ViewingStats,
  PendingWatchStatusPush,
  RecommendationRail,
  RecommendationReason,
  ReconcileCheckResult,
  ReconcileResolution,
  ReconcileResolveResult,
  ReconcileSyncReport,
  ChangedEpisode,
  ImportedPlay,
  SetTitleStatusPayload,
  SetTitleStatusResult,
  ShowSyncDecision,
  ShowSyncDecisionResult,
  ShowSyncRow,
  SimklPinStart,
  SimklPollResult,
  SimklStatus,
  TitleWatchState,
  TrackedItem,
  TrackedItemEnriched,
  TrackingListResult,
  WatchStatusDiscrepancy
} from '../../shared/media-hub/types'
import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import {
  applyPushOutcome,
  queuePendingPush,
  reviewRemovalsOwed,
  splitForFlush,
  traktFollowUps,
  withPushedRemoteState
} from '../../shared/media-hub/reconcileQueue'
import {
  applyCadence,
  groupRecommendationRails,
  rankPersonalizedRecommendationsScored,
  watchCadenceProfile
} from '../../shared/media-hub/catalog-logic'
import { toSimklAnimeEpisode, watchedLaterSeasons } from '../../shared/media-hub/serviceIds'
import {
  abandonedIds,
  liveExclusions,
  readStoredRecommendations,
  reasonsFor,
  recommendable,
  requestRecommendationsRebuild,
  storeRecommendations,
  SERVED_COUNT
} from './recommendations'
import {
  airingStatus,
  continueWatchingList,
  homeDetailWants,
  homeWatchedCounts,
  plannedList
} from './core'
import { catalogData, indexTrackedTitle, metadata } from './catalog'
import {
  animeGroupingReady,
  animeSiblingIds,
  animeSiblingsWhenGrouped,
  laterSeasonOf,
  resolveAnimeGroupTarget
} from './animeSeasons'
import { catchUpFromServices, noteSimklActivities, recentSimklActivities } from './simklCatchUp'
import { getDatabase } from './dbState'
import {
  applyLocalPlanChange,
  lastPlannedSyncReport,
  pushLocalPlanChange,
  plannedSources,
  syncPlannedFromServices,
  unplanBecauseWatched,
  type PlannedSyncReport
} from './watchlists'
import { fetchJson, retryOnceOn429, type HttpError } from './httpClient'
import { mapWithLimit, type TaskPriority } from './taskScheduler'
import { handle } from './ipcGuard'
import { logError } from './logger'
import { pushMalProgress, pushMalTitleProgress } from './malSync'
import {
  airedRegularEpisodes,
  bySeason,
  episodeKey,
  episodesPerSeason,
  planTitleStatusChange,
  type EpisodeRef
} from './titleStatusRules'
import {
  pushTraktHistory,
  pushTraktRating,
  pushTraktScrobble,
  pushTraktSeasonHistory,
  pushTraktTitleHistory,
  pullTraktHistoryNow,
  traktRequest,
  type TraktPushResult
} from './traktClient'
import {
  historyRetryBatches,
  holdRemovalsOnTheWay,
  readHistoryPending,
  recordHistoryPush,
  removalsInFlight,
  removalsOwed,
  retryFailure,
  settleHistoryRetry,
  watchKeyOf,
  writeHistoryPending,
  type HistoryRetryBatch,
  type HistoryService,
  type PendingHistoryPush
} from './historyRetry'
import {
  encrypt,
  readSettings,
  simklAccountMark,
  simklCredentials,
  writeSettings,
  traktCredentials,
  trackingAccountMarks,
  malCredentials
} from './settingsStore'
import { scrobblingEnabled } from './preferences'
import { sendToRenderer, notifyLibraryChanged } from './rendererBridge'
import { cachedRemoteLists, fetchRemoteLists } from './remoteLists'
import type { RemoteList } from '../../shared/media-hub/types'
import {
  batchHistoryPayload,
  hasExpressibleSimklId,
  hasSimklContent,
  historyPayload,
  scrobblePayload,
  seasonHistoryPayload,
  titleHistoryPayload,
  unmatchedCatalogIds,
  type PlaybackPosition,
  type SimklHistoryPayload,
  type SimklHistoryResponse,
  type SimklPushItem
} from './simkl'
import {
  forgetSimklWatchedCache,
  invalidateSimklWatchedCache,
  simklActivities,
  simklLibrary,
  simklRequest,
  simklUrl,
  simklWatchedSnapshot
} from './simklClient'
import {
  filmDiffCurrent,
  localFilmsSignature,
  newWatchSyncMemory,
  recordFilmDiff,
  runWatchSync
} from './watchSync'
import { parseSimklActivities, type SimklLibraryTitle } from './simklCatchUpRules'
import { titlePushQueue, titlePushKey } from './titlePushQueue'
import { cachedMetadata } from './titleNames'
import { imdbForSimklKeyedId, isSimklKeyedId } from './simklKeyedHistory'
import { isTraktPushable } from './trakt'
import { traktPullKey, traktPullStateFor } from './traktHistoryPull'
import { kitsuIdLookup } from './idBridge'
import { backupBeforeRewrite } from './autoBackup'
import {
  compareEpisodeSets,
  decideShow,
  liveShowSync,
  noteArrivals,
  readShowSync,
  undoneHeldBack,
  withWatchedAt,
  seasonsOf,
  simklAnimeRead,
  simklShowsRead,
  traktShowsRead,
  writeShowSync,
  type AnimePlace,
  type Ep,
  type EpisodeService,
  type EpisodeSource,
  type RemoteRead,
  type SyncShow
} from './episodeSync'

/** Result of a single "push this watch-state change to Simkl" attempt, merged into every mark/unmark handler's response. */
interface SimklSyncResult {
  simklSynced: boolean
  simklError?: string
  /** The HTTP status of a failure, when Simkl answered at all. */
  simklStatus?: number
}

/** Runs a Simkl sync/history POST, translating "not connected" vs. a caught error vs. success into the same three-way shape every mark/unmark handler returns. */
/**
 * The watch-state pushes for one title, run after any still in flight for
 * that title.
 *
 * The mark/unmark handlers answer on the local write and let these run
 * behind it, so a mark and the unmark that reverses it a moment later are
 * both in flight together — in a Simkl lane whose concurrency is greater
 * than one. If the add lands after the remove, Simkl says watched while
 * this database says not, and the handlers have already reported success.
 * One serial chain per title (titlePushQueue.ts — the same chain the plan
 * changes in watchlists.ts and the scrobbles below run on) keeps opposing
 * pushes in the order they were asked for; the three services within one
 * push run together, since each only has to stay ordered against itself.
 *
 * A push that fails logs itself (syncSimklHistory, traktClient,
 * pushMalProgress) and does not hold up the next. The history pushes are
 * wrapped in keptSimkl/keptTrakt/keptMal, which write a failure down to be
 * retried on the next watch-sync pass or manual Sync (historyRetry.ts). The
 * sync review catches a disagreement over a Simkl movie, and the episode
 * comparison (episodeSync.ts) a show's episodes missing at Simkl or Trakt;
 * drift at MAL that a retry cannot fix is not detected.
 */
function queueRemotePushes(
  item: { id: string; type?: string },
  pushes: () => Array<Promise<unknown>>,
  /** The history change, when this is one. A removal's rows are held back
   *  from the catch-up and the Trakt pull until its pushes are answered —
   *  see holdRemovalsOnTheWay. */
  change?: HistoryPushAt
): void {
  const release =
    change?.action === 'remove'
      ? holdRemovalsOnTheWay(
          change.profile,
          change.rows.map((row) => watchKeyOf(String(change.item.id), row.season, row.episode))
        )
      : () => {}
  // Bound to the accounts connected when it was asked for. A push that
  // waits behind a slow one reads the credentials only when it runs, so
  // disconnecting Simkl and connecting another account in between would
  // post the first account's history to the second. A stamp that no
  // longer matches means the task is dropped, not run.
  const stamp = connectedAccountsStamp()
  void titlePushQueue
    .run(titlePushKey(item), () =>
      connectedAccountsStamp() === stamp ? Promise.allSettled(pushes()) : Promise.resolve([])
    )
    .finally(release)
}

/** Which accounts are connected right now — the tail of each token is
 *  enough to tell one from another, and nothing here is logged. */
function connectedAccountsStamp(): string {
  return [
    simklCredentials().accessToken,
    traktCredentials().accessToken,
    malCredentials().accessToken
  ]
    .map((token) => String(token ?? '').slice(-12))
    .join('|')
}

async function syncSimklHistory(
  pathname: string,
  body: SimklHistoryPayload,
  priority: TaskPriority = 'interactive'
): Promise<SimklSyncResult> {
  if (!simklCredentials().accessToken) return { simklSynced: false }
  // An empty payload is a title Simkl has no id for (see historyPayload).
  // Posting it anyway would ask Simkl to match by title and year, which
  // changes an account on a guess and produces a row this app can never
  // join back to its own — so the local write stands alone and nothing
  // goes out. Not an error: there is nothing wrong with the title, only
  // with what can be said about it to this particular service.
  if (!hasSimklContent(body)) return { simklSynced: false }
  try {
    // One delayed retry on a 429 — see retryOnceOn429.
    await retryOnceOn429(() =>
      simklRequest(pathname, { method: 'POST', body: JSON.stringify(body) }, priority)
    )
    return { simklSynced: true }
  } catch (error) {
    logError(`simkl:${pathname}`, error)
    const status = (error as HttpError)?.status
    return {
      simklSynced: false,
      simklError: (error as Error).message,
      ...(typeof status === 'number' ? { simklStatus: status } : {})
    }
  }
}

// ---------------------------------------------------------------------
// History pushes that did not arrive — see historyRetry.ts.

/** What one history push was about, for writing down how it went. */
interface HistoryPushAt {
  item: { id: string; type?: string; title?: string; year?: unknown }
  rows: readonly { season: number | null; episode: number | null }[]
  action: 'add' | 'remove'
  /** The profile whose history the push was for, captured with it. */
  profile: string
  /** What the MyAnimeList push was sent with besides the count, kept so a
   *  retry sends the same (pushTitleHistory's malStatus and seasonTotals). */
  mal?: { status?: 'plan_to_watch'; seasonTotals?: ReadonlyMap<number, number> }
}

/** A playback position as the row it is kept under — see markWatched. */
function rowOf(playback: PlaybackPosition): { season: number | null; episode: number | null } {
  return {
    season: Number.isFinite(playback.season) ? (playback.season as number) : null,
    episode: Number.isFinite(playback.episode) ? (playback.episode as number) : null
  }
}

/** The title as an owed push keeps it: enough to build the request again. */
function pendingItem(at: HistoryPushAt): PendingHistoryPush['item'] {
  const episodic = at.rows.some((row) => row.episode != null)
  const total = (at.item as { totalEpisodes?: unknown }).totalEpisodes
  return {
    id: String(at.item.id),
    type: (at.item.type ?? (episodic ? 'series' : 'movie')) as MediaKind,
    title: String(at.item.title ?? ''),
    ...(at.item.year ? { year: String(at.item.year) } : {}),
    ...(typeof total === 'number' && total > 0 ? { totalEpisodes: total } : {})
  }
}

/**
 * Writes down how one push went: a failure becomes an owed change, and a
 * success clears whatever an earlier failure for the same rows left owing.
 * Never throws — the push has already happened, and this is bookkeeping.
 */
function noteHistoryPush(service: HistoryService, at: HistoryPushAt, error?: string): void {
  try {
    const db = getDatabase()
    const marks = trackingAccountMarks()
    const pending = readHistoryPending(db, at.profile, marks)
    const next = recordHistoryPush(
      pending,
      {
        service,
        mark: marks[service],
        item: pendingItem(at),
        rows: at.rows,
        action: at.action,
        error,
        ...(service === 'mal' && at.mal?.status ? { malStatus: at.mal.status } : {}),
        ...(service === 'mal' && at.mal?.seasonTotals ? { seasonTotals: at.mal.seasonTotals } : {})
      },
      Date.now()
    )
    // A success with nothing owed is the ordinary case, and not a write.
    if (JSON.stringify(next) === JSON.stringify(pending)) return
    writeHistoryPending(db, at.profile, next)
  } catch (caught) {
    logError('history:pending', caught)
  }
}

function keptSimkl(at: HistoryPushAt, push: Promise<SimklSyncResult>): Promise<SimklSyncResult> {
  return push.then((result) => {
    if (result.simklSynced || result.simklError) noteHistoryPush('simkl', at, result.simklError)
    return result
  })
}

function keptTrakt(at: HistoryPushAt, push: Promise<TraktPushResult>): Promise<TraktPushResult> {
  return push.then((result) => {
    if (result.sent || result.error) noteHistoryPush('trakt', at, result.error)
    return result
  })
}

function keptMal(
  at: HistoryPushAt,
  push: Promise<{ malSynced: boolean; malError?: string }>
): Promise<{ malSynced: boolean; malError?: string }> {
  return push.then((result) => {
    if (result.malSynced || result.malError) noteHistoryPush('mal', at, result.malError)
    return result
  })
}

/** Sends one batch of owed changes. `error` undefined is success; a string
 *  is the failure, with the HTTP status when the service answered; null is
 *  a push that cannot be expressed to that service at all. */
async function sendHistoryRetry(
  batch: HistoryRetryBatch,
  profile: string,
  priority: TaskPriority
): Promise<{ error: string | null | undefined; status?: number }> {
  const item = { ...batch.item, year: batch.item.year ?? '' }
  const seasons = bySeason(
    batch.rows
      .filter((row) => row.episode != null)
      .map((row) => ({ season: row.season ?? 1, episode: row.episode as number }))
  )
  const film = item.type === 'movie'
  switch (batch.service) {
    case 'simkl': {
      const path = batch.action === 'add' ? '/sync/history' : '/sync/history/remove'
      const body = film
        ? historyPayload(item, {})
        : titleHistoryPayload(item, seasons, animeSiblingsWhenGrouped())
      const result = await syncSimklHistory(path, body, priority)
      if (result.simklSynced) return { error: undefined }
      return { error: result.simklError ?? null, status: result.simklStatus }
    }
    case 'trakt': {
      const result = film
        ? await pushTraktHistory(item, {}, batch.action)
        : await pushTraktTitleHistory(item, seasons, batch.action)
      if (result.sent) return { error: undefined }
      return { error: result.error ?? null, status: result.status }
    }
    case 'mal': {
      const result = await pushMalTitleProgress(item, {
        status: batch.malStatus,
        seasons: [...new Set(batch.rows.map((row) => row.season ?? 1))],
        seasonTotals: batch.seasonTotals,
        profile
      })
      if (result.malSynced) return { error: undefined }
      return { error: result.malError ?? null, status: result.malHttpStatus }
    }
  }
}

let historyRetryInFlight: Promise<void> | null = null

/**
 * Sends the history pushes still owed for the active profile, one request
 * per service, title and direction, each on its title's own chain so it
 * stays in order with the pushes made since. Run at the start of every
 * watch-sync pass and every manual Sync. One at a time.
 *
 * A service that does not answer, or answers 429 or 5xx, gets no more of
 * this pass's batches (retryFailure): with a dozen titles owed to a service
 * that is down, sending each in turn would hold "Sync now" for the request
 * timeout a dozen times over before it reported anything.
 */
function retryHistoryPushes(priority: TaskPriority): Promise<void> {
  if (historyRetryInFlight) return historyRetryInFlight
  const run = runHistoryRetry(priority)
    .catch((error) => logError('history:retry', error))
    .finally(() => {
      historyRetryInFlight = null
    })
  historyRetryInFlight = run
  return run
}

async function runHistoryRetry(priority: TaskPriority): Promise<void> {
  const db = getDatabase()
  const profile = db.activeProfile()
  const marks = trackingAccountMarks()
  const pending = readHistoryPending(db, profile, marks)
  if (!Object.keys(pending).length) return
  const held = new Set(
    db.history().map((row) => watchKeyOf(String(row.id), row.season ?? null, row.episode ?? null))
  )
  const { batches, dropped } = historyRetryBatches(pending, held)
  if (dropped.length) {
    const now = readHistoryPending(db, profile, marks)
    for (const key of dropped) if (now[key]?.at === pending[key].at) delete now[key]
    writeHistoryPending(db, profile, now)
  }
  const stopped = new Set<HistoryService>()
  for (const batch of batches) {
    if (stopped.has(batch.service)) continue
    await titlePushQueue.run(titlePushKey(batch.item), async () => {
      // Whose history and whose account this is about, checked again after
      // the wait for the chain: a switch in between leaves it for later.
      if (db.activeProfile() !== profile) return
      if (trackingAccountMarks()[batch.service] !== marks[batch.service]) return
      const { error, status } = await sendHistoryRetry(batch, profile, priority)
      const failure = retryFailure(status)
      if (typeof error === 'string' && failure.stopsService) stopped.add(batch.service)
      if (error === null) {
        logError(
          'history:push-dropped',
          new Error(
            `dropped ${batch.action === 'add' ? 'adding' : 'removing'} ${batch.item.id} at ` +
              `${batch.service}: it can no longer be expressed to that service`
          )
        )
      }
      const settled = settleHistoryRetry(
        readHistoryPending(db, profile, trackingAccountMarks()),
        batch,
        error,
        { counted: failure.counts, now: Date.now() }
      )
      writeHistoryPending(db, profile, settled.pending)
      for (const entry of settled.abandoned) {
        logError(
          'history:push-abandoned',
          new Error(
            `gave up ${entry.action === 'add' ? 'adding' : 'removing'} ${entry.item.id} ` +
              `${entry.season ?? 'movie'}:${entry.episode ?? 'movie'} at ${entry.service}: ` +
              `${entry.lastError ?? 'unknown'}`
          )
        )
      }
    })
  }
}

/** How many history changes are still owed for the active profile, for the
 *  sync report. */
function historyPendingCount(): number {
  try {
    const db = getDatabase()
    return Object.keys(readHistoryPending(db, db.activeProfile(), trackingAccountMarks())).length
  } catch {
    return 0
  }
}

/**
 * The active profile's history keys that a read from `service` must not
 * bring back: a removal owed to it after a failed push (historyRetry.ts), a
 * removal still on its way to it, and, for Simkl, a film the review panel
 * ruled is not watched that Simkl has not been told about yet
 * (reconcileQueue.ts's reviewRemovalsOwed). The Simkl catch-up and the
 * Trakt history pull add these to what they count as already held here.
 */
export function removalsHeldBack(service: 'simkl' | 'trakt'): Set<string> {
  const db = getDatabase()
  const profile = db.activeProfile()
  const keys = new Set([
    ...removalsOwed(readHistoryPending(db, profile, trackingAccountMarks()), service),
    ...removalsInFlight(profile)
  ])
  if (service === 'simkl') {
    for (const key of reviewRemovalsOwed(pendingPushes(profile), abandonedReconcileIds(profile))) {
      keys.add(key)
    }
  }
  // An Undo of episodes that cannot be removed at the service they came
  // from (episodeSync.ts's noteUndone): held back here instead.
  const record = readShowSync(db, profile)
  const mark = trackingAccountMarks()[service]
  for (const key of undoneHeldBack(record, service, mark, Date.now())) keys.add(key)
  return keys
}

/** A `Partial<CatalogItem>` with a required id — assignable everywhere MediaHubDatabase's looser `{id: unknown}` item shape is expected, without a cast at the call site. */
type TrackableItem = Partial<CatalogItem> & { id: string }

/**
 * The remote half of a whole-title change: the named rows to Simkl and
 * Trakt, and a progress recompute to MAL — on the title's own chain, after
 * whatever is already in flight for it. A film goes as its own reference;
 * a show always as explicit seasons and episodes (see titleHistoryPayload
 * in simkl.ts for what a bare show reference would do). A grouped anime is
 * an entry per season at Simkl and at MAL alike, so it goes to both season
 * by season (animeEntries in simkl.ts, planMalPushes in mal.ts).
 */
function pushTitleHistory(
  item: SimklPushItem & { totalEpisodes?: number },
  rows: readonly { season: number | null; episode: number | null }[],
  action: 'add' | 'remove',
  {
    malStatus,
    seasonTotals
  }: {
    /** A list status chosen for MAL rather than inferred — see pushMalProgress. */
    malStatus?: 'plan_to_watch'
    /** Regular episodes per season, when the episode list was loaded: what
     *  each MAL entry is judged complete against. */
    seasonTotals?: ReadonlyMap<number, number>
  } = {}
): void {
  const path = action === 'add' ? '/sync/history' : '/sync/history/remove'
  // The MAL count is read when the push runs; it has to be this profile's.
  const profile = getDatabase().activeProfile()
  if (item.type === 'movie') {
    const at: HistoryPushAt = { item, rows: [{ season: null, episode: null }], action, profile }
    queueRemotePushes(
      item,
      () => [
        keptSimkl(at, syncSimklHistory(path, historyPayload(item, {}))),
        keptTrakt(at, pushTraktHistory(item, {}, action)),
        pushMalProgress(item)
      ],
      at
    )
    return
  }
  const seasons = bySeason(
    rows
      .filter((row) => row.episode != null)
      .map((row) => ({ season: row.season ?? 1, episode: row.episode as number }))
  )
  if (!seasons.length) return
  const at: HistoryPushAt = {
    item,
    rows: seasons.flatMap((s) => s.episodes.map((episode) => ({ season: s.season, episode }))),
    action,
    profile,
    mal: { status: malStatus, seasonTotals }
  }
  queueRemotePushes(
    item,
    () => [
      keptSimkl(
        at,
        syncSimklHistory(path, titleHistoryPayload(item, seasons, animeSiblingsWhenGrouped()))
      ),
      keptTrakt(at, pushTraktTitleHistory(item, seasons, action)),
      keptMal(
        at,
        pushMalTitleProgress(item, {
          status: malStatus,
          seasons: seasons.map((s) => s.season),
          seasonTotals,
          profile
        })
      )
    ],
    at
  )
}

interface MarkWatchedPayload {
  item: SimklPushItem
  playback?: PlaybackPosition
  /** Also start following the show, if nobody is yet, so it appears in
   *  Continue Watching. Set by the phone and TV app's player, which has no
   *  separate control for it. A local write only — see the handler. */
  follow?: boolean
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

interface ScrobblePayload {
  action: 'start' | 'pause' | 'stop'
  item: SimklPushItem
  playback?: PlaybackPosition
  /** How far through, 0-100. Simkl uses it to decide whether a `stop` means
   *  "finished" or "gave up", so sending it honestly matters more than the
   *  other two fields. */
  progress?: number
}

interface GetPositionPayload {
  id: string
  playback?: PlaybackPosition
}

interface ListPositionsPayload {
  id: string
}

interface SavePositionPayload {
  id: string
  playback?: PlaybackPosition
  positionSeconds: number
  durationSeconds?: number
  /** The 0-2 multiplier the player was at, stored so resuming this
   *  bookmark can resume its loudness too. */
  volume?: number
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
// real watch or fabricating one. (Additions are the one exception: the
// catch-up in simklCatchUp.ts takes in what Simkl holds and this library
// does not, add-only, on the desktop as on the phone, and the check below
// runs after it. What reaches this panel is what the catch-up could not
// settle: Simkl saying a film here is not watched, mostly.)
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
// completely rather than half-solving the harder case. Series and anime
// have that design now, as sets compared show by show after the pulls:
// episodeSync.ts, the review panel's shows section.

/** How long a real reconciliation attempt (success or failure) suppresses
 *  the next one. Opening and closing the app repeatedly — during testing,
 *  or just in normal use — must not turn into repeated Simkl requests;
 *  this is deliberately a floor on ATTEMPTS, not on confirmed successes,
 *  so a broken connection doesn't get hammered either. */
const RECONCILE_COOLDOWN_MS = 5 * 60 * 1000
/**
 * Every reconcile record is scoped to a profile.
 *
 * Reconciliation compares the LOCAL watch history against Simkl's, and the
 * local half became profile-scoped with the schema. These keys were stamped
 * only with the Simkl account, so a discrepancy raised for profile A could be
 * offered while profile B was active — and resolving it would either rewrite
 * B's newly scoped history or push A's decision to Simkl. The account is still
 * part of several of these keys where it already was; this adds the half that
 * was missing.
 */
function reconcileKey(prefix: string, profileId = getDatabase().activeProfile()): string {
  return `${prefix}:${profileId}`
}

const RECONCILE_COOLDOWN_KEY_PREFIX = 'reconcile:cooldown:v1'
/**
 * The most recent diff, kept for as long as the cooldown that produced it.
 *
 * The cooldown exists to stop the same expensive Simkl comparison running
 * over and over, and it works by refusing to run — which was fine when
 * the only thing that ever asked was the renderer, on mount. Now the
 * recurring watch-sync job asks too (see runBackgroundWatchSync), and
 * without somewhere to put its answer it would consume the cooldown and
 * throw the result away, leaving a review panel opened in the next five
 * minutes with nothing to show and no way to find out why.
 *
 * So whoever runs the diff writes it down, and a caller inside the
 * cooldown reads it rather than being told nothing happened. The work is
 * still done once per cooldown window; it is just no longer wasted.
 */
const RECONCILE_RESULT_KEY_PREFIX = 'reconcile:result:v2'
/**
 * How long that diff is kept. Longer than the cooldown, because the launch
 * check now asks Simkl's /sync/activities first and, when neither the films
 * there nor the films here have moved since the last diff (watchSync.ts's
 * filmDiffCurrent), answers with this one instead of reading Simkl's films
 * again. A day bounds how stale that can be: after it the films are read.
 */
const RECONCILE_RESULT_TTL_MS = 24 * 60 * 60 * 1000

/**
 * A cached diff, stamped with whose account it was computed against.
 *
 * Disconnecting and authorizing someone else inside the five-minute
 * cooldown would otherwise hand the new account the old account's
 * disagreements — and resolving one of those pushes a decision about
 * somebody else's library, or rewrites local history to match it.
 *
 * Checked at the point of USE rather than cleared on sign-out, for the
 * same reasons simklClient.ts's cachedHistoryFor spells out: clearing is
 * best-effort tidying that cannot run if the app was killed and cannot
 * catch a pass that was already in flight when the account changed. The
 * stamp covers all of it. v2 because a v1 row carries no stamp and can
 * never satisfy this check; the database's own prune reclaims those.
 */
interface CachedReconcileResult {
  account: string
  /** Which profile's history produced these. Stamped for exactly the reason
   *  the account is, and checked the same way on the way back out — the key
   *  alone is not enough, because a row can outlive the profile it was written
   *  for and a stale one must not be served rather than merely re-keyed. */
  profile: string
  discrepancies: WatchStatusDiscrepancy[]
}

/**
 * Writes a diff under the account it was COMPUTED for, not whichever one
 * happens to be connected by the time it finishes.
 *
 * Those are not the same moment: the diff reads Simkl's whole library and
 * then enriches every disagreement with metadata, which takes long enough
 * that signing out and authorizing someone else during it is an ordinary
 * thing to do. Deriving the stamp at write time would put account A's
 * rows under account B's mark, and the check on the way back out would
 * then happily serve them — resolving one pushes A's decision into B's
 * history. That is the exact failure the stamp exists to prevent, so the
 * account has to be captured before the work starts and discarded if it
 * changed, the same way simklWatchedSnapshot already does.
 */
function writeReconcileResult(
  account: string,
  profile: string,
  discrepancies: WatchStatusDiscrepancy[]
): void {
  if (!account || simklAccountMark() !== account) return
  // The profile gets the same treatment the account already had, and for the
  // same reason: computeMovieDiscrepancies awaits Simkl and metadata, and
  // switching profiles during it is an ordinary thing to do. Resolving the
  // key at WRITE time filed profile A's discrepancies under whoever was
  // active by the time the work finished — so B could be offered A's rows,
  // and resolving one would rewrite B's history.
  if (!profile || getDatabase().activeProfile() !== profile) return
  getDatabase().putCache<CachedReconcileResult>(
    // The captured profile, not the live one. Identical while the guard above
    // holds, and explicit so it stays right if that guard is ever loosened.
    reconcileKey(RECONCILE_RESULT_KEY_PREFIX, profile),
    { account, profile, discrepancies },
    RECONCILE_RESULT_TTL_MS
  )
}

/** The cached diff, but only if it belongs to the account connected now.
 *  Null when there is none, which is not the same as one with nothing in it. */
function storedReconcileResult(): WatchStatusDiscrepancy[] | null {
  const account = simklAccountMark()
  // No account connected matches no stamp — never the empty-string
  // account a malformed row might carry.
  if (!account) return null
  const profile = getDatabase().activeProfile()
  const row = getDatabase().getCache<CachedReconcileResult>(
    reconcileKey(RECONCILE_RESULT_KEY_PREFIX)
  )
  if (row?.account !== account || row.profile !== profile || !Array.isArray(row.discrepancies)) {
    return null
  }
  // Kept for up to a day now, so what was decided since it was made is
  // taken out on the way back: ignored, given up on, or queued to push.
  const ignored = ignoredReconcileIds()
  const givenUpOn = abandonedReconcileIds()
  const decided = new Set(pendingPushes().map((entry) => entry.id))
  return row.discrepancies.filter(
    (d) => !ignored.has(d.id) && !givenUpOn.has(d.id) && !decided.has(d.id)
  )
}

function cachedReconcileResult(): WatchStatusDiscrepancy[] {
  return storedReconcileResult() ?? []
}
/** Ids someone has explicitly said to stop asking about — kept far longer
 *  than the cooldown above (this is a decision, not a rate limit), but
 *  not forever: 90 days gives a genuinely stale dismissal a chance to
 *  resurface rather than being silently suppressed for the life of the
 *  install. */
const RECONCILE_IGNORED_KEY_PREFIX = 'reconcile:ignored:v1'
const RECONCILE_IGNORED_TTL_MS = 90 * 24 * 60 * 60 * 1000

function ignoredReconcileIds(): Set<string> {
  return new Set(getDatabase().getCache<string[]>(reconcileKey(RECONCILE_IGNORED_KEY_PREFIX)) || [])
}

function addIgnoredReconcileId(id: string): void {
  const ids = ignoredReconcileIds()
  ids.add(id)
  // Durable: someone pressed Ignore. These three reconcile rows live in
  // catalog_cache but are not cache — nothing refetches a decision, and
  // losing one brings the title straight back to the review panel that
  // has already told the person it was handled. See database.ts's
  // `durable` helper for why the store defaults the other way.
  getDatabase().putCache(
    reconcileKey(RECONCILE_IGNORED_KEY_PREFIX),
    [...ids],
    RECONCILE_IGNORED_TTL_MS,
    {
      durable: true
    }
  )
}

/** Titles this app gave up trying to push, after enough failed attempts
 *  that asking again would just be nagging (see PENDING_PUSH_MAX_ATTEMPTS).
 *
 *  Kept apart from the ignore list above, and scoped to an account,
 *  because the two are different kinds of fact. "Ignore" is a person
 *  saying stop asking me about this title, which is true of the title
 *  whichever account happens to be connected. Giving up is something
 *  that happened between this app and ONE account — another account has
 *  never been asked, and suppressing the title there would hide a
 *  disagreement nobody has ruled on. Same 90-day expiry either way. */
const RECONCILE_ABANDONED_KEY_PREFIX = 'reconcile:abandoned:v1'

interface AbandonedRecord {
  account: string
  ids: string[]
}

function abandonedReconcileIds(profile: string = getDatabase().activeProfile()): Set<string> {
  const stored = getDatabase().getCache<AbandonedRecord>(
    reconcileKey(RECONCILE_ABANDONED_KEY_PREFIX, profile)
  )
  if (!stored?.ids?.length || stored.account !== simklAccountMark()) return new Set()
  return new Set(stored.ids)
}

/** Reports whether the suppression actually stuck, on the same
 *  read-it-back terms as writePendingPushes — a title can only be
 *  treated as given up on once the record saying so exists, or the pass
 *  that reports it goes straight on to ask about it again. */
/** `profile` for the same reason pendingPushes takes one: this is written
 *  from inside the flush, AFTER its requests, so the live profile is not
 *  necessarily the one the flush is about. */
function addAbandonedReconcileId(
  id: string,
  profile: string = getDatabase().activeProfile()
): boolean {
  const ids = abandonedReconcileIds(profile)
  ids.add(id)
  const record: AbandonedRecord = { account: simklAccountMark(), ids: [...ids] }
  // Durable for the same reason as addIgnoredReconcileId: the person has
  // already been told this title is no longer being flagged.
  getDatabase().putCache(
    reconcileKey(RECONCILE_ABANDONED_KEY_PREFIX, profile),
    record,
    RECONCILE_IGNORED_TTL_MS,
    {
      durable: true
    }
  )
  return abandonedReconcileIds().has(id)
}

/** Decisions someone has already made ("keep local") that haven't been
 *  confirmed on every connected service yet. Persisted for the same
 *  reason as the ignored list above and with the same TTL: it's a record
 *  of what a person decided, not a rate limit, and a decision has to
 *  outlive a failed push or the app being closed — otherwise the exact
 *  titles they already ruled on come back on the next launch, which is
 *  the bug this queue exists to end. */
const RECONCILE_PENDING_KEY_PREFIX = 'reconcile:pending:v2'
const RECONCILE_PENDING_TTL_MS = 90 * 24 * 60 * 60 * 1000

/** The queue as persisted: entries plus WHOSE they are. */
interface PendingQueue {
  account: string
  entries: PendingWatchStatusPush[]
}

/** How long a "keep local" click waits for the clicks after it before the
 *  queue is flushed. Working through a review list is a burst of clicks a
 *  second or two apart, so this collapses the whole list into ONE request
 *  per service instead of one per row, without ever asking the person to
 *  press a separate "apply" button — the batch closes itself. Nothing is
 *  lost if the app quits mid-window: the queue is on disk, and the next
 *  reconcile check flushes it. */
const PENDING_FLUSH_DELAY_MS = 3000

/** Pacing for entries that have already failed at least once, kept apart
 *  from the reconcile cooldown next to it because the two are throttling
 *  different things. That one guards an expensive diff (two Simkl
 *  all-items reads) against being run too often. This one guards an
 *  entry's five-attempt budget: the check that retries the queue runs on
 *  every launch, so without pacing, a few restarts in a row could spend
 *  a decision's whole budget in about a minute and then suppress the
 *  title for ninety days. A decision nobody has tried yet is never
 *  subject to this — going out promptly is the entire promise of the
 *  batch timer. */
const RECONCILE_RETRY_KEY_PREFIX = 'reconcile:retry-cooldown:v1'
const RECONCILE_RETRY_COOLDOWN_MS = 5 * 60 * 1000

let flushTimer: NodeJS.Timeout | null = null
/** Wakes a long-running session up to retry what stayed queued. The
 *  check that would otherwise retry runs once per launch, so without
 *  this a failure at 9am — offline at the time, online a minute later —
 *  would sit untouched until the app was next started, however long it
 *  stayed open in between. Separate from flushTimer so a new decision's
 *  three-second batch cannot clobber the wake-up. */
let retryTimer: NodeJS.Timeout | null = null
/** The pacing deadline, mirrored in memory. The persisted copy is a
 *  cache write, and cache writes swallow their failures — so on a
 *  read-only or full database the deadline silently vanishes, every
 *  entry reads as retry-ready, and the wake-up arms for seconds instead
 *  of minutes: a loop firing requests at Simkl every few seconds for as
 *  long as the app is open, burning a decision's attempt budget on the
 *  way. Pacing is not something to hold only as well as the disk allows.
 *  The persisted copy is what carries it across launches; this is what
 *  makes it true within one. */
let retryPacingUntil = 0
/** Ids whose recorded `remoteWatched` is known to be out of date on
 *  disk: this app pushed them, learned what the remote side now holds,
 *  and could not write that down (see writePendingPushes on why a write
 *  can fail silently). The settle shortcut — drop an entry whose two
 *  sides have come to agree by themselves — reads that stale record and
 *  would conclude agreement with a remote state this app itself
 *  changed, dropping the decision and leaving the services opposed. An
 *  id in here is never settled on a snapshot; it is sent, which both
 *  services take idempotently. */
const staleSnapshots = new Set<string>()
let flushInFlight: Promise<Set<string>> | null = null
/** Bumped every time the connected Simkl account changes. A flush issues
 *  its requests one after another and simklRequest re-reads credentials
 *  on each one, so a flush that started under account A can have its
 *  second request answered by account B's token if someone signs out
 *  and in between the two — clearing the queue alone doesn't stop the
 *  work already in the air. Every flush pins this value at its start and
 *  checks it before each request and before believing its own results. */
let accountGeneration = 0
/** Set when a decision is made while a flush is already in flight. That
 *  flush snapshotted the queue before this decision existed and will
 *  neither push nor report it, and the single-flight guard below means
 *  the timer would otherwise just hand back the in-flight promise and
 *  drop the new decision until some later launch — so it re-arms once
 *  the current flush is done. Only a new DECISION sets this, never a
 *  failed push: a failure stays queued for the next reconcile check
 *  rather than spinning the batch timer against a service that is
 *  already refusing it. */
let flushAgain = false

/** Queued decisions belonging to the account connected right now. A
 *  queue stamped with any other connection is ignored outright — see
 *  simklAccountMark. */
/**
 * `profile` is a parameter rather than a lookup for the same reason the
 * account stamp is captured rather than derived: every caller that straddles
 * an `await` has to keep talking about the profile it STARTED with. A flush
 * that read A's queue, awaited Simkl, and then wrote back under whoever was
 * active by then applied A's outcome to B's decisions.
 *
 * Defaulted for the synchronous callers, where the two are the same value and
 * spelling it out would only be noise.
 */
function pendingPushes(profile: string = getDatabase().activeProfile()): PendingWatchStatusPush[] {
  const stored = getDatabase().getCache<PendingQueue>(
    reconcileKey(RECONCILE_PENDING_KEY_PREFIX, profile)
  )
  if (!stored?.entries?.length) return []
  return stored.account === simklAccountMark() ? stored.entries : []
}

/**
 * Writes the queue back, and reports whether it actually stuck. putCache
 * swallows its own failures by design (cache writes are best-effort
 * everywhere else in this app — a read-only or full database must never
 * surface to a caller), which is fine for a cache and not fine at all
 * for this: a decision acknowledged as recorded but never written is the
 * exact silent loss the queue exists to end. So the write is read back,
 * and callers that are about to tell someone "your choice is kept" have
 * something to check.
 */
function writePendingPushes(
  queue: PendingWatchStatusPush[],
  profile: string = getDatabase().activeProfile()
): boolean {
  const payload: PendingQueue = { account: simklAccountMark(), entries: queue }
  // Durable, and this is the row that most needs it: it IS the record of
  // an acknowledged "keep local" — the panel drops the discrepancy on the
  // strength of this write succeeding, and nothing else remembers the
  // choice. Losing it to a power cut is the exact failure the queue was
  // built to stop, just with a different cause.
  getDatabase().putCache(
    reconcileKey(RECONCILE_PENDING_KEY_PREFIX, profile),
    payload,
    RECONCILE_PENDING_TTL_MS,
    {
      durable: true
    }
  )
  // The whole payload, not just which ids are present: a flush that only
  // bumped `attempts` (or corrected `remoteWatched`) leaves the id set
  // identical, so comparing ids would call a rejected write a success
  // and let a failing entry sit at the same attempt count forever,
  // never reaching the cap that is supposed to stop it.
  return JSON.stringify(pendingPushes(profile)) === JSON.stringify(queue)
}

/**
 * Drops every queued decision, and any batch timer waiting to send them,
 * when the connected Simkl account changes — signing out, or authorizing
 * a different one. These are decisions about ONE account's history, and
 * the cost of dropping them is that a title someone already ruled on
 * gets asked about once more; the cost of delivering one to the wrong
 * account has no equivalent undo.
 *
 * Tidying, not the safety guarantee. The write below is best-effort and
 * can fail on a read-only or full database, and this can't run at all if
 * the app never reaches it (a crash, a kill). What actually keeps a
 * surviving queue from being delivered to the next account is the stamp
 * every entry carries — see simklAccountMark and pendingPushes.
 */
function clearPendingPushes(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  retryPacingUntil = 0
  staleSnapshots.clear()
  flushAgain = false
  // Disowns any flush already in the air as well as the queue on disk —
  // see accountGeneration for why the two are not the same thing.
  accountGeneration++
  writePendingPushes([])
}

function pushItemFor(entry: PendingWatchStatusPush): SimklPushItem {
  return { id: entry.id, type: entry.type, title: entry.title, year: entry.year }
}

/**
 * Sends every queued decision out to every connected tracking service, as
 * one batched request per direction (add vs. remove) rather than one per
 * title, and folds the results back into the queue.
 *
 * "Confirmed" is deliberately stricter than "the request didn't throw":
 * Simkl answers 200 for a push it never actually matched and reports the
 * casualties in `not_found` (see unmatchedCatalogIds), so a title listed
 * there stays queued for a retry instead of being quietly declared synced.
 * MAL is pushed for every otherwise-confirmed entry too — a no-op today,
 * since this pass only ever surfaces movies and pushMalProgress ignores
 * everything that isn't a Kitsu-id'd anime, but a MAL failure counts as a
 * failure for that entry rather than being swallowed, so "synced" always
 * means synced everywhere. Re-pushing on a later retry is safe: both
 * services take these as idempotent set-to-this-state writes.
 *
 * Returns the ids confirmed during THIS flush, so a check running right
 * after one doesn't re-report a title that was pushed seconds ago and
 * that Simkl's own all-items view may not reflect yet.
 */
async function pushPendingToServices(priority: TaskPriority): Promise<Set<string>> {
  // The profile this flush is ABOUT, captured before the first await and used
  // for every queue read and write below.
  //
  // The account already worked this way, a few lines down, for the identical
  // reason: a flush issues its requests one after another, and switching
  // profile during it is as ordinary as signing out during it. Resolving the
  // profile at write time applied A's confirmed-or-failed outcome to B's
  // queue — removing B's decision on the strength of A's result, and leaving
  // A's own queue stale enough to be pushed again later.
  const profile = getDatabase().activeProfile()
  const queue = pendingPushes(profile)
  if (!queue.length) return new Set()
  // Not connected — keep everything queued rather than failing attempts
  // against a service that was never asked. Being signed out isn't a push
  // that went wrong, and shouldn't burn this entry's attempt budget.
  // Nothing is armed here, and nothing needs to be: a queue only reads
  // back at all when its stamp matches the connected account, and that
  // stamp is derived from a token, so reaching this line with entries
  // in hand isn't possible. Connecting an account clears the queue and
  // a decision made without one is refused outright.
  if (!simklCredentials().accessToken) return new Set()

  // A decision nobody has tried yet always goes out. One that has
  // already failed waits for the retry pacing — see the retry-cooldown record
  // for what each of the two cooldowns is protecting.
  // The pacing holds a deadline, so a wake-up can be armed for exactly
  // what is left of the window rather than a fresh full one.
  const retryDeadline = retryPacingDeadline()
  const retryReady = retryDeadline <= Date.now()
  const attemptable = queue.filter((entry) => entry.attempts === 0 || retryReady)
  if (!attemptable.length) {
    // Everything queued is waiting on the pacing, and the check that
    // would otherwise come back to it runs once per launch — so an app
    // reopened inside the window and left open would never retry at
    // all. Arm the wake-up for the rest of the window instead.
    scheduleRetry(retryDeadline - Date.now())
    return new Set()
  }

  // Pinned for the whole flush: anything below this line is work done on
  // behalf of the account connected right now, and stops the moment that
  // is no longer the account connected.
  const generation = accountGeneration
  const disowned = (): boolean => generation !== accountGeneration

  const confirmed = new Set<string>()
  const failed = new Set<string>()
  /** id -> the value a successful request actually sent. */
  const pushedValue = new Map<string, boolean>()
  let error: string | undefined

  // The value to send is read HERE, not at decision time. Someone can
  // rule "keep local" while offline and then change that very state
  // before the push ever goes out; sending the stale snapshot would
  // write the exact opposite of the local truth this pass exists to
  // defend. Presence in history is what "watched" means for a movie,
  // which is all this pass ever queues (see the header comment).
  const locallyWatched = new Set(
    getDatabase()
      .history()
      .map((entry) => String(entry.id))
  )

  // Local has since come round to what the remote already said, so the
  // two sides now agree on their own — which is also how a "Use Simkl"
  // decision arrives here. Pushing anyway would be a no-op at best and —
  // for a removal Simkl has nothing to remove — an unmatched response that
  // retries until the attempt cap. Agreement judged against a record this
  // app knows to be behind what it did to the remote side is not agreement
  // — see staleSnapshots. These disagreements are done with at Simkl, and
  // still go to Trakt below.
  const { sendable, settled } = splitForFlush(attemptable, locallyWatched, staleSnapshots)

  for (const [watched, pathname] of [
    [true, '/sync/history'],
    [false, '/sync/history/remove']
  ] as const) {
    const group = sendable.filter((entry) => locallyWatched.has(entry.id) === watched)
    if (!group.length) continue
    // Signing out (or into a different account) between this flush's two
    // requests would otherwise send one account's decisions with the
    // other's token.
    if (disowned()) return new Set()
    const items = group.map(pushItemFor)
    // Nothing addressable in the whole group. In practice unreachable —
    // only ids that passed hasExpressibleSimklId reach this queue — but
    // an empty body would come back with an empty not_found, which this
    // loop would read as "every row confirmed pushed" and record as a
    // first-hand fact about an account nothing was sent to.
    const body = batchHistoryPayload(items.map((item) => ({ item })))
    if (!hasSimklContent(body)) continue
    try {
      const response = await simklRequest<SimklHistoryResponse>(
        pathname,
        { method: 'POST', body: JSON.stringify(body) },
        priority
      )
      const unmatched = new Set(unmatchedCatalogIds(response, items))
      for (const entry of group) {
        if (unmatched.has(entry.id)) {
          failed.add(entry.id)
          continue
        }
        confirmed.add(entry.id)
        // What the remote side now holds, because this request just put
        // it there — the one thing about it we know first-hand.
        pushedValue.set(entry.id, watched)
      }
      if (unmatched.size) error = 'Simkl did not find a match.'
    } catch (caught) {
      logError(`reconcile:push:${pathname}`, caught)
      error = (caught as Error).message
      for (const entry of group) failed.add(entry.id)
    }
  }

  // Requests went out, so the pacing starts now — including for the
  // entries this flush is about to mark as having failed.
  if (sendable.length) startRetryPacing(profile)

  // Nothing below this point is true of the account now connected: the
  // queue these results describe has already been dropped, so writing
  // the outcome back or reporting "synced" would both be lies.
  if (disowned()) return new Set()

  // The local state was read before the requests went out, and a request
  // takes long enough for someone to mark or unmark that very title in
  // the meantime (their own mark/unmark pushes too, so the two can also
  // land in either order). What went out — or what was judged not worth
  // sending — is then no longer what local says, and dropping the entry
  // on that basis would leave the two sides opposed with the decision
  // gone. Those entries stay queued to be reconsidered against the
  // current value, deliberately WITHOUT counting an attempt, since
  // nothing failed here; applyPushOutcome leaves anything in neither set
  // exactly as it is.
  const nowWatched = new Set(
    getDatabase()
      .history()
      .map((entry) => String(entry.id))
  )
  const changedUnderneath = (id: string): boolean => nowWatched.has(id) !== locallyWatched.has(id)
  for (const id of [...confirmed]) if (changedUnderneath(id)) confirmed.delete(id)
  for (const id of [...settled]) if (changedUnderneath(id)) settled.delete(id)

  for (const entry of queue) {
    if (!confirmed.has(entry.id)) continue
    const result = await pushMalProgress({ id: entry.id, type: entry.type })
    if (!result.malError) continue
    error = result.malError
    confirmed.delete(entry.id)
    failed.add(entry.id)
  }

  // TRAKT TOO, and it was the gap. This queue reached Simkl and MAL, so a
  // "Use Local" decision left Trakt holding the value the person had just
  // ruled against — and the next check against Trakt would raise it all
  // over again. "The tracking services that are connected" has to mean all
  // of them, or resolving a disagreement in one place creates one in
  // another. Settled entries as well as confirmed ones (traktFollowUps):
  // a "Use Simkl" decision, or a "Use Local" one local came round to by
  // itself, needs no request to Simkl but is still news to Trakt.
  //
  // Failures here do NOT un-confirm the entry, unlike MAL above. Simkl is
  // the service this queue's verdict is computed against and MAL's
  // progress is part of the same reconciliation; Trakt is a third party to
  // it. Dropping a decision Simkl accepted because Trakt was unreachable
  // would re-raise a disagreement that no longer exists. pushTraktHistory
  // already logs and swallows its own errors for the same reason.
  // A Trakt failure here is kept and retried like any other history push
  // (keptTrakt), which leaves this queue's verdict alone.
  for (const entry of traktFollowUps(queue, confirmed, settled)) {
    const item = { id: entry.id, type: entry.type, title: entry.title, year: entry.year }
    const action = locallyWatched.has(entry.id) ? 'add' : 'remove'
    await keptTrakt(
      { item, rows: [{ season: null, episode: null }], action, profile },
      pushTraktHistory(item, {}, action)
    )
  }

  // The one written record of what a flush actually did. Every failure
  // mode this path has had — blind confirmations, unattributable
  // not_found entries, decisions that vanished — was invisible precisely
  // because success and no-op looked identical in the log (a "keep local"
  // that changed nothing left no line anywhere). Catalog ids only; titles
  // and tokens stay out. A flush that only settled entries says so too:
  // those went to Trakt.
  if (sendable.length || settled.size) {
    logError(
      'reconcile:flush',
      `sent=${sendable.map((e) => e.id).join(',')} confirmed=${[...confirmed].join(',') || '-'} ` +
        `failed=${[...failed].join(',') || '-'} settled=${[...settled].join(',') || '-'}` +
        (error ? ` error="${error}"` : '')
    )
  }

  // The pushes above bypass simklWatchedSnapshot()'s own request path, so
  // its 20-minute cache never learns about them; left alone, the next
  // check compares against the stale pre-push snapshot and re-reports
  // exactly what was just resolved. On failure, leave it: it's still an
  // accurate reflection of Simkl.
  if (confirmed.size) invalidateSimklWatchedCache()

  // Re-read rather than reusing `queue` — anything queued while the
  // requests above were in flight belongs to the next flush, not this
  // one's verdict.
  const { queue: remaining, abandoned } = applyPushOutcome(
    // The captured profile, like every other queue touch in this function:
    // this read happens after the requests above and would otherwise pick up
    // whichever profile is active by now.
    pendingPushes(profile),
    [...confirmed, ...settled],
    failed
  )

  // Suppression BEFORE the queue write, not after. Giving up on a push
  // and then asking about the same title again — in this very pass,
  // since the diff that follows a check's flush would find it unchanged
  // and surface it — is the nagging loop this queue exists to end, with
  // the added insult of having just said it was given up on. So a title
  // is only let go of once the record saying so exists; one that can't
  // be written stays in the queue, where being queued suppresses it
  // anyway and a later flush can try again. Five failed attempts is
  // enough to stop asking; the store's 90-day expiry re-opens it.
  const letGo: PendingWatchStatusPush[] = []
  const stillHeld: PendingWatchStatusPush[] = []
  for (const entry of abandoned) {
    ;(addAbandonedReconcileId(entry.id, profile) ? letGo : stillHeld).push(entry)
  }

  // Entries that were pushed and stayed queued now know something new
  // about the remote side — see withPushedRemoteState.
  const kept = withPushedRemoteState([...remaining, ...stillHeld], pushedValue)
  const persisted = writePendingPushes(kept, profile)
  // A successful write only vouches for what THIS flush corrected. An
  // entry carrying staleness from an earlier one was written straight
  // back out with that same stale value — the write succeeding says
  // nothing about it, and clearing its marker would hand it back to the
  // settle shortcut it was being kept away from. Entries that left the
  // queue can never be settled against anything, so their markers go.
  if (persisted) {
    for (const id of pushedValue.keys()) staleSnapshots.delete(id)
    const queuedIds = new Set(kept.map((entry) => entry.id))
    for (const id of [...staleSnapshots]) if (!queuedIds.has(id)) staleSnapshots.delete(id)
  } else {
    for (const id of pushedValue.keys()) staleSnapshots.add(id)
  }
  if (!persisted) {
    // The pushes themselves stand (they are what the report says);
    // what could not be written down is which of them are now done.
    // Worst case they are pushed again on a later launch, which both
    // services take idempotently.
    logError('reconcile:queue-write', new Error('Could not record the outcome of the sync batch.'))
  }

  // Reported from what is actually on disk: if the write above didn't
  // stick, the OLD queue is still there — nothing was let go of, and
  // every failure in it will be tried again. Saying otherwise would
  // describe a batch that didn't happen, and leaving those titles out
  // of both lists would say nothing about them at all.
  const onDisk = persisted ? kept : queue
  const titleFor = (id: string): string => queue.find((x) => x.id === id)?.title || id
  const report: ReconcileSyncReport = {
    pushed: [...confirmed].map(titleFor),
    retrying: onDisk.filter((entry) => failed.has(entry.id)).map((entry) => entry.title),
    abandoned: persisted ? letGo.map((entry) => entry.title) : [],
    ...(error ? { error } : {})
  }
  if (report.pushed.length || report.retrying.length || report.abandoned.length) {
    sendToRenderer(MEDIA_HUB_CHANNELS.trackingReconcileSync, report)
  }
  // Anything still queued gets a wake-up, whatever kept it there — a
  // failed push, a decision the pacing deferred while other entries
  // went out, or one whose local state moved while its request was in
  // flight. Deriving this from the report instead only ever re-armed
  // failures, and left the other two waiting for a relaunch that might
  // be days away. The rule this is meant to hold: if something is
  // queued and this flush did not send it, a wake-up is armed for the
  // earliest moment it could be. Bounded by the attempt cap — entries
  // that keep failing are let go of, and an empty queue arms nothing.
  if (onDisk.length) {
    // Which wake-up depends on what is actually eligible, because the
    // eligibility rule above and this one have to agree or they park
    // work that could go out now. An entry still at zero attempts has
    // never failed — nothing about it is being paced — so it belongs on
    // the batch timer that every fresh decision uses; parking it behind
    // the failure cooldown would sit on a corrected decision for five
    // minutes. The cooldown is for entries that actually failed.
    if (onDisk.some((entry) => entry.attempts === 0)) scheduleFlush()
    else scheduleRetry(retryPacingDeadline(profile) - Date.now())
  }
  return confirmed
}

/**
 * Whether anything in this process has asked for the review panel's check.
 *
 * The desktop's interface asks a few seconds after it mounts. The phone and
 * TV app's has no review panel and never does — and for that backend the
 * recurring diff below would be two whole Simkl libraries fetched every
 * time a film changed, for a result nothing will ever read.
 */
let reviewAsked = false

/** What the recurring pass remembers about Simkl's gate — see watchSync.ts. */
const watchSyncMemory = newWatchSyncMemory()

/**
 * The review panel's diff, made in the background so it is ready when the
 * panel is next opened. Resolves true only when it was made against a
 * library fetched from Simkl in this call.
 *
 * Deliberately does NOT push discrepancies at the renderer. The review
 * panel is opened from the renderer's own reconcileCheck call (see
 * trackingReconcileCheck), which shares this same cooldown — so the two
 * cooperate rather than double-asking, and a background pass never
 * interrupts anyone with a panel they did not ask for.
 */
async function backgroundReconcile(): Promise<boolean> {
  const db = getDatabase()
  if (db.getCache(reconcileKey(RECONCILE_COOLDOWN_KEY_PREFIX))) return false
  db.putCache(reconcileKey(RECONCILE_COOLDOWN_KEY_PREFIX), true, RECONCILE_COOLDOWN_MS)
  const account = simklAccountMark()
  const profile = db.activeProfile()
  const diff = await computeMovieDiscrepancies('background')
  writeReconcileResult(account, profile, diff.discrepancies)
  return diff.fetched
}

/**
 * The recurring watch-history pass, for backgroundJobs.ts.
 *
 * What it does, in what order, and what it will not ask Simkl for unless
 * Simkl says something changed is watchSync.ts — which takes everything it
 * touches as a dependency so it can be tested. This is the real set.
 */
export async function runBackgroundWatchSync(): Promise<void> {
  await runWatchSync(
    {
      db: getDatabase(),
      account: simklAccountMark,
      // Background throughout: this is a recurring job nobody asked for, so
      // its requests must not jump ahead of the screen someone is looking
      // at, and must stand down along with the rest of the job once
      // playback starts.
      // Noted, as the catch-up notes its own, so the episode comparison
      // after this pass can go by it without asking again.
      activities: async () => {
        const account = simklAccountMark()
        const payload = await simklActivities('background')
        noteSimklActivities(account, payload, Date.now())
        return payload
      },
      syncPlanned: (options) => syncPlannedFromServices('background', options),
      flushPushes: () => flushPendingPushes('background'),
      retryHistory: () => retryHistoryPushes('background'),
      pullTraktHistory: () =>
        pullTraktHistoryNow(
          'background',
          () => removalsHeldBack('trakt'),
          (rows) => noteEpisodeArrivals('trakt', rows)
        ),
      reviewAsked: () => reviewAsked,
      reconcile: backgroundReconcile,
      now: () => Date.now(),
      log: logError
    },
    watchSyncMemory
  )
  // After the pulls: what each service lacks, show by show.
  await compareEpisodesAfterPull()
}

/** Single-flight wrapper — the debounce timer and a reconcile check can
 *  both ask for a flush, and two overlapping ones would push the same
 *  queue twice and race on writing it back. */
function flushPendingPushes(priority: TaskPriority = 'interactive'): Promise<Set<string>> {
  // A flush already running keeps the priority it started with. The
  // alternative — re-tiering in flight — is not something the scheduler
  // can do for requests it has already queued, and the two callers here
  // differ by seconds at most.
  if (flushInFlight) return flushInFlight
  const run = pushPendingToServices(priority)
    .catch((error) => {
      logError('reconcile:flush', error)
      return new Set<string>()
    })
    .finally(() => {
      flushInFlight = null
      if (!flushAgain) return
      flushAgain = false
      scheduleFlush()
    })
  flushInFlight = run
  return run
}

/** When the next retry is allowed: the later of what was written down
 *  and what this session remembers. */
function retryPacingDeadline(profile: string = getDatabase().activeProfile()): number {
  return Math.max(
    retryPacingUntil,
    getDatabase().getCache<number>(reconcileKey(RECONCILE_RETRY_KEY_PREFIX, profile)) ?? 0
  )
}

/** `profile` for the same reason as the two above — this is armed after the
 *  flush's requests have gone out. */
function startRetryPacing(profile: string = getDatabase().activeProfile()): void {
  const until = Date.now() + RECONCILE_RETRY_COOLDOWN_MS
  retryPacingUntil = until
  getDatabase().putCache(
    reconcileKey(RECONCILE_RETRY_KEY_PREFIX, profile),
    until,
    RECONCILE_RETRY_COOLDOWN_MS
  )
}

function scheduleRetry(delayMs: number = RECONCILE_RETRY_COOLDOWN_MS): void {
  if (retryTimer) clearTimeout(retryTimer)
  // Every caller is asking for "when the pacing allows". A delay that
  // isn't positive therefore means nothing is pacing this at all, which
  // is the state that turns a wake-up into a request loop — so it waits
  // out a full window rather than firing straight back.
  const delay = delayMs > 0 ? delayMs : RECONCILE_RETRY_COOLDOWN_MS
  // A second past the window, so the pacing it is waiting on has
  // definitely elapsed by the time this fires.
  retryTimer = setTimeout(() => {
    retryTimer = null
    void flushPendingPushes()
  }, delay + 1000)
}

function scheduleFlush(): void {
  if (flushInFlight) {
    flushAgain = true
    return
  }
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushPendingPushes()
  }, PENDING_FLUSH_DELAY_MS)
}

/**
 * The id a library write for `item` should go under. A card minted under
 * Simkl's own number whose real id this app has since learned (the detail
 * page resolved it into the metadata cache) is written under that real
 * id, so one click does not leave two rows for the reconcile pass to fold
 * later — see simklKeyedHistory.ts. Every other id is returned as it is.
 *
 * Whatever the library already holds under the Simkl-keyed id is folded
 * into the real id FIRST. No live surface mints these ids any more (the
 * trending feed drops them, and Simkl search is gone), so a Simkl-keyed
 * card on screen is drawn from a legacy history or plan row — and a
 * write that read state under the real id while that row sat untouched
 * would clear nothing, or plan a title twice. Folding moves the rows the
 * card is drawn from, and the library-changed push that follows rekeys
 * the card itself.
 */
function canonicalWriteId(item: { id: unknown; type?: unknown }): string {
  const id = String(item.id)
  if (!isSimklKeyedId(id)) return id
  const imdb = imdbForSimklKeyedId(
    id,
    [],
    (key) => cachedMetadata(String(item.type ?? 'movie'), key)?.id
  )
  if (!imdb) return id
  const db = getDatabase()
  const hadPlan = db.isTracked(id)
  if (db.mergeContentId(id, imdb) || hadPlan) {
    notifyLibraryChanged('canonical-id', 'history', 'planned', 'ratings')
  }
  return imdb
}

/**
 * An episode's coordinates as history keeps them.
 *
 * A later season of a merged anime has an id of its own — a plan card a
 * watchlist pull added carries it — and whatever is played or ticked from
 * such a card arrives named by that id. Kept that way it is a second copy
 * of the show's season under an id the show's page never reads, and the
 * count MyAnimeList is sent (read from the show's rows) leaves it out. So
 * it is kept under the show, at the season that id is there; see
 * animeHistoryCoordinates in serviceIds.ts for why the season it arrived
 * with is not carried over. Everything else comes back as it went in.
 */
function underShow<T extends { id: string }>(
  item: T,
  playback: PlaybackPosition
): { item: T; playback: PlaybackPosition } {
  const show = playback.episode == null ? null : laterSeasonOf(String(item.id))
  if (!show) return { item, playback }
  return { item: { ...item, id: show.id }, playback: { ...playback, season: show.season } }
}

interface MovieDiff {
  discrepancies: WatchStatusDiscrepancy[]
  /** Whether Simkl's library was read from Simkl for this diff — not from
   *  the snapshot cache, and not left unread. The recurring pass records
   *  Simkl's activity stamp only against a diff that was (watchSync.ts). */
  fetched: boolean
}

/** The actual diff. Local and remote are each reduced to "which movie ids
 *  does this side consider watched," and only ids where the two sides
 *  disagree are returned — an id watched (or not) on both sides is
 *  already in agreement and never surfaced. */
async function computeMovieDiscrepancies(
  priority: TaskPriority = 'background'
): Promise<MovieDiff> {
  const ignored = ignoredReconcileIds()
  // Titles this app has stopped trying to push for the connected
  // account — see addAbandonedReconcileId.
  const givenUpOn = abandonedReconcileIds()
  // Titles whose ruling is already made and merely waiting on (or
  // retrying) its push. Surfacing one of these would be asking the same
  // question a second time about something nobody changed their mind on.
  const decided = new Set(pendingPushes().map((entry) => entry.id))
  const db = getDatabase()
  const localMovies = new Map(
    db
      .history()
      .filter((h) => h.type === 'movie')
      .map((h) => [h.id, h] as const)
  )
  // Films only: this diff reads nothing else, and the shows library with
  // every episode's date is the largest thing this app asks Simkl for.
  const snapshot = await simklWatchedSnapshot(priority, { moviesOnly: true })
  // A row written under Simkl's own number for a title this account holds
  // under its IMDb id is the same viewing twice, not a disagreement — fold
  // it into the real row before diffing (see simklKeyedHistory.ts). Done
  // here, on the snapshot already fetched, rather than in a migration:
  // the pairing only Simkl can supply arrives with every check, and a
  // fresh duplicate is healed on the next pass the same as an old one.
  let folded = 0
  for (const [id, entry] of [...localMovies]) {
    if (!isSimklKeyedId(id)) continue
    const imdb = imdbForSimklKeyedId(
      id,
      snapshot.entries,
      (key) => cachedMetadata('movie', key)?.id
    )
    if (!imdb) continue
    folded += db.mergeContentId(id, imdb)
    localMovies.delete(id)
    if (!localMovies.has(imdb)) localMovies.set(imdb, { ...entry, id: imdb })
  }
  // Ratings too: the fold carries a score given under the old id across.
  if (folded) notifyLibraryChanged('reconcile', 'history', 'ratings')
  // No trustworthy remote side means there is nothing to diff. An
  // unreadable Simkl comes back as an EMPTY Simkl, and an empty Simkl
  // makes every movie watched locally look like a disagreement — a review
  // panel offering to push the person's entire watch history to an account
  // that already has it. Reporting nothing is the honest answer: the
  // cooldown lapses and the next pass asks again.
  if (!snapshot.complete) return { discrepancies: [], fetched: false }
  const remoteMovies = new Map(
    snapshot.entries.filter((h) => h.type === 'movie').map((h) => [h.id, h] as const)
  )
  const ids = new Set([...localMovies.keys(), ...remoteMovies.keys()])
  const out: WatchStatusDiscrepancy[] = []
  for (const id of ids) {
    if (ignored.has(id) || givenUpOn.has(id) || decided.has(id)) continue
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
      remoteWatched: remote,
      // An id no service can express (mockData's m-* demo ids, or anything
      // else unmappable) makes "Use Local" structurally unable to stick:
      // the push would go out as a title/year guess whose outcome can
      // neither be verified nor ever satisfy this id-joined diff, so the
      // row returned after every resolution — seen live as three demo-id
      // duplicates of already-synced films surviving five days of clicks.
      // The row is still SURFACED, deliberately: "Use Simkl" resolves it
      // for real by rewriting the local record (for a ghost duplicate,
      // deleting it), and dropping the row would leave that corruption in
      // history forever with nothing offering to clean it. The panel just
      // stops offering the one action that cannot work.
      pushable: hasExpressibleSimklId(id)
    })
  }
  // Simkl's all-items response can contain only an IMDb id for a movie, so
  // remote-only rows otherwise wind up displaying that id with no artwork.
  // Resolve the same cached metadata used by the detail page before handing
  // the review list to the renderer. Keep the history values as fallbacks so
  // a single unavailable metadata request never hides a discrepancy.
  // Bounded: a first sync against a large Simkl account can produce
  // hundreds of disagreements, and a bare Promise.all over them would
  // start that many metadata resolves at once for a review panel nobody
  // has opened yet. mapWithLimit never returns null for an item here —
  // the per-item catch below always yields the unenriched row — so the
  // fallback is only satisfying the type.
  const discrepancies = (
    await mapWithLimit(out, async (discrepancy) => {
      // An unmappable id 404s every metadata provider on every single
      // pass (three such lines per check, for weeks, in the live log).
      // The local history row already carries title/poster/year, which is
      // all the panel needs to offer "Use Simkl" on it.
      if (!discrepancy.pushable) return discrepancy
      try {
        const detail = await metadata('movie', discrepancy.id, priority)
        return {
          ...discrepancy,
          title: detail.title || discrepancy.title,
          poster: detail.poster || discrepancy.poster,
          year: detail.year || discrepancy.year
        }
      } catch (error) {
        logError('reconcile:metadata', error)
        return discrepancy
      }
    })
  ).map((row, index) => row ?? out[index])
  return { discrepancies, fetched: snapshot.fetched }
}

// ---------------------------------------------------------------------
// Episodes, show by show — see episodeSync.ts.
//
// After the pulls (the catch-up, the Trakt pull, the half-hourly pass), each
// service whose activity stamp moved is read whole once and compared show by
// show; what it lacks is sent to it, and what each pass merged is recorded
// for the review panel's shows section. Only on a backend whose interface
// has that panel (reviewAsked): the phone and TV app keep the add-only
// catch-up, and their pulls still note what they took in.

/** How old the catch-up's /sync/activities answer may be for the comparison
 *  to go by it. Older, or none, and Simkl is left for a later pass rather
 *  than asked again: the comparison makes no gate request of its own. */
const EPISODE_STAMP_MAX_AGE_MS = 5 * 60 * 1000
/** A choice's pushes wait this long for the next choice, as "keep local"
 *  does (PENDING_FLUSH_DELAY_MS), so working down the list goes out as one
 *  request per service and title. */
const EPISODE_DECISION_FLUSH_MS = 3000

function episodeMarks(): Record<EpisodeService, string> {
  const marks = trackingAccountMarks()
  return { simkl: marks.simkl, trakt: marks.trakt }
}

/** Whether an episode of a show can be named to a service at all: an id the
 *  service knows, and for an anime at Simkl, an entry the placing rules can
 *  show is that season (toSimklAnimeEpisode). Trakt is never sent anime. */
function canSendEpisode(service: EpisodeService, show: SyncShow, ep: Ep): boolean {
  if (service === 'trakt') {
    return isTraktPushable({ id: show.id, type: show.type, title: show.title })
  }
  if (!hasExpressibleSimklId(show.id)) return false
  if (show.type !== 'anime') return true
  return toSimklAnimeEpisode({ id: show.id, ...ep }, animeSiblingsWhenGrouped()) !== null
}

/**
 * Sends episodes held here to one service, as an add, on the title's own
 * chain, so a failure is kept and retried (keptSimkl, keptTrakt). Read again
 * when the push runs: an episode un-marked in the meantime is not sent. Each
 * episode carries the time it was watched here (withWatchedAt); a retry
 * after a failure goes without it, as every retried push does.
 */
function sendEpisodesTo(service: EpisodeService, show: SyncShow, eps: Ep[]): void {
  const item = { id: show.id, type: show.type, title: show.title, year: show.year ?? '' }
  const profile = getDatabase().activeProfile()
  queueRemotePushes(item, () => {
    const db = getDatabase()
    if (db.activeProfile() !== profile) return []
    const dates = new Map<string, string>()
    for (const row of db.history()) {
      if (String(row.id) !== show.id || row.season == null || row.episode == null) continue
      const key = `${row.season}:${row.episode}`
      const held = dates.get(key)
      if (row.watchedAt && (!held || Date.parse(row.watchedAt) > Date.parse(held))) {
        dates.set(key, row.watchedAt)
      } else if (!held) {
        dates.set(key, '')
      }
    }
    const rows = eps.filter((ep) => dates.has(`${ep.season}:${ep.episode}`))
    if (!rows.length) return []
    const at: HistoryPushAt = { item, rows, action: 'add', profile }
    const seasons = bySeason(rows)
    return service === 'simkl'
      ? [
          keptSimkl(
            at,
            syncSimklHistory(
              '/sync/history',
              withWatchedAt(titleHistoryPayload(item, seasons, animeSiblingsWhenGrouped()), dates),
              'background'
            )
          )
        ]
      : [keptTrakt(at, pushTraktTitleHistory(item, seasons, 'add', dates))]
  })
}

/** History keys with a change owed to the service or on its way there. */
function episodeKeysOwed(service: EpisodeService): Set<string> {
  const db = getDatabase()
  const keys = removalsHeldBack(service)
  for (const entry of Object.values(
    readHistoryPending(db, db.activeProfile(), trackingAccountMarks())
  )) {
    if (entry.service === service) keys.add(watchKeyOf(entry.item.id, entry.season, entry.episode))
  }
  return keys
}

/** Where a Simkl anime entry is kept here, by the placing rules: a later
 *  season only where laterSeasonOf can show it is that season of the page,
 *  never by its position in the group. */
async function placeSimklAnime(title: SimklLibraryTitle): Promise<AnimePlace> {
  let kitsu = title.kitsu ?? null
  if (!kitsu) {
    let answered = true
    for (const [service, value] of [
      ['mal', title.mal],
      ['anidb', title.anidb]
    ] as const) {
      if (!value) continue
      const found = await kitsuIdLookup(service, value, 'background')
      if (found.kitsuId) {
        kitsu = found.kitsuId
        break
      }
      if (!found.answered) answered = false
    }
    if (!kitsu) return answered ? { kind: 'none' } : { kind: 'unanswered' }
  }
  const id = `kitsu:${kitsu}`
  const later = laterSeasonOf(id)
  if (later) return { kind: 'placed', id: later.id, season: later.season }
  const target = resolveAnimeGroupTarget(id)
  if (target.id === id) return { kind: 'placed', id, season: 1 }
  return { kind: 'mismatched', ids: [id, target.id] }
}

async function readEpisodeSource(source: EpisodeSource): Promise<RemoteRead> {
  switch (source) {
    case 'simkl-shows':
      return simklShowsRead(await simklLibrary('show', 'background', null))
    case 'simkl-anime':
      if (!animeGroupingReady()) throw new Error('The anime catalog is still being organised.')
      return simklAnimeRead(await simklLibrary('anime', 'background', null), placeSimklAnime)
    case 'trakt-shows':
      return traktShowsRead(await traktRequest('/sync/watched/shows', {}, 'background'))
  }
}

/** A source's activity stamp as the pass that just ran read it: Simkl's from
 *  the catch-up's (or the job's) /sync/activities answer, Trakt's from what
 *  the history pull recorded. */
function episodeSourceStamp(source: EpisodeSource): string | null {
  const db = getDatabase()
  if (source === 'trakt-shows') {
    const state = traktPullStateFor(
      db.getCache(traktPullKey(db.activeProfile()), { allowExpired: true }),
      trackingAccountMarks().trakt
    )
    return state?.stamps?.episodes ?? null
  }
  const payload = recentSimklActivities(simklAccountMark(), EPISODE_STAMP_MAX_AGE_MS)
  if (payload === undefined) return null
  const stamps = parseSimklActivities(payload)
  if (source === 'simkl-anime') return animeGroupingReady() ? stamps.anime : null
  return stamps.shows
}

let episodeCompareInFlight: Promise<void> | null = null

/** The comparison, after a pull. One at a time; never throws. */
function compareEpisodesAfterPull(): Promise<void> {
  if (!reviewAsked) return Promise.resolve()
  if (episodeCompareInFlight) return episodeCompareInFlight
  const run = compareEpisodeSets({
    db: getDatabase(),
    marks: episodeMarks,
    stamp: episodeSourceStamp,
    read: readEpisodeSource,
    pending: episodeKeysOwed,
    canSend: canSendEpisode,
    send: sendEpisodesTo,
    // At most once a day, like the Trakt pull's.
    backup: () => backupBeforeRewrite('episode-sync', { notWithinMs: 24 * 60 * 60 * 1000 }),
    announce: () => {
      requestRecommendationsRebuild()
      notifyLibraryChanged('episode-sync', 'history')
    },
    now: () => Date.now(),
    log: logError
  })
    .then((report) => {
      if (report.added || report.sent) {
        logError(
          'episode-sync',
          `compared=${report.compared.join(',')} added=${report.added} sent=${report.sent}`
        )
      }
      if (report.compared.length) announceShowSyncRows()
    })
    .catch((error) => logError('episode-sync', error))
    .finally(() => {
      episodeCompareInFlight = null
    })
  episodeCompareInFlight = run
  return run
}

/**
 * Notes what a pull just wrote as arrivals from `service`, for the shows
 * section. Called by the catch-up and the Trakt pull straight after their
 * write, before anything else can change the profile. Never throws.
 */
export function noteEpisodeArrivals(service: EpisodeService, rows: readonly ImportedPlay[]): void {
  try {
    const db = getDatabase()
    const profile = db.activeProfile()
    const record = readShowSync(db, profile)
    const next = noteArrivals(record, service, episodeMarks()[service], rows, Date.now())
    if (next !== record && writeShowSync(db, profile, next)) announceShowSyncRows()
  } catch (error) {
    logError('episode-sync:arrivals', error)
  }
}

/** The shows section as the panel draws it. */
function showSyncRows(): ShowSyncRow[] {
  const db = getDatabase()
  const entries = liveShowSync(readShowSync(db, db.activeProfile()), episodeMarks(), Date.now())
  if (!entries.length) return []
  const posters = new Map(
    db
      .indexByIds(entries.map((entry) => entry.id))
      .items.map((item) => [String(item.id), item.poster || ''] as const)
  )
  return entries.map((entry) => {
    const services: ShowSyncRow['services'] = {}
    for (const [service, part] of Object.entries(entry.parts) as [
      EpisodeService,
      NonNullable<(typeof entry.parts)[EpisodeService]>
    ][]) {
      const all = [...part.arrived, ...part.sent, ...part.unsendable]
      services[service] = {
        arrived: part.arrived,
        sent: part.sent,
        unsendable: part.unsendable,
        blockedSeasons: seasonsOf(all).filter(
          (season) => !canSendEpisode(service, entry, { season, episode: 1 })
        )
      }
    }
    return {
      id: entry.id,
      type: entry.type,
      title: entry.title,
      year: entry.year ?? '',
      poster: posters.get(entry.id) ?? '',
      at: entry.at,
      services
    }
  })
}

/** Tells the review panel the shows section changed: a pass after launch
 *  (a focus catch-up, the half-hourly job) adds rows the launch check did
 *  not have, and the top bar's button counts them. Only where there is a
 *  panel (reviewAsked); never throws. */
function announceShowSyncRows(): void {
  if (!reviewAsked) return
  try {
    sendToRenderer(MEDIA_HUB_CHANNELS.trackingEpisodeReviewChanged, { shows: showSyncRows() })
  } catch (error) {
    logError('episode-sync:announce', error)
  }
}

let episodeFlushTimer: NodeJS.Timeout | null = null

/** Sends what the panel's choices queued, a few seconds after the last one. */
function scheduleEpisodeFlush(): void {
  if (episodeFlushTimer) clearTimeout(episodeFlushTimer)
  episodeFlushTimer = setTimeout(() => {
    episodeFlushTimer = null
    void retryHistoryPushes('interactive')
  }, EPISODE_DECISION_FLUSH_MS)
}

/** Registers every `tracking:*`, `home:personalized`, and `simkl:*` IPC handler. Call once during main-process startup. */
export function registerTrackingIpc(): void {
  handle<undefined, TrackingListResult>(MEDIA_HUB_CHANNELS.trackingList, async () => {
    const db = getDatabase()
    const trackedItems = db.tracked()
    // Local history ONLY — no live/cached Simkl merge here. This used to
    // fold in the Simkl watched history unconditionally, which is cached for
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
    // Bounded, and at `visible` rather than `interactive`. This used to be
    // a bare Promise.all over every tracked series, which meant a large
    // library opened one request per title the moment the app started —
    // and home:personalized below did exactly the same thing at the same
    // moment, for the same titles. metadata() is coalesced per title now,
    // so the two calls share one fetch each; mapWithLimit is what stops
    // either of them starting hundreds of resolves at once regardless.
    const details = (
      await mapWithLimit(
        trackedItems.filter((x) => x.type !== 'movie'),
        (x) => metadata(x.type, x.id, 'visible')
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
    return {
      tracked,
      history,
      plannedSources: plannedSources(),
      // Where a later season's card finds its episodes: under the show.
      laterSeasons: watchedLaterSeasons(history, animeSiblingsWhenGrouped())
    }
  })

  /**
   * Pull plan-to-watch from every connected service, on demand.
   *
   * Also runs with the background watch sync, so an untouched app catches
   * up on its own — this exists for the case where somebody has just
   * added a pile of titles on the web and does not want to wait for the
   * next pass to see them.
   */
  handle<undefined, PlannedSyncReport>(MEDIA_HUB_CHANNELS.trackingPlannedSync, async () => {
    // The history pushes still owed go first, as at the start of the
    // half-hourly pass: somebody pressing Sync wants the services caught up
    // in both directions.
    await retryHistoryPushes('interactive')
    const report = await syncPlannedFromServices('interactive')
    return { ...report, historyPending: historyPendingCount() }
  })

  /** The last pull's result, so the panel has something to show before
   *  anybody presses the button. The count of history pushes still owed is
   *  read now rather than stored with it. */
  handle<undefined, PlannedSyncReport | null>(
    MEDIA_HUB_CHANNELS.trackingPlannedReport,
    async () => {
      const report = lastPlannedSyncReport()
      return report ? { ...report, historyPending: historyPendingCount() } : null
    }
  )

  /**
   * The catch-up — see simklCatchUp.ts. The phone and TV app ask on launch
   * and on every resume, the desktop on launch and on window focus
   * (useServiceCatchUp); the pass itself decides whether that is worth a
   * request, so the screen never has to.
   */
  handle<{ force?: boolean; leaveListsToJob?: boolean } | undefined, CatchUpReport>(
    MEDIA_HUB_CHANNELS.trackingCatchUp,
    async (_e, payload) => {
      const report = await catchUpFromServices({
        force: payload?.force === true,
        leaveListsToJob: payload?.leaveListsToJob === true
      })
      // The episode comparison behind it, without holding the answer up.
      void compareEpisodesAfterPull()
      return report
    }
  )

  /**
   * Whether one title is on the list and which of it is watched, from the
   * database alone. The detail screen needs this to start Play at the right
   * episode, and tracking:list answers it only after resolving metadata for
   * every tracked series — seconds on a long list, for one title's rows.
   */
  handle<{ id: string }, TitleWatchState>(MEDIA_HUB_CHANNELS.trackingTitleState, (_e, payload) => {
    const db = getDatabase()
    const id = String(payload?.id ?? '')
    return {
      tracked: db.isTracked(id),
      watched: db
        .history()
        .filter((entry) => String(entry.id) === id)
        .map((entry) => ({ season: entry.season, episode: entry.episode }))
    }
  })

  /**
   * Named lists from the services, read only.
   *
   * Answers from cache first and refreshes behind it: reading these
   * costs one request per list, and somebody opening My Stuff should
   * not wait on thirty of them to see a name they saw this morning.
   */
  handle<undefined, { lists: RemoteList[] }>(MEDIA_HUB_CHANNELS.listsRemote, async () => {
    const cached = cachedRemoteLists()
    if (cached.length > 0) {
      void fetchRemoteLists('background').catch(() => {
        // Logged inside; the cached answer already went out.
      })
      return { lists: cached }
    }
    return { lists: await fetchRemoteLists('visible') }
  })

  handle<{ enabled?: boolean }, { watchlistTwoWay: boolean }>(
    MEDIA_HUB_CHANNELS.trackingSetTwoWay,
    (_e, payload) => {
      const settings = readSettings()
      const enabled = payload?.enabled !== false
      settings.watchlistTwoWay = enabled
      writeSettings(settings)
      // The origins record is deliberately KEPT when this is turned
      // off. It is the app's memory of what came from where, and
      // discarding it would mean turning the setting back on later
      // starts with no history — which is exactly the state in which
      // a removal cannot be told apart from an addition.
      return { watchlistTwoWay: enabled }
    }
  )

  handle<{ enabled?: boolean }, { scrobbleEnabled: boolean }>(
    MEDIA_HUB_CHANNELS.trackingSetScrobble,
    (_e, payload) => {
      const settings = readSettings()
      settings.scrobbleEnabled = payload?.enabled === true
      writeSettings(settings)
      return { scrobbleEnabled: settings.scrobbleEnabled }
    }
  )

  handle<TrackableItem, { tracked: boolean }>(MEDIA_HUB_CHANNELS.trackingToggle, (_e, item) => {
    const db = getDatabase()
    // Same canonical id as every other write, so Add to My List from a
    // legacy Simkl-keyed card plans the real title, once.
    item = { ...item, id: canonicalWriteId(item) }
    const tracked = db.isTracked(item.id)
    if (tracked) db.untrack(item.id)
    else db.track(item)
    // A search-only title gets an index row, or My List cannot show it.
    if (!tracked) indexTrackedTitle(item)
    requestRecommendationsRebuild()
    // Out to the services, without making anybody wait for it. Three
    // third-party APIs between pressing Plan to Watch and the button
    // changing state is the wrong trade; the local write is the answer,
    // and the push reports its own failures.
    pushLocalPlanChange(
      {
        id: String(item.id),
        type: (item.type ?? 'movie') as MediaKind,
        title: String(item.title ?? ''),
        year: item.year ? String(item.year) : undefined
      },
      !tracked
    )
    return { tracked: !tracked }
  })

  handle<MarkWatchedPayload, MarkWatchedResult>(
    MEDIA_HUB_CHANNELS.trackingMarkWatched,
    async (_e, { item, playback: asked, follow }) => {
      // This handler used to refuse any id no tracking service can
      // express, on the grounds that only mockData's m-* demo pool could
      // produce one — the write that put three demo-id duplicates into
      // real watch_history on Aug 24 (PR #144 has the post-mortem). The
      // demo pool has since been deleted outright, so the only ids that
      // predicate still caught were real titles the id bridge hasn't
      // mapped yet, and refusing those loses real history to protect
      // against a source that no longer exists. Whether a row can be
      // PUSHED is still asked, per row, on the way out (see
      // hasExpressibleSimklId in reconcileCheck).
      //
      item = { ...item, id: canonicalWriteId(item) }
      // A later season of a merged anime, played from its own card, is kept
      // under the show — see underShow.
      const kept = underShow(item, asked || {})
      item = kept.item
      const playback = kept.playback
      const db = getDatabase()
      db.markWatched(item, playback)
      indexTrackedTitle(item)
      // A show played on the phone or TV is followed, so it reaches
      // Continue Watching there — the lite UI has no My List button on the
      // player to do it by hand. Local only, never pushLocalPlanChange: a
      // plan add would move the show back to plan to watch at Simkl, and
      // Simkl learns it is being watched from the history push below.
      if (follow && item.type !== 'movie' && !db.isTracked(item.id)) db.track(item)
      requestRecommendationsRebuild()
      // None of the services is awaited. The local row IS the record; each
      // push logs its own failure (syncSimklHistory, pushMalProgress,
      // traktClient), and nothing in the renderer reads the per-service
      // fields of this result. Awaiting Simkl and MAL here put two live
      // round trips between a tap on a tick and the tick appearing — which
      // is what "tracking does not update properly" felt like.
      // Ordered per title, not merely detached — see queueRemotePushes.
      const profile = getDatabase().activeProfile()
      const at: HistoryPushAt = { item, rows: [rowOf(playback)], action: 'add', profile }
      queueRemotePushes(item, () => [
        keptSimkl(
          at,
          syncSimklHistory(
            '/sync/history',
            historyPayload(item, playback, animeSiblingsWhenGrouped())
          )
        ),
        keptTrakt(at, pushTraktHistory(item, playback, 'add')),
        keptMal(at, pushMalProgress(item, { season: playback.season ?? undefined, profile }))
      ])
      return { ok: true, simklSynced: false, malSynced: false }
    }
  )

  handle<MarkWatchedPayload, MarkWatchedResult>(
    MEDIA_HUB_CHANNELS.trackingUnmarkWatched,
    async (_e, { item, playback }) => {
      // The same id the mark went under, so an unmark of a Simkl-keyed
      // card deletes the row the mark wrote and queues behind its push —
      // and, for a later season of a merged anime, the same show.
      const kept = underShow({ ...item, id: canonicalWriteId(item) }, playback || {})
      item = kept.item
      const p = kept.playback
      getDatabase().unmarkWatched(item.id, p.season, p.episode)
      requestRecommendationsRebuild()
      // Detached as above, and queued behind any push still in flight for
      // this title — an unmark a moment after a mark must reach the
      // services second.
      const profile = getDatabase().activeProfile()
      const at: HistoryPushAt = { item, rows: [rowOf(p)], action: 'remove', profile }
      queueRemotePushes(
        item,
        () => [
          keptSimkl(
            at,
            syncSimklHistory(
              '/sync/history/remove',
              historyPayload(item, p, animeSiblingsWhenGrouped())
            )
          ),
          keptTrakt(at, pushTraktHistory(item, p, 'remove')),
          keptMal(at, pushMalProgress(item, { season: p.season ?? undefined, profile }))
        ],
        at
      )
      return { ok: true, simklSynced: false, malSynced: false }
    }
  )

  handle<MarkSeasonWatchedPayload, MarkWatchedResult>(
    MEDIA_HUB_CHANNELS.trackingMarkSeasonWatched,
    async (_e, { item, season: askedSeason, episodes }) => {
      item = { ...item, id: canonicalWriteId(item) }
      // One season at a time (the renderer's selection never spans two), so
      // a later season of a merged anime moves under its show as a whole —
      // see underShow.
      const show = laterSeasonOf(String(item.id))
      if (show) item = { ...item, id: show.id }
      const season = show ? show.season : askedSeason
      const list = (Array.isArray(episodes) ? episodes : []).map((p) =>
        show ? { ...p, season: show.season } : p
      )
      const episodeNumbers = list.map((p) => p.episode)
      const db = getDatabase()
      for (const playback of list) db.markWatched(item, playback)
      indexTrackedTitle(item)
      requestRecommendationsRebuild()
      // Detached and ordered per title, as the single-episode handler above.
      // Not awaited into the result — a Trakt failure is logged in
      // traktClient rather than making "mark this season watched" wait on
      // the slowest connected service. The Trakt push was missing entirely
      // until now: the single-episode handler got one when Trakt sync was
      // added, but this batch action did not, which left every episode of
      // a season marked watched here still unwatched on a connected Trakt
      // account.
      const profile = db.activeProfile()
      const at: HistoryPushAt = {
        item,
        rows: list.map((p) => rowOf(p)),
        action: 'add',
        profile
      }
      queueRemotePushes(item, () => [
        keptSimkl(
          at,
          syncSimklHistory(
            '/sync/history',
            seasonHistoryPayload(item, season, episodeNumbers, animeSiblingsWhenGrouped())
          )
        ),
        keptTrakt(at, pushTraktSeasonHistory(item, season, episodeNumbers)),
        keptMal(at, pushMalProgress(item, { season, profile }))
      ])
      return { ok: true, simklSynced: false, malSynced: false }
    }
  )

  /**
   * One title, one status: not watched, plan to watch, or watched.
   *
   * The whole-title form of the handlers above, for every surface that
   * has a title but no episode list — a card, the hero, a context menu,
   * the library's side panel. What the change amounts to is decided in
   * titleStatusRules.ts (pure, tested); this runs the steps in order and
   * sends each one out on the title's own push chain, so the un-plan that
   * follows a mark can never overtake the history it depends on.
   *
   * "Watched" for a show means every aired regular episode, read from the
   * title's own metadata and written in one transaction; "not watched"
   * clears whatever history holds and tells the services exactly which
   * episodes, never "the show". Marking watched takes a planned title off
   * the plan — without asking Simkl or MAL to remove it, for the reasons
   * unplanBecauseWatched gives. Clearing leaves the plan alone (see the
   * rules file header for why).
   *
   * `episodes` is the undo: exactly those rows, dates kept, and nothing
   * about the plan — replaying what the change being undone reported.
   */
  handle<SetTitleStatusPayload, SetTitleStatusResult>(
    MEDIA_HUB_CHANNELS.trackingSetTitleStatus,
    async (_e, { item, status, episodes, profileId }) => {
      const db = getDatabase()
      // The profile is the database's one mutable scope, and every write
      // below is for whoever is active now. An undo names the profile its
      // change was made on and is refused for any other; the one wait in
      // here is checked against it after, so a switch during it lands in
      // nobody's library.
      const profile = db.activeProfile()
      if (profileId && profileId !== profile) {
        throw new Error('That change was made on another profile. Switch back to it to undo.')
      }
      const id = canonicalWriteId(item)
      const type = (item.type ?? 'movie') as MediaKind
      const episodic = type !== 'movie'
      indexTrackedTitle({ ...item, id, type })
      // A later season of a merged anime, named by its own id — the card a
      // watchlist pull added. Its PLAN is its own: that id names the entry
      // at the service, which is what a removal has to be aimed at. Its
      // VIEWINGS are the show's, at the season it is there. So the status
      // of such a card is read and written over that one season of the
      // show: "watched" marks that season, "not watched" clears it, and
      // the rest of the show is not touched.
      const part = type === 'anime' ? laterSeasonOf(id) : null
      const historyId = part?.id ?? id
      const inPart = (row: { season: number | null }): boolean =>
        !part || row.season === part.season
      const pushItem: SimklPushItem & { totalEpisodes?: number } = {
        ...item,
        id,
        type,
        title: String(item.title ?? ''),
        year: item.year ? String(item.year) : ''
      }
      /** What a history push is made for: the title, or the show a later
       *  season's viewings are kept under. Built when asked, because the
       *  year and the episode total are filled in below. */
      const historyItem = (): SimklPushItem & { totalEpisodes?: number } =>
        part ? { ...pushItem, id: historyId } : pushItem
      const plan = { id, type, title: pushItem.title, year: pushItem.year || undefined }
      const changed: ChangedEpisode[] = []
      // The whole push item, not a hand-built subset: what is spread here
      // is what normalizeTitle keeps as the row's metadata — the poster the
      // History tab draws, the Simkl id — exactly as markWatched received it.
      const importRows = (rows: ChangedEpisode[], fallbackAt: string): ImportedPlay[] =>
        rows.map((row) => ({
          ...pushItem,
          id: historyId,
          type,
          title: pushItem.title,
          year: pushItem.year || undefined,
          season: row.season,
          episode: row.episode,
          watchedAt: row.watchedAt || fallbackAt
        }))
      /** How many episodes a list of viewings covers — a rewatched episode is one. */
      const distinctEpisodes = (rows: readonly ChangedEpisode[]): number =>
        new Set(
          rows.filter((row) => row.episode != null).map((row) => `${row.season}:${row.episode}`)
        ).size
      const settle = (): void => {
        requestRecommendationsRebuild()
        // Every open surface — grids, the detail page, Home — learns of it
        // from this one event rather than each caller remembering to ask.
        notifyLibraryChanged('title-status', 'history', 'planned')
      }
      const result = (): SetTitleStatusResult => ({
        status,
        episodes: distinctEpisodes(changed),
        changed,
        profileId: profile
      })

      if (episodes?.length && status !== 'planned') {
        const now = new Date().toISOString()
        if (status === 'watched') {
          // importWatched: one transaction, original dates, and a row that
          // is already there is left alone rather than re-stamped.
          db.importWatched(importRows(episodes, now))
          changed.push(...episodes)
          pushTitleHistory(historyItem(), episodes, 'add')
        } else {
          // One transaction, like the mark it undoes — and only the
          // viewings that mark recorded: an episode watched again since
          // stays watched (see unmarkEpisodes), and the services hear of
          // the episodes that are gone, not of one still standing.
          const gone = db.unmarkEpisodes(historyId, episodes)
          changed.push(...gone)
          if (gone.length) pushTitleHistory(historyItem(), gone, 'remove')
        }
        settle()
        return result()
      }

      // The episode list only when it is needed: a film has none, and
      // clearing a show reads what history holds rather than what aired.
      let aired: EpisodeRef[] = []
      let seasonTotals: Map<number, number> | undefined
      if (episodic && status === 'watched') {
        let detail: CatalogItem
        try {
          detail = await metadata(type, historyId, 'interactive')
        } catch (error) {
          logError('tracking:set-title-status:meta', error)
          throw new Error(
            "Could not load this title's episode list. Check the connection and try again."
          )
        }
        if (db.activeProfile() !== profile) {
          throw new Error(
            'The profile changed while this title was loading, so nothing was changed.'
          )
        }
        aired = airedRegularEpisodes(detail.videos, Date.now()).filter(inPart)
        if (!pushItem.year && detail.year) pushItem.year = detail.year
        // MAL's status is decided against a total — see
        // malStatusForProgress — and a card rarely carries one. Per season
        // as well as for the show: a grouped anime is an entry per season
        // there, each judged complete against its own.
        const known = airedRegularEpisodes(detail.videos, Infinity)
        seasonTotals = episodesPerSeason(known)
        if (pushItem.totalEpisodes == null) {
          pushItem.totalEpisodes = detail.episodeCounts?.totalEpisodes ?? known.length
        }
        if (!aired.length) {
          throw new Error(
            'No aired episodes are known for this title yet, so it cannot be marked watched.'
          )
        }
      }

      // Read after the wait, not before it: the change is decided against
      // what is watched now, which is also what its undo has to reverse.
      const own = db.watchedEpisodesOf(historyId).filter(inPart)
      const state = {
        planned: db.isTracked(id),
        movieWatched: own.length > 0,
        watchedKeys: new Set(
          own
            .filter((entry) => entry.episode != null)
            .map((entry) => episodeKey(entry.season, entry.episode as number))
        )
      }

      const steps = planTitleStatusChange(status, state, { episodic, aired })
      for (const step of steps) {
        switch (step.kind) {
          case 'track':
            db.track(pushItem)
            // Enqueued behind whatever this title's history chain still
            // owes — the un-plan a mark queued moments ago must land before
            // a re-plan (an undo) is even asked for, or it would undo the
            // undo at Trakt and clear the origin the re-plan just wrote.
            queueRemotePushes(pushItem, () => [applyLocalPlanChange(plan, true)])
            break
          case 'untrack':
            db.untrack(id)
            // Behind the history push on the same chain — see the header.
            queueRemotePushes(pushItem, () => [unplanBecauseWatched(plan)])
            break
          case 'mark-movie': {
            // Through importWatched rather than markWatched, for the one
            // thing the undo needs and markWatched does not report: the
            // instant of the viewing it recorded (see unmarkEpisodes).
            const now = new Date().toISOString()
            const row = { season: null, episode: null, watchedAt: now }
            db.importWatched(importRows([row], now))
            changed.push(row)
            pushTitleHistory(pushItem, changed, 'add')
            break
          }
          case 'unmark-movie': {
            changed.push(...own)
            db.unmarkWatched(id)
            pushTitleHistory(pushItem, changed, 'remove')
            break
          }
          case 'mark-episodes': {
            const now = new Date().toISOString()
            const rows = step.episodes.map((ref) => ({ ...ref, watchedAt: now }))
            // One transaction for the lot: a long show is hundreds of rows,
            // and one fsync per row held the main process for seconds.
            db.importWatched(importRows(rows, now))
            changed.push(...rows)
            pushTitleHistory(historyItem(), rows, 'add', { seasonTotals })
            break
          }
          case 'unmark-title': {
            let removed: ChangedEpisode[]
            if (part) {
              // Only this season of the show: every viewing of it read
              // above goes, and is what an undo puts back.
              const refs = new Map(
                own.map((row) => [
                  `${row.season}:${row.episode}`,
                  { season: row.season, episode: row.episode }
                ])
              )
              db.unmarkEpisodes(historyId, [...refs.values()])
              removed = own
            } else {
              removed = db.unmarkTitle(id)
            }
            changed.push(...removed)
            // A planned anime cleared to not watched is, on MAL, plan to
            // watch at zero — said explicitly, never inferred from the count.
            pushTitleHistory(historyItem(), removed, 'remove', {
              malStatus: state.planned ? 'plan_to_watch' : undefined
            })
            break
          }
        }
      }
      if (steps.length) settle()
      return result()
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
    (_e, { id, playback }) => {
      // Kept where the viewing is kept — see underShow.
      const kept = underShow({ id }, playback || {})
      return getDatabase().getPlaybackPosition(kept.item.id, kept.playback)
    }
  )

  handle<SavePositionPayload, { ok: true }>(
    MEDIA_HUB_CHANNELS.trackingSavePosition,
    (_e, { id, playback, positionSeconds, durationSeconds, volume }) => {
      const kept = underShow({ id }, playback || {})
      getDatabase().savePlaybackPosition(
        kept.item.id,
        kept.playback,
        positionSeconds,
        durationSeconds,
        volume
      )
      return { ok: true }
    }
  )

  // Every bookmark for one title in a single call — see
  // EpisodePlaybackPosition's own doc comment for why the episode grid
  // can't reasonably use trackingGetPosition once per row.
  handle<ListPositionsPayload, EpisodePlaybackPosition[]>(
    MEDIA_HUB_CHANNELS.trackingListPositions,
    (_e, { id }) => getDatabase().listPlaybackPositions(id)
  )

  // Renderer-triggered (a few seconds after startup, and rate-limited by
  // the cooldown regardless of how often it's called — see this file's
  // own header comment on why) rather than main-process-scheduled: the
  // renderer already owns exactly when "the app has settled in and this
  // won't compete with anything the person is actively doing" is true.
  /** The films half of the check — the review panel's original rows. */
  const checkFilms = async (): Promise<ReconcileCheckResult> => {
    if (!simklCredentials().accessToken) return { ran: false, discrepancies: [] }
    const db = getDatabase()
    // Ahead of the cooldown below, which throttles the diff, not this.
    // A decision left over from a previous session — the app closed
    // before its batch went out, the push failed, this machine was
    // offline — has to get out promptly, and this is the only thing that
    // runs on a launch where nobody touches the review panel. What
    // stops a few restarts from spending an entry's whole attempt
    // budget is the flush's own retry pacing, which applies to entries
    // that have already failed and never to one nobody has tried.
    const justPushed = await flushPendingPushes()
    // The catch-up first (simklCatchUp.ts): what Simkl holds that this
    // library does not is taken in without asking, add-only, so the panel
    // is left with what remains — Simkl saying a film here is not watched,
    // and anything the catch-up could not place. Shares the pass the launch
    // asked for if it is still running, and answers from the last one within
    // two minutes; nothing runs while something plays.
    // The desktop's, so the Trakt and MyAnimeList lists stay the job's.
    await catchUpFromServices({ leaveListsToJob: true }).catch((error) =>
      logError('tracking:reconcile:catch-up', error)
    )
    if (db.getCache(reconcileKey(RECONCILE_COOLDOWN_KEY_PREFIX))) {
      // Inside the cooldown, but that no longer means "nothing to say" —
      // the background watch-sync job may have run the diff moments ago.
      // Reported as ran: false, which is the truth (this call did not run
      // one) and is all the renderer has ever keyed off; what it acts on
      // is whether there are discrepancies.
      const cached = cachedReconcileResult()
      return { ran: false, discrepancies: cached.filter((d) => !justPushed.has(d.id)) }
    }
    const account = simklAccountMark()
    const profile = db.activeProfile()
    // Simkl's one small question before its films library, the same gate
    // the half-hourly pass reads (watchSync.ts). Unanswered, the films are
    // not read: fetching them without it is what Simkl suspends clients for.
    // The catch-up just above has usually read it moments ago; a minute-old
    // answer is the same answer.
    let movies: string | null
    try {
      const payload =
        recentSimklActivities(account, 60 * 1000) ?? (await simklActivities('visible'))
      movies = parseSimklActivities(payload).movies
    } catch (error) {
      logError('tracking:reconcile:activities', error)
      return { ran: false, discrepancies: cachedReconcileResult() }
    }
    // Read before the diff, like the stamp: a film marked while it runs
    // is then seen by the next check.
    const local = localFilmsSignature(db.history())
    if (filmDiffCurrent(db, profile, account, movies, local)) {
      // Neither side's films moved since the last diff: that diff stands.
      const stored = storedReconcileResult()
      if (stored) {
        return { ran: false, discrepancies: stored.filter((d) => !justPushed.has(d.id)) }
      }
    }
    db.putCache(reconcileKey(RECONCILE_COOLDOWN_KEY_PREFIX), true, RECONCILE_COOLDOWN_MS)
    try {
      const { discrepancies, fetched } = await computeMovieDiscrepancies()
      writeReconcileResult(account, profile, discrepancies)
      // Recorded only against films fetched from Simkl just now, and only
      // for the profile and account it was asked for — as the half-hourly
      // pass records its own.
      if (fetched && db.activeProfile() === profile && simklAccountMark() === account) {
        recordFilmDiff(db, profile, account, movies, local, Date.now())
      }
      // Anything confirmed moments ago is settled, whatever Simkl's
      // all-items view says — that read can lag its own write, and
      // re-asking about a title someone just resolved is the exact
      // nagging this whole path exists to stop.
      return { ran: true, discrepancies: discrepancies.filter((d) => !justPushed.has(d.id)) }
    } catch (error) {
      logError('tracking:reconcile', error)
      return { ran: true, discrepancies: [] }
    }
  }

  handle<undefined, ReconcileCheckResult>(MEDIA_HUB_CHANNELS.trackingReconcileCheck, async () => {
    // Before anything can return: this is the proof that the interface in
    // front of this backend has a review panel at all — see reviewAsked.
    reviewAsked = true
    const films = await checkFilms()
    // The shows section as it stands, and the comparison after the
    // catch-up the films check has just run (or the launch's own, without
    // Simkl) behind it. Not awaited: a first comparison can read two whole
    // Simkl lists and look up anime ids for minutes, and the films must not
    // wait for it. What it adds reaches the panel on
    // trackingEpisodeReviewChanged.
    void compareEpisodesAfterPull()
    return { ...films, shows: showSyncRows() }
  })

  /** The shows section, read again — the panel asks when it opens, since a
   *  pass may have added rows since launch. */
  handle<undefined, { shows: ShowSyncRow[] }>(MEDIA_HUB_CHANNELS.trackingEpisodeReview, () => {
    reviewAsked = true
    return { shows: showSyncRows() }
  })

  /**
   * One choice on one show row — see episodeSync.ts's decideShow. The
   * changes owed to the services are written down before anything here is
   * removed, and sent a few seconds after the last choice with the history
   * pushes still owed; a push that fails is retried there and leaves the
   * choice standing.
   */
  handle<ShowSyncDecision, ShowSyncDecisionResult>(
    MEDIA_HUB_CHANNELS.trackingEpisodeDecide,
    (_e, payload) => {
      const db = getDatabase()
      const profile = db.activeProfile()
      const service =
        payload?.service === 'simkl' || payload?.service === 'trakt' ? payload.service : undefined
      const action = payload?.action
      if (
        action !== 'keep' &&
        action !== 'undo' &&
        action !== 'service-match-here' &&
        action !== 'here-match-service'
      ) {
        return {
          ok: false,
          queued: false,
          removedHere: 0,
          cannotSend: [],
          error: 'Unknown choice.'
        }
      }
      const marks = trackingAccountMarks()
      const outcome = decideShow(
        {
          db,
          marks: () => marks,
          canSend: canSendEpisode,
          readPending: () => readHistoryPending(db, profile, marks),
          writePending: (pending) => writeHistoryPending(db, profile, pending),
          backup: () => backupBeforeRewrite('episode-sync', { notWithinMs: 24 * 60 * 60 * 1000 }),
          now: () => Date.now()
        },
        String(payload?.id ?? ''),
        action,
        service
      )
      if (outcome.queued) scheduleEpisodeFlush()
      if (outcome.removedHere) {
        requestRecommendationsRebuild()
        notifyLibraryChanged('episode-sync', 'history')
      }
      return outcome
    }
  )

  handle<
    { discrepancy: WatchStatusDiscrepancy; resolution: ReconcileResolution },
    ReconcileResolveResult
  >(MEDIA_HUB_CHANNELS.trackingReconcileResolve, async (_e, { discrepancy, resolution }) => {
    if (resolution === 'ignore') {
      addIgnoredReconcileId(discrepancy.id)
      return { ok: true, queued: false }
    }
    const item: SimklPushItem = {
      id: discrepancy.id,
      type: discrepancy.type,
      title: discrepancy.title,
      year: discrepancy.year
    }
    const db = getDatabase()
    if (resolution === 'use-local') {
      // Local's answer is the one to keep — so it has to reach every
      // connected service, not just leave the row. This used to fire one
      // Simkl POST here and return { ok: true } no matter what came back,
      // which is how a title could disappear from the review list and be
      // asked about again on the very next launch: the push had failed
      // (or was accepted-but-unmatched) and nothing recorded either the
      // decision or the failure. Instead, the decision is written down
      // first and pushed on the queue's own schedule — which also lets a
      // burst of "keep local" clicks go out as ONE batched request per
      // service (see PENDING_FLUSH_DELAY_MS), with the outcome reported
      // over trackingReconcileSync rather than swallowed.
      // Nothing to deliver this to. Written down anyway it would be
      // stamped with an empty account, sit through a flush that exits
      // silently for want of a token, and be dropped the moment anyone
      // authorized — a choice gone with nobody told, which is the whole
      // failure this queue was built to stop. Refusing it puts the row
      // back with a message instead.
      if (!simklCredentials().accessToken) return { ok: true, queued: false }
      // An id the push could only ever express as a title/year guess is
      // refused on the same terms as a missing token: queueing it promises
      // an outcome this app cannot deliver or verify (see
      // WatchStatusDiscrepancy.pushable — the panel does not offer "Use
      // Local" for these; this is the backstop for a stale cached row).
      if (!hasExpressibleSimklId(String(discrepancy.id))) return { ok: true, queued: false }
      const recorded = writePendingPushes(
        queuePendingPush(pendingPushes(), {
          id: discrepancy.id,
          type: discrepancy.type,
          title: discrepancy.title,
          year: discrepancy.year,
          remoteWatched: discrepancy.remoteWatched,
          attempts: 0
        })
      )
      // Nothing was written — the panel must not act as though the
      // choice was kept, since the flush would read an empty queue and
      // the title would come back with nobody having been told why.
      if (!recorded) return { ok: true, queued: false }
      scheduleFlush()
      return { ok: true, queued: true }
    }
    // Simkl's answer is the one to keep — update the local record to match.
    if (discrepancy.remoteWatched) db.markWatched(item)
    else db.unmarkWatched(item.id)
    // And Trakt, which otherwise keeps whatever it had: the decision goes
    // into the same queue "Use Local" uses, where the flush finds local and
    // Simkl already agreeing (settled — nothing is sent to Simkl) and passes
    // the value on to Trakt. A Trakt failure is logged there and does not
    // undo anything here. Only with a Simkl account and an id the queue can
    // hold, on the same terms as "Use Local" above.
    if (
      traktCredentials().accessToken &&
      simklCredentials().accessToken &&
      hasExpressibleSimklId(String(discrepancy.id)) &&
      writePendingPushes(
        queuePendingPush(pendingPushes(), {
          id: discrepancy.id,
          type: discrepancy.type,
          title: discrepancy.title,
          year: discrepancy.year,
          remoteWatched: discrepancy.remoteWatched,
          attempts: 0
        })
      )
    ) {
      scheduleFlush()
    }
    // A write main made on the strength of a remote answer: the panel that
    // asked refreshes the home feed itself, but the detail page and the
    // grids learn of it the same way they learn of every other such write.
    notifyLibraryChanged('reconcile', 'history')
    return { ok: true, queued: false }
  })

  handle<undefined, DislikedListResult>(MEDIA_HUB_CHANNELS.dislikedList, async () => {
    return { disliked: getDatabase().disliked() }
  })

  handle<undefined, { plays: PlayRecord[] }>(MEDIA_HUB_CHANNELS.playsList, () => ({
    plays: getDatabase().plays()
  }))

  handle<undefined, ViewingStats>(MEDIA_HUB_CHANNELS.statsGet, () => getDatabase().viewingStats())

  // Lists. Every mutation answers with the whole (short) collection rather
  // than an ok/not-ok, so the renderer never has to guess what the counts are
  // now — a list's size changes on every add and remove.
  handle<undefined, { lists: CustomList[] }>(MEDIA_HUB_CHANNELS.listsList, () => ({
    lists: getDatabase().lists()
  }))

  handle<{ name: string }, { lists: CustomList[]; created: CustomList }>(
    MEDIA_HUB_CHANNELS.listsCreate,
    (_e, payload) => {
      const db = getDatabase()
      const created = db.createList(String(payload?.name ?? ''))
      return { lists: db.lists(), created }
    }
  )

  handle<{ listId: string; name: string }, { lists: CustomList[] }>(
    MEDIA_HUB_CHANNELS.listsRename,
    (_e, payload) => {
      const db = getDatabase()
      db.renameList(String(payload?.listId ?? ''), String(payload?.name ?? ''))
      return { lists: db.lists() }
    }
  )

  handle<{ listId: string }, { lists: CustomList[] }>(
    MEDIA_HUB_CHANNELS.listsDelete,
    (_e, payload) => {
      const db = getDatabase()
      db.deleteList(String(payload?.listId ?? ''))
      return { lists: db.lists() }
    }
  )

  handle<{ listId: string }, { items: CustomListItem[] }>(
    MEDIA_HUB_CHANNELS.listsItems,
    (_e, payload) => ({ items: getDatabase().listItems(String(payload?.listId ?? '')) })
  )

  handle<{ listId: string; item: TrackableItem }, { lists: CustomList[] }>(
    MEDIA_HUB_CHANNELS.listsAdd,
    (_e, payload) => {
      const db = getDatabase()
      db.addToList(String(payload?.listId ?? ''), payload?.item ?? { id: '' })
      return { lists: db.lists() }
    }
  )

  handle<{ listId: string; contentId: string }, { lists: CustomList[] }>(
    MEDIA_HUB_CHANNELS.listsRemove,
    (_e, payload) => {
      const db = getDatabase()
      db.removeFromList(String(payload?.listId ?? ''), String(payload?.contentId ?? ''))
      return { lists: db.lists() }
    }
  )

  handle<{ contentId: string }, { listIds: string[] }>(
    MEDIA_HUB_CHANNELS.listsContaining,
    (_e, payload) => ({ listIds: getDatabase().listsContaining(String(payload?.contentId ?? '')) })
  )

  handle<{ playId: number }, { plays: PlayRecord[] }>(
    MEDIA_HUB_CHANNELS.playDelete,
    (_e, payload) => {
      const db = getDatabase()
      db.deletePlay(Number(payload?.playId))
      // Deliberately does NOT touch watch_history: removing one viewing of an
      // episode watched three times must not un-watch it. Clearing the badge
      // is what tracking:unmark-watched is for, and it removes every play of
      // that episode along with it.
      return { plays: db.plays() }
    }
  )

  handle<undefined, { ratings: Record<string, number> }>(MEDIA_HUB_CHANNELS.ratingsList, () => ({
    ratings: Object.fromEntries(getDatabase().ratings())
  }))

  // `type` and `title` ride along purely for the Trakt push: Trakt chooses
  // between its movies and shows collections by kind, and neither the ratings
  // table nor the id itself can answer that — an IMDb id is the same shape for
  // both.
  handle<
    { id: string; score: number; type?: MediaKind; title?: string },
    { ratings: Record<string, number> }
  >(MEDIA_HUB_CHANNELS.ratingSet, (_e, payload) => {
    const db = getDatabase()
    db.rate(String(payload?.id ?? ''), Number(payload?.score))
    // Trakt keeps ratings too, and a score given here should not have to be
    // given again there. Sent with whatever the local row knows about the
    // title; a 0 is this app's "cleared" signal and reaches Trakt as a
    // removal rather than as a 1 — see pushTraktRating.
    void pushTraktRating(
      {
        id: String(payload?.id ?? ''),
        type: payload?.type ?? 'movie',
        title: payload?.title ?? ''
      },
      Number(payload?.score)
    )
    // A score changes what the ranking learns from this person's history —
    // both the genres it prefers and the names it has learned to look for.
    // Rebuilding here is what makes rating something feel like it did
    // anything, rather than waiting for the next scheduled pass.
    requestRecommendationsRebuild()
    return { ratings: Object.fromEntries(db.ratings()) }
  })

  handle<TrackableItem, { disliked: boolean }>(MEDIA_HUB_CHANNELS.dislikedAdd, (_e, item) => {
    getDatabase().dislike(item)
    indexTrackedTitle(item)
    requestRecommendationsRebuild()
    return { disliked: true }
  })

  handle<{ id: string }, { disliked: boolean }>(
    MEDIA_HUB_CHANNELS.dislikedRemove,
    (_e, payload) => {
      getDatabase().undislike(payload.id)
      requestRecommendationsRebuild()
      return { disliked: false }
    }
  )

  handle<undefined, HomePersonalizedResult>(MEDIA_HUB_CHANNELS.homePersonalized, async () => {
    const db = getDatabase()
    // Which profile this whole response is about, captured before the first
    // read. The cold branch below awaits three catalogs before it stores
    // anything — see storeRecommendations on why the write cannot resolve
    // this for itself.
    const profile = db.activeProfile()
    // Local only — see trackingList's own comment above for why: a live/
    // cached Simkl merge here means Continue Watching and the
    // recommendation filter can both keep treating a freshly-unmarked
    // title as watched for up to 20 minutes.
    const history: HistoryEntry[] = db.history()
    const tracked = db.tracked()
    // A merged anime's later seasons are never suggested on their own — see
    // LiveExclusions.siblingIds.
    const exclusions = liveExclusions(history, animeSiblingIds())

    // The suggestion row, from the list the background job already ranked
    // — see recommendations.ts. This is the whole point of that module:
    // the branch below has to wait for three catalogs, and a cold anime
    // catalog is a twenty-second Kitsu crawl that Home spent all of
    // waiting for eighteen rows it could have read from disk.
    const stored = readStoredRecommendations(exclusions, history)
    let recommendations: CatalogItem[]
    let recommendationReasons: Record<string, RecommendationReason>
    let recommendationRails: RecommendationRail[]
    let preferredGenres: string[]

    if (stored) {
      recommendations = stored.items
      recommendationReasons = stored.reasons
      recommendationRails = stored.rails
      preferredGenres = stored.preferredGenres
    } else {
      // Nothing stored yet (a fresh install, a bumped STORE_KEY), or too
      // little of it survived the live exclusions to fill the row. Rank
      // live this once, and seed the store from that same work so the
      // next launch takes the branch above.
      const [movies, series, anime] = await Promise.all(
        (['movie', 'series', 'anime'] as const).map((kind) =>
          catalogData(kind, false, 'visible').catch(() => [])
        )
      )
      const all: CatalogItem[] = [...movies, ...series, ...anime]
      if (!all.length) throw new Error('All catalog sources are currently unavailable.')

      preferredGenres = db.preferredGenres(4)
      const dropped = abandonedIds()
      const candidates = all.filter((item) => recommendable(item, exclusions))
      // No credits or taste profile on this branch, deliberately.
      // Assembling them means a cache read per candidate — a couple of
      // thousand of them — and this is the launch path the stored list
      // exists to keep clear. It only runs on a fresh install or a bumped
      // store key, where there are no credits to read anyway, and the
      // background rebuild replaces this list with a fully-ranked one
      // within minutes. See recommendations.ts.
      const ranked = rankPersonalizedRecommendationsScored(candidates, {
        history,
        preferredGenres,
        abandonedIds: dropped
      })
      // An empty candidate set means everything in the catalog is already
      // watched, saved or hidden — rank the unfiltered catalog rather than
      // showing nothing, exactly as this handler always has.
      const full = ranked.length
        ? ranked
        : rankPersonalizedRecommendationsScored(all, {
            history,
            preferredGenres,
            abandonedIds: dropped
          })
      // announce: false — this handler returns the same list to the same
      // renderer on the next line. See storeRecommendations.
      // The profile this request is ABOUT. The cold path awaits catalog reads
      // before reaching here, so the write must not resolve the profile for
      // itself — see storeRecommendations.
      storeRecommendations(full, preferredGenres, { announce: false, profile })
      // Through the same cadence pass the stored path uses, so the row is
      // ordered the same way whichever branch produced it.
      recommendations = applyCadence(full, watchCadenceProfile(history), SERVED_COUNT)
      // Thinner than the stored path's, and knowingly so. This branch ranks
      // without credits or a taste profile (see the comment above), so the
      // only reasons it can produce are the ones the catalog alone
      // supports — a franchise continuation, a genre, a release year. The
      // background rebuild fills in the rest within minutes.
      recommendationReasons = reasonsFor(recommendations, full)
      recommendationRails = groupRecommendationRails(full)
    }

    // The id a tracked title's viewings are kept under. A merged anime's
    // later season is planned under its own Kitsu id and watched under the
    // show it belongs to — but only once the catalog has been grouped;
    // before then every id resolves to itself anyway (see
    // animeGroupingReady), so asking would only build an empty index.
    const groupingReady = animeGroupingReady()
    const historyIdOf = (item: TrackedItem): string => {
      const id = String(item.id)
      return groupingReady && id.startsWith('kitsu:') ? resolveAnimeGroupTarget(id).id : id
    }
    const startedIds = new Set(history.map((entry) => String(entry.id)))

    // Metadata only for the shows somebody has started — see
    // homeDetailWants. Nothing in either UI reads `updates` for a title
    // nobody has started, and resolving every planned series — six at a
    // time, each a 24-hour cache entry — is what kept Home waiting tens of
    // seconds on a long list. See tracking:list above for the bound and the
    // shared coalescing.
    const { wanted, seasonCount, onBehalfOf } = homeDetailWants({
      tracked,
      history,
      historyIdOf,
      seasonOf: (item) => resolveAnimeGroupTarget(String(item.id)).season
    })
    const fetched = await mapWithLimit(wanted, (x) => metadata(x.type, x.id, 'visible'))
    const details = fetched.filter((x): x is CatalogItem => Boolean(x))
    // Index-aligned with `wanted` until the filter above, which is what the
    // counts are read off — see homeWatchedCounts.
    const watchedRegularCount = homeWatchedCounts({ wanted, fetched, seasonCount, history })
    // A title a watchlist pull added arrives as a name and a year; the
    // catalog index usually has the artwork.
    const posters = new Map<string, string>()
    const bare = tracked.filter((item) => !item.poster).map((item) => String(item.id))
    if (bare.length) {
      for (const item of db.indexByIds(bare).items) {
        if (item.poster) posters.set(String(item.id), item.poster)
      }
    }

    return {
      tracked,
      updates: db.trackedUpdates(details),
      continueWatching: continueWatchingList(details, history)
        .slice(0, 18)
        // A show that is here only because a later season of it is on the
        // list says which season that is — see ContinueWatchingEntry.trackedId.
        .map((row) => {
          const trackedId = onBehalfOf.get(String(row.id))
          return trackedId ? { ...row, trackedId } : row
        }),
      planned: plannedList({ tracked, startedIds, historyIdOf, watchedRegularCount, posters }),
      recommendations,
      recommendationReasons,
      recommendationRails,
      preferredGenres,
      // Read here rather than fetched: it is whatever the last pull
      // recorded, so tagging a card costs nothing on this path.
      plannedSources: plannedSources(),
      // See HomePersonalizedResult.completedIds — the index's own
      // completion query, for the rows served here that carry no episodes.
      // Over everything served — the row AND the shelves, which reach past
      // the row into the whole buffer — so a finished show reads the same
      // wherever it appears.
      completedIds: db.indexByIds([
        ...new Set([
          ...recommendations.map((item) => String(item.id)),
          ...recommendationRails.flatMap((rail) => rail.items.map((item) => String(item.id)))
        ])
      ]).completedIds
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
      // A fresh authorization can be a different account than the one
      // whose decisions are sitting in the queue and whose watched
      // history is sitting in the cache, and nothing here can tell the
      // two apart — a bearer token is all this app ever holds. See
      // clearPendingPushes and forgetSimklWatchedCache. Re-authorizing
      // the SAME account pays the same price (its queue is dropped and
      // those titles come back on the next check; the history costs one
      // refetch), which is the acceptable half of that trade.
      clearPendingPushes()
      forgetSimklWatchedCache()
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
    clearPendingPushes()
    // And whoever connects next must not be diffed against the library of
    // the account that just left — see forgetSimklWatchedCache.
    forgetSimklWatchedCache()
    return { ok: true }
  })

  handle<ScrobblePayload, { connected: boolean }>(
    MEDIA_HUB_CHANNELS.simklScrobble,
    async (_e, payload) => {
      const action = payload?.action
      // Read once, independent of whether Simkl is connected — Trakt below
      // must not be gated behind it. `connected` in the return value still
      // means "Simkl", the channel's own name and the only thing any
      // existing caller reads it for.
      const simklConnected = Boolean(simklCredentials().accessToken)
      if (action !== 'start' && action !== 'pause' && action !== 'stop') {
        return { connected: simklConnected }
      }
      // Off unless asked for — see scrobblingEnabled. Nothing goes to either
      // service; the history add at 80% is what records the viewing.
      if (!scrobblingEnabled(readSettings())) return { connected: simklConnected }
      const progress = Math.min(100, Math.max(0, Number(payload?.progress) || 0))
      // Both services hear the same transitions, independently of each
      // other. This used to sit behind the Simkl-connected check above, so a
      // Trakt-only account (Simkl never connected) never received a single
      // scrobble despite the setting promising otherwise — Trakt's own
      // scrobble endpoints are the same start/pause/stop state machine and
      // owe Simkl's connection state nothing.
      //
      // On the title's own push chain (see queueRemotePushes): a stop at
      // high progress IS a watched write on both services, and it fires
      // from the player at the same moment the auto mark-watched does — so
      // it must take its turn behind, and ahead of, that title's marks like
      // any other. That also puts start, pause and stop in the order they
      // happened, which parallel requests never guaranteed. Awaited, as the
      // Simkl request always was, so the error below still reaches the
      // main window.
      let simklError: string | undefined
      // The same show, and so the same chain, as the mark that follows a
      // stop — see underShow.
      const { item: subject, playback: at } = underShow(payload.item, payload.playback || {})
      await titlePushQueue.run(titlePushKey(subject), async () => {
        const trakt = pushTraktScrobble(subject, at, action, progress)
        // Null for a title Simkl has no id for — the same refusal to guess
        // by title/year that syncSimklHistory makes above — and for an anime
        // episode with no entry of its own there (see scrobblePayload).
        const scrobble = scrobblePayload(subject, at, progress, animeSiblingsWhenGrouped())
        if (simklConnected && scrobble) {
          try {
            await simklRequest(`/scrobble/${action}`, {
              method: 'POST',
              body: JSON.stringify(scrobble)
            })
          } catch (error) {
            // Never thrown. A scrobble is a courtesy to a third-party
            // service: it must not interrupt playback, and an account whose
            // token expired mid-film should not produce an error over the
            // video every time somebody pauses. The local history is the
            // record either way. The reason IS reported back, though — the
            // main window says it once per session, so a token that expired
            // or an id Simkl will not take is something a person hears
            // about rather than a line nobody reads.
            logError('simkl:scrobble', error)
            simklError = (error as Error)?.message || String(error)
          }
        }
        await trakt
      })
      if (!simklConnected) return { connected: false }
      return simklError ? { connected: true, error: simklError } : { connected: true }
    }
  )
}
