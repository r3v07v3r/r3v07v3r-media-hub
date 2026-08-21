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
  PendingWatchStatusPush,
  ReconcileCheckResult,
  ReconcileResolution,
  ReconcileResolveResult,
  ReconcileSyncReport,
  SimklPinStart,
  SimklPollResult,
  SimklStatus,
  TrackedItemEnriched,
  TrackingListResult,
  WatchStatusDiscrepancy
} from '../../shared/media-hub/types'
import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import { applyPushOutcome, queuePendingPush } from '../../shared/media-hub/reconcileQueue'
import { airingStatus, continueWatchingList } from './core'
import { catalogData, metadata } from './catalog'
import { getDatabase } from './dbState'
import { fetchJson } from './httpClient'
import { handle } from './ipcGuard'
import { logError } from './logger'
import { pushMalProgress } from './malSync'
import { encrypt, readSettings, simklCredentials, writeSettings } from './settingsStore'
import { sendToRenderer } from './rendererBridge'
import {
  batchHistoryPayload,
  historyPayload,
  scrobblePayload,
  seasonHistoryPayload,
  unmatchedCatalogIds,
  type PlaybackPosition,
  type SimklHistoryResponse,
  type SimklPushItem
} from './simkl'
import {
  invalidateSimklWatchedCache,
  simklRequest,
  simklUrl,
  simklWatchedHistory
} from './simklClient'

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

/** Decisions someone has already made ("keep local") that haven't been
 *  confirmed on every connected service yet. Persisted for the same
 *  reason as the ignored list above and with the same TTL: it's a record
 *  of what a person decided, not a rate limit, and a decision has to
 *  outlive a failed push or the app being closed — otherwise the exact
 *  titles they already ruled on come back on the next launch, which is
 *  the bug this queue exists to end. */
const RECONCILE_PENDING_KEY = 'reconcile:pending:v1'
const RECONCILE_PENDING_TTL_MS = 90 * 24 * 60 * 60 * 1000

/** How long a "keep local" click waits for the clicks after it before the
 *  queue is flushed. Working through a review list is a burst of clicks a
 *  second or two apart, so this collapses the whole list into ONE request
 *  per service instead of one per row, without ever asking the person to
 *  press a separate "apply" button — the batch closes itself. Nothing is
 *  lost if the app quits mid-window: the queue is on disk, and the next
 *  reconcile check flushes it. */
const PENDING_FLUSH_DELAY_MS = 3000

let flushTimer: NodeJS.Timeout | null = null
let flushInFlight: Promise<Set<string>> | null = null
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

function pendingPushes(): PendingWatchStatusPush[] {
  return getDatabase().getCache<PendingWatchStatusPush[]>(RECONCILE_PENDING_KEY) || []
}

function writePendingPushes(queue: PendingWatchStatusPush[]): void {
  getDatabase().putCache(RECONCILE_PENDING_KEY, queue, RECONCILE_PENDING_TTL_MS)
}

/**
 * Drops every queued decision, and any batch timer waiting to send them.
 * Called whenever the connected Simkl account changes — signing out, or
 * authorizing a different one — because these entries are decisions
 * about ONE account's history and this queue has no way to tell two
 * accounts apart (nothing here persists a Simkl user identity). Left in
 * place, a decision queued by account A would be delivered with account
 * B's token on the next flush, editing the watch history of whoever
 * happened to sign in next.
 *
 * Dropping rather than trying to keep them is the safe direction: the
 * cost is that a title someone already ruled on gets asked about once
 * more, since the next check recomputes the disagreement from scratch.
 * Writing to the wrong person's account has no equivalent undo.
 */
