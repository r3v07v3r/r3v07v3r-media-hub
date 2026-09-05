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
  RecommendationReason,
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
import {
  applyPushOutcome,
  queuePendingPush,
  withPushedRemoteState
} from '../../shared/media-hub/reconcileQueue'
import {
  applyCadence,
  rankPersonalizedRecommendationsScored,
  watchCadenceProfile
} from '../../shared/media-hub/catalog-logic'
import {
  abandonedIds,
  liveExclusions,
  readStoredRecommendations,
  reasonsFor,
  requestRecommendationsRebuild,
  storeRecommendations,
  SERVED_COUNT
} from './recommendations'
import { airingStatus, continueWatchingList } from './core'
import { catalogData, metadata } from './catalog'
import { getDatabase } from './dbState'
import {
  lastPlannedSyncReport,
  pushLocalPlanChange,
  plannedSources,
  syncPlannedFromServices,
  type PlannedSyncReport
} from './watchlists'
import { fetchJson } from './httpClient'
import { mapWithLimit, type TaskPriority } from './taskScheduler'
import { handle } from './ipcGuard'
import { logError } from './logger'
import { pushMalProgress } from './malSync'
import {
  pushTraktHistory,
  pushTraktRating,
  pushTraktScrobble,
  pushTraktSeasonHistory
} from './traktClient'
import {
  encrypt,
  readSettings,
  simklAccountMark,
  simklCredentials,
  writeSettings
} from './settingsStore'
import { sendToRenderer } from './rendererBridge'
import { cachedRemoteLists, fetchRemoteLists } from './remoteLists'
import type { RemoteList } from '../../shared/media-hub/types'
import { assertLibraryWritableId } from '../../shared/media-hub/serviceIds'
import {
  batchHistoryPayload,
  hasExpressibleSimklId,
  historyPayload,
  scrobblePayload,
  seasonHistoryPayload,
  unmatchedCatalogIds,
  type PlaybackPosition,
  type SimklHistoryResponse,
  type SimklPushItem
} from './simkl'
import {
  forgetSimklWatchedCache,
  invalidateSimklWatchedCache,
  simklRequest,
  simklUrl,
  simklWatchedSnapshot
} from './simklClient'

/** Result of a single "push this watch-state change to Simkl" attempt, merged into every mark/unmark handler's response. */
interface SimklSyncResult {
  simklSynced: boolean
  simklError?: string
}

/** Runs a Simkl sync/history POST, translating "not connected" vs. a caught error vs. success into the same three-way shape every mark/unmark handler returns. */
async function syncSimklHistory(
  pathname: string,
  body: unknown,
  priority: TaskPriority = 'interactive'
): Promise<SimklSyncResult> {
  if (!simklCredentials().accessToken) return { simklSynced: false }
  try {
    await simklRequest(pathname, { method: 'POST', body: JSON.stringify(body) }, priority)
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
    RECONCILE_COOLDOWN_MS
  )
}