function clearPendingPushes(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  flushAgain = false
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
async function pushPendingToServices(): Promise<Set<string>> {
  const queue = pendingPushes()
  if (!queue.length) return new Set()
  // Not connected — keep everything queued rather than failing attempts
  // against a service that was never asked. Being signed out isn't a push
  // that went wrong, and shouldn't burn this entry's attempt budget.
  if (!simklCredentials().accessToken) return new Set()

  const confirmed = new Set<string>()
  const failed = new Set<string>()
  // Disagreements that resolved themselves locally while the decision sat
  // in the queue — nothing to send, but the entry is still done with.
  const settled = new Set<string>()
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
  // two sides now agree on their own. Pushing anyway would be a no-op at
  // best and — for a removal Simkl has nothing to remove — an unmatched
  // response that retries until the attempt cap.
  const sendable = queue.filter((entry) => {
    if (locallyWatched.has(entry.id) !== entry.remoteWatched) return true
    settled.add(entry.id)
    return false
  })

  for (const [watched, pathname] of [
    [true, '/sync/history'],
    [false, '/sync/history/remove']
  ] as const) {
    const group = sendable.filter((entry) => locallyWatched.has(entry.id) === watched)
    if (!group.length) continue
    const items = group.map(pushItemFor)
    try {
      const response = await simklRequest<SimklHistoryResponse>(pathname, {
        method: 'POST',
        body: JSON.stringify(batchHistoryPayload(items.map((item) => ({ item }))))
      })
      const unmatched = new Set(unmatchedCatalogIds(response, items))
      for (const entry of group) (unmatched.has(entry.id) ? failed : confirmed).add(entry.id)
      if (unmatched.size) error = 'Simkl did not find a match.'
    } catch (caught) {
      logError(`reconcile:push:${pathname}`, caught)
      error = (caught as Error).message
      for (const entry of group) failed.add(entry.id)
    }
  }

  for (const entry of queue) {
    if (!confirmed.has(entry.id)) continue
    const result = await pushMalProgress({ id: entry.id, type: entry.type })
    if (!result.malError) continue
    error = result.malError
    confirmed.delete(entry.id)
    failed.add(entry.id)
  }

  // The pushes above bypass simklWatchedHistory()'s own request path, so
  // its 20-minute cache never learns about them; left alone, the next
  // check compares against the stale pre-push snapshot and re-reports
  // exactly what was just resolved. On failure, leave it: it's still an
  // accurate reflection of Simkl.
  if (confirmed.size) invalidateSimklWatchedCache()

  // Re-read rather than reusing `queue` — anything queued while the
  // requests above were in flight belongs to the next flush, not this
  // one's verdict.
  const { queue: remaining, abandoned } = applyPushOutcome(
    pendingPushes(),
    [...confirmed, ...settled],
    failed
  )
  writePendingPushes(remaining)

  const titleFor = (id: string): string => queue.find((x) => x.id === id)?.title || id
  const report: ReconcileSyncReport = {
    pushed: [...confirmed].map(titleFor),
    retrying: remaining.filter((entry) => failed.has(entry.id)).map((entry) => entry.title),
    abandoned: abandoned.map((entry) => entry.title),
    ...(error ? { error } : {})
  }
  if (report.pushed.length || report.retrying.length || report.abandoned.length) {
    sendToRenderer(MEDIA_HUB_CHANNELS.trackingReconcileSync, report)
  }
  return confirmed
}

/** Single-flight wrapper — the debounce timer and a reconcile check can
 *  both ask for a flush, and two overlapping ones would push the same
 *  queue twice and race on writing it back. */
function flushPendingPushes(): Promise<Set<string>> {
  if (flushInFlight) return flushInFlight
  const run = pushPendingToServices()
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

/** The actual diff. Local and remote are each reduced to "which movie ids
 *  does this side consider watched," and only ids where the two sides
 *  disagree are returned — an id watched (or not) on both sides is
 *  already in agreement and never surfaced. */
async function computeMovieDiscrepancies(): Promise<WatchStatusDiscrepancy[]> {
  const ignored = ignoredReconcileIds()
  // Titles whose ruling is already made and merely waiting on (or
  // retrying) its push. Surfacing one of these would be asking the same
  // question a second time about something nobody changed their mind on.
  const decided = new Set(pendingPushes().map((entry) => entry.id))
  const localMovies = new Map(
    getDatabase()
      .history()
      .filter((h) => h.type === 'movie')
      .map((h) => [h.id, h] as const)
  )
  const remoteMovies = new Map(
    (await simklWatchedHistory()).filter((h) => h.type === 'movie').map((h) => [h.id, h] as const)
  )
  const ids = new Set([...localMovies.keys(), ...remoteMovies.keys()])
  const out: WatchStatusDiscrepancy[] = []
  for (const id of ids) {
    if (ignored.has(id) || decided.has(id)) continue
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
  // Simkl's all-items response can contain only an IMDb id for a movie, so
  // remote-only rows otherwise wind up displaying that id with no artwork.
  // Resolve the same cached metadata used by the detail page before handing
  // the review list to the renderer. Keep the history values as fallbacks so
  // a single unavailable metadata request never hides a discrepancy.
  return Promise.all(
    out.map(async (discrepancy) => {
      try {
        const detail = await metadata('movie', discrepancy.id)
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
  )
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
    // Ahead of the cooldown, and ahead of any diffing: a decision left
    // over from a previous session (the app was closed before its batch
    // went out, or the push failed, or this machine was offline) gets
    // another attempt now, while the queue's own attempt cap keeps a
    // permanently-failing entry from being retried forever.
    const justPushed = await flushPendingPushes()
    if (db.getCache(RECONCILE_COOLDOWN_KEY)) return { ran: false, discrepancies: [] }
    db.putCache(RECONCILE_COOLDOWN_KEY, true, RECONCILE_COOLDOWN_MS)
    try {
      const discrepancies = await computeMovieDiscrepancies()
      // Anything confirmed moments ago is settled, whatever Simkl's
      // all-items view says — that read can lag its own write, and
      // re-asking about a title someone just resolved is the exact
      // nagging this whole path exists to stop.
      return { ran: true, discrepancies: discrepancies.filter((d) => !justPushed.has(d.id)) }
    } catch (error) {
      logError('tracking:reconcile', error)
      return { ran: true, discrepancies: [] }
    }
  })

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
      scheduleFlush()
      return { ok: true, queued: true }
    }
    // Simkl's answer is the one to keep — update the local record to match.
    if (discrepancy.remoteWatched) db.markWatched(item)
    else db.unmarkWatched(item.id)
    return { ok: true, queued: false }
  })

  handle<undefined, DislikedListResult>(MEDIA_HUB_CHANNELS.dislikedList, async () => {
    return { disliked: getDatabase().disliked() }
  })

  handle<TrackableItem, { disliked: boolean }>(MEDIA_HUB_CHANNELS.dislikedAdd, (_e, item) => {
    getDatabase().dislike(item)
    return { disliked: true }
  })

  handle<{ id: string }, { disliked: boolean }>(
    MEDIA_HUB_CHANNELS.dislikedRemove,
    (_e, payload) => {
      getDatabase().undislike(payload.id)
      return { disliked: false }
    }
  )

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
      // A fresh authorization can be a different account than the one
      // whose decisions are sitting in the queue, and nothing here can
      // tell the two apart — see clearPendingPushes. Re-authorizing the
      // SAME account pays the same price (its queue is dropped and those
      // titles come back on the next check), which is the acceptable
      // half of that trade.
      clearPendingPushes()
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