/** The cached diff, but only if it belongs to the account connected now. */
function cachedReconcileResult(): WatchStatusDiscrepancy[] {
  const account = simklAccountMark()
  // No account connected matches no stamp — never the empty-string
  // account a malformed row might carry.
  if (!account) return []
  const profile = getDatabase().activeProfile()
  const row = getDatabase().getCache<CachedReconcileResult>(
    reconcileKey(RECONCILE_RESULT_KEY_PREFIX)
  )
  return row?.account === account && row.profile === profile && Array.isArray(row.discrepancies)
    ? row.discrepancies
    : []
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
  const sendable = attemptable.filter((entry) => {
    if (locallyWatched.has(entry.id) !== entry.remoteWatched) return true
    // Agreement judged against a record this app knows to be behind
    // what it did to the remote side is not agreement — see
    // staleSnapshots.
    if (staleSnapshots.has(entry.id)) return true
    settled.add(entry.id)
    return false
  })

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
    try {
      const response = await simklRequest<SimklHistoryResponse>(
        pathname,
        {
          method: 'POST',
          body: JSON.stringify(batchHistoryPayload(items.map((item) => ({ item }))))
        },
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
  // another.
  //
  // Failures here do NOT un-confirm the entry, unlike MAL above. Simkl is
  // the service this queue's verdict is computed against and MAL's
  // progress is part of the same reconciliation; Trakt is a third party to
  // it. Dropping a decision Simkl accepted because Trakt was unreachable
  // would re-raise a disagreement that no longer exists. pushTraktHistory
  // already logs and swallows its own errors for the same reason.
  for (const entry of queue) {
    if (!confirmed.has(entry.id)) continue
    await pushTraktHistory(
      { id: entry.id, type: entry.type, title: entry.title, year: entry.year },
      {},
      locallyWatched.has(entry.id) ? 'add' : 'remove'
    )
  }

  // The one written record of what a flush actually did. Every failure
  // mode this path has had — blind confirmations, unattributable
  // not_found entries, decisions that vanished — was invisible precisely
  // because success and no-op looked identical in the log (a "keep local"
  // that changed nothing left no line anywhere). Catalog ids only; titles
  // and tokens stay out.
  if (sendable.length) {
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
 * The recurring watch-history pass, for backgroundJobs.ts.
 *
 * Two things, in the order they have to happen. First anything already
 * decided and still queued goes out — a decision made in a previous
 * session that never reached the services is the one piece of this that
 * is genuinely owed to somebody. Then, if the cooldown allows, the local
 * history is diffed against Simkl's so new disagreements are ready for
 * the review panel the next time it is opened.
 *
 * Deliberately does NOT push discrepancies at the renderer. The review
 * panel is opened from the renderer's own reconcileCheck call (see
 * trackingReconcileCheck), which shares this same cooldown — so the two
 * cooperate rather than double-asking, and a background pass never
 * interrupts anyone with a panel they did not ask for.
 */
export async function runBackgroundWatchSync(): Promise<void> {
  // Watchlists come in on the same schedule as history goes out. They are
  // both "make the local picture match the services", and giving them
  // separate timers would mean two independent things to reason about for
  // no benefit. Failures are swallowed inside the pull, per service.
  try {
    await syncPlannedFromServices('background')
  } catch (error) {
    logError('job:planned-sync', error)
  }
  if (!simklCredentials().accessToken) return
  // Background: this is a recurring job nobody asked for, so its pushes
  // must not jump ahead of the screen someone is looking at, and must
  // stand down along with the rest of the job once playback starts.
  await flushPendingPushes('background')
  const db = getDatabase()
  if (db.getCache(reconcileKey(RECONCILE_COOLDOWN_KEY_PREFIX))) return
  db.putCache(reconcileKey(RECONCILE_COOLDOWN_KEY_PREFIX), true, RECONCILE_COOLDOWN_MS)
  const account = simklAccountMark()
  const profile = db.activeProfile()
  try {
    writeReconcileResult(account, profile, await computeMovieDiscrepancies('background'))
  } catch (error) {
    logError('job:watch-sync', error)
  }
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

/** The actual diff. Local and remote are each reduced to "which movie ids
 *  does this side consider watched," and only ids where the two sides
 *  disagree are returned — an id watched (or not) on both sides is
 *  already in agreement and never surfaced. */
async function computeMovieDiscrepancies(
  priority: TaskPriority = 'background'
): Promise<WatchStatusDiscrepancy[]> {
  const ignored = ignoredReconcileIds()
  // Titles this app has stopped trying to push for the connected
  // account — see addAbandonedReconcileId.
  const givenUpOn = abandonedReconcileIds()
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
  const snapshot = await simklWatchedSnapshot(priority)
  // No trustworthy remote side means there is nothing to diff. An
  // unreadable Simkl comes back as an EMPTY Simkl, and an empty Simkl
  // makes every movie watched locally look like a disagreement — a review
  // panel offering to push the person's entire watch history to an account
  // that already has it. Reporting nothing is the honest answer: the
  // cooldown lapses and the next pass asks again.
  if (!snapshot.complete) return []
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
  return (
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
    return { tracked, history, plannedSources: plannedSources() }
  })

  /**
   * Pull plan-to-watch from every connected service, on demand.
   *
   * Also runs with the background watch sync, so an untouched app catches
   * up on its own — this exists for the case where somebody has just
   * added a pile of titles on the web and does not want to wait for the
   * next pass to see them.
   */
  handle<undefined, PlannedSyncReport>(MEDIA_HUB_CHANNELS.trackingPlannedSync, async () =>
    syncPlannedFromServices('interactive')
  )

  /** The last pull's result, so the panel has something to show before
   *  anybody presses the button. */
  handle<undefined, PlannedSyncReport | null>(MEDIA_HUB_CHANNELS.trackingPlannedReport, async () =>
    lastPlannedSyncReport()
  )

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

  handle<TrackableItem, { tracked: boolean }>(MEDIA_HUB_CHANNELS.trackingToggle, (_e, item) => {
    const db = getDatabase()
    const tracked = db.isTracked(item.id)
    // Only the TRACK direction is refused for an inexpressible id — a
    // toggle that untracks is how a demo title that already leaked into
    // the tracked table gets removed, and the guard must not lock it in.
    // See the mark-watched handler above for the full reasoning.
    if (!tracked) assertLibraryWritableId(item?.id, item?.title)
    if (tracked) db.untrack(item.id)
    else db.track(item)
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
    async (_e, { item, playback }) => {
      // No library ADD for an id no service can express (mockData's m-*
      // demo pool, reachable through the AI assistant's last-resort
      // fallback). This exact write is how three demo-id duplicates of
      // already-tracked films got into real watch_history on Aug 24 and
      // then sat in the sync review as unresolvable rows for five days
      // (PR #144 has the post-mortem). The renderer refuses the click
      // with the same message before it gets here; this is the boundary
      // that holds when some surface forgets to. Unmark below is
      // deliberately NOT guarded — removing a ghost is the cleanup.
      assertLibraryWritableId(item?.id, item?.title)
      getDatabase().markWatched(item, playback || {})
      requestRecommendationsRebuild()
      const simklResult = await syncSimklHistory(
        '/sync/history',
        historyPayload(item, playback || {})
      )
      // Not awaited into the result. Trakt is a third service alongside two
      // that already report their own outcome, and a person who has connected
      // all three should not have "I finished this" wait on the slowest of
      // them — the local row is the record either way, and a Trakt failure is
      // logged in traktClient rather than surfaced.
      void pushTraktHistory(item, playback || {}, 'add')
      return { ok: true, ...simklResult, ...(await pushMalProgress(item)) }
    }
  )

  handle<MarkWatchedPayload, MarkWatchedResult>(
    MEDIA_HUB_CHANNELS.trackingUnmarkWatched,
    async (_e, { item, playback }) => {
      const p = playback || {}
      getDatabase().unmarkWatched(item.id, p.season, p.episode)
      requestRecommendationsRebuild()
      const simklResult = await syncSimklHistory('/sync/history/remove', historyPayload(item, p))
      void pushTraktHistory(item, p, 'remove')
      return { ok: true, ...simklResult, ...(await pushMalProgress(item)) }
    }
  )

  handle<MarkSeasonWatchedPayload, MarkWatchedResult>(
    MEDIA_HUB_CHANNELS.trackingMarkSeasonWatched,
    async (_e, { item, season, episodes }) => {
      // Same refusal as the single-episode handler above, for the same
      // reason — a season of demo-id history rows is the same corruption,
      // multiplied by the episode count.
      assertLibraryWritableId(item?.id, item?.title)
      const list = Array.isArray(episodes) ? episodes : []
      const episodeNumbers = list.map((p) => p.episode)
      const db = getDatabase()
      for (const playback of list) db.markWatched(item, playback)
      requestRecommendationsRebuild()
      const simklResult = await syncSimklHistory(
        '/sync/history',
        seasonHistoryPayload(item, season, episodeNumbers)
      )
      // Not awaited into the result, same as the single-episode handler
      // above — a Trakt failure is logged in traktClient rather than making
      // "mark this season watched" wait on the slowest connected service.
      // This was missing entirely until now: the single-episode handler got
      // a Trakt push when Trakt sync was added, but this batch action did
      // not, which left every episode of a season marked watched here still
      // unwatched on a connected Trakt account.
      void pushTraktSeasonHistory(item, season, episodeNumbers)
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
    (_e, { id, playback, positionSeconds, durationSeconds, volume }) => {
      getDatabase().savePlaybackPosition(id, playback, positionSeconds, durationSeconds, volume)
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
  handle<undefined, ReconcileCheckResult>(MEDIA_HUB_CHANNELS.trackingReconcileCheck, async () => {
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
    if (db.getCache(reconcileKey(RECONCILE_COOLDOWN_KEY_PREFIX))) {
      // Inside the cooldown, but that no longer means "nothing to say" —
      // the background watch-sync job may have run the diff moments ago.
      // Reported as ran: false, which is the truth (this call did not run
      // one) and is all the renderer has ever keyed off; what it acts on
      // is whether there are discrepancies.
      const cached = cachedReconcileResult()
      return { ran: false, discrepancies: cached.filter((d) => !justPushed.has(d.id)) }
    }
    db.putCache(reconcileKey(RECONCILE_COOLDOWN_KEY_PREFIX), true, RECONCILE_COOLDOWN_MS)
    const account = simklAccountMark()
    const profile = db.activeProfile()
    try {
      const discrepancies = await computeMovieDiscrepancies()
      writeReconcileResult(account, profile, discrepancies)
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
      // Adds only — listsRemove stays open so a demo title already in a
      // list can be taken out. See the mark-watched handler above.
      assertLibraryWritableId(payload?.item?.id, payload?.item?.title)
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
    // A real score is a library ADD (and a Trakt push); 0 is this app's
    // "cleared" signal and stays allowed so a rating that already leaked
    // onto a demo id can be removed. See the mark-watched handler above.
    if (Number(payload?.score) > 0) assertLibraryWritableId(payload?.id, payload?.title)
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
    const exclusions = liveExclusions(history)

    // The suggestion row, from the list the background job already ranked
    // — see recommendations.ts. This is the whole point of that module:
    // the branch below has to wait for three catalogs, and a cold anime
    // catalog is a twenty-second Kitsu crawl that Home spent all of
    // waiting for eighteen rows it could have read from disk.
    const stored = readStoredRecommendations(exclusions, history)
    let recommendations: CatalogItem[]
    let recommendationReasons: Record<string, RecommendationReason>
    let preferredGenres: string[]

    if (stored) {
      recommendations = stored.items
      recommendationReasons = stored.reasons
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
      const candidates = all.filter(
        (item) =>
          !exclusions.watchedIds.has(String(item.id)) &&
          !exclusions.trackedIds.has(String(item.id)) &&
          !exclusions.dislikedIds.has(String(item.id))
      )
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
    }

    // See tracking:list above — same fan-out, same bound, and the two
    // share their per-title fetches through metadata()'s coalescing.
    const details = (
      await mapWithLimit(
        tracked.filter((x) => x.type !== 'movie'),
        (x) => metadata(x.type, x.id, 'visible')
      )
    ).filter((x): x is CatalogItem => Boolean(x))

    return {
      tracked,
      updates: db.trackedUpdates(details),
      continueWatching: continueWatchingList(details, history).slice(0, 18),
      recommendations,
      recommendationReasons,
      preferredGenres,
      // Read here rather than fetched: it is whatever the last pull
      // recorded, so tagging a card costs nothing on this path.
      plannedSources: plannedSources()
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
      const progress = Math.min(100, Math.max(0, Number(payload?.progress) || 0))
      // Both services hear the same transitions, independently of each
      // other. This used to sit behind the Simkl-connected check above, so a
      // Trakt-only account (Simkl never connected) never received a single
      // scrobble despite the setting promising otherwise — Trakt's own
      // scrobble endpoints are the same start/pause/stop state machine and
      // owe Simkl's connection state nothing.
      void pushTraktScrobble(payload.item, payload.playback || {}, action, progress)
      if (!simklConnected) return { connected: false }
      try {
        await simklRequest(`/scrobble/${action}`, {
          method: 'POST',
          body: JSON.stringify(scrobblePayload(payload.item, payload.playback || {}, progress))
        })
      } catch (error) {
        // Never thrown. A scrobble is a courtesy to a third-party service:
        // it must not interrupt playback, and an account whose token expired
        // mid-film should not produce an error over the video every time
        // somebody pauses. The local history is the record either way. The
        // reason IS reported back, though — the main window says it once per
        // session, so a token that expired or an id Simkl will not take is
        // something a person hears about rather than a line nobody reads.
        logError('simkl:scrobble', error)
        return { connected: true, error: (error as Error)?.message || String(error) }
      }
      return { connected: true }
    }
  )
}
