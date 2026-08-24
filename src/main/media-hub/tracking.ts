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
import {
  applyPushOutcome,
  queuePendingPush,
  withPushedRemoteState
} from '../../shared/media-hub/reconcileQueue'
import { rankPersonalizedRecommendations } from '../../shared/media-hub/catalog-logic'
import { airingStatus, continueWatchingList } from './core'
import { catalogData, metadata } from './catalog'
import { getDatabase } from './dbState'
import { fetchJson } from './httpClient'
import { mapWithLimit } from './taskScheduler'
import { handle } from './ipcGuard'
import { logError } from './logger'
import { pushMalProgress } from './malSync'
import {
  encrypt,
  readSettings,
  simklAccountMark,
  simklCredentials,
  writeSettings
} from './settingsStore'
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

interface ListPositionsPayload {
  id: string
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
const RECONCILE_RESULT_KEY = 'reconcile:result:v2'

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
  discrepancies: WatchStatusDiscrepancy[]
}

function writeReconcileResult(discrepancies: WatchStatusDiscrepancy[]): void {
  getDatabase().putCache<CachedReconcileResult>(
    RECONCILE_RESULT_KEY,
    { account: simklAccountMark(), discrepancies },
    RECONCILE_COOLDOWN_MS
  )
}

/** The cached diff, but only if it belongs to the account connected now. */
function cachedReconcileResult(): WatchStatusDiscrepancy[] {
  const account = simklAccountMark()
  // No account connected matches no stamp — never the empty-string
  // account a malformed row might carry.
  if (!account) return []
  const row = getDatabase().getCache<CachedReconcileResult>(RECONCILE_RESULT_KEY)
  return row?.account === account && Array.isArray(row.discrepancies) ? row.discrepancies : []
}
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
const RECONCILE_ABANDONED_KEY = 'reconcile:abandoned:v1'

interface AbandonedRecord {
  account: string
  ids: string[]
}

function abandonedReconcileIds(): Set<string> {
  const stored = getDatabase().getCache<AbandonedRecord>(RECONCILE_ABANDONED_KEY)
  if (!stored?.ids?.length || stored.account !== simklAccountMark()) return new Set()
  return new Set(stored.ids)
}

/** Reports whether the suppression actually stuck, on the same
 *  read-it-back terms as writePendingPushes — a title can only be
 *  treated as given up on once the record saying so exists, or the pass
 *  that reports it goes straight on to ask about it again. */
function addAbandonedReconcileId(id: string): boolean {
  const ids = abandonedReconcileIds()
  ids.add(id)
  const record: AbandonedRecord = { account: simklAccountMark(), ids: [...ids] }
  getDatabase().putCache(RECONCILE_ABANDONED_KEY, record, RECONCILE_IGNORED_TTL_MS)
  return abandonedReconcileIds().has(id)
}

/** Decisions someone has already made ("keep local") that haven't been
 *  confirmed on every connected service yet. Persisted for the same
 *  reason as the ignored list above and with the same TTL: it's a record
 *  of what a person decided, not a rate limit, and a decision has to
 *  outlive a failed push or the app being closed — otherwise the exact
 *  titles they already ruled on come back on the next launch, which is
 *  the bug this queue exists to end. */
const RECONCILE_PENDING_KEY = 'reconcile:pending:v2'
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
const RECONCILE_RETRY_KEY = 'reconcile:retry-cooldown:v1'
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
function pendingPushes(): PendingWatchStatusPush[] {
  const stored = getDatabase().getCache<PendingQueue>(RECONCILE_PENDING_KEY)
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
function writePendingPushes(queue: PendingWatchStatusPush[]): boolean {
  const payload: PendingQueue = { account: simklAccountMark(), entries: queue }
  getDatabase().putCache(RECONCILE_PENDING_KEY, payload, RECONCILE_PENDING_TTL_MS)
  // The whole payload, not just which ids are present: a flush that only
  // bumped `attempts` (or corrected `remoteWatched`) leaves the id set
  // identical, so comparing ids would call a rejected write a success
  // and let a failing entry sit at the same attempt count forever,
  // never reaching the cap that is supposed to stop it.
  return JSON.stringify(pendingPushes()) === JSON.stringify(queue)
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
async function pushPendingToServices(): Promise<Set<string>> {
  const queue = pendingPushes()
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
  // already failed waits for the retry pacing — see RECONCILE_RETRY_KEY
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
      const response = await simklRequest<SimklHistoryResponse>(pathname, {
        method: 'POST',
        body: JSON.stringify(batchHistoryPayload(items.map((item) => ({ item }))))
      })
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
  if (sendable.length) startRetryPacing()

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
    pendingPushes(),
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
    ;(addAbandonedReconcileId(entry.id) ? letGo : stillHeld).push(entry)
  }

  // Entries that were pushed and stayed queued now know something new
  // about the remote side — see withPushedRemoteState.
  const kept = withPushedRemoteState([...remaining, ...stillHeld], pushedValue)
  const persisted = writePendingPushes(kept)
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
    else scheduleRetry(retryPacingDeadline() - Date.now())
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
  if (!simklCredentials().accessToken) return
  await flushPendingPushes()
  const db = getDatabase()
  if (db.getCache(RECONCILE_COOLDOWN_KEY)) return
  db.putCache(RECONCILE_COOLDOWN_KEY, true, RECONCILE_COOLDOWN_MS)
  try {
    writeReconcileResult(await computeMovieDiscrepancies())
  } catch (error) {
    logError('job:watch-sync', error)
  }
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

/** When the next retry is allowed: the later of what was written down
 *  and what this session remembers. */
function retryPacingDeadline(): number {
  return Math.max(retryPacingUntil, getDatabase().getCache<number>(RECONCILE_RETRY_KEY) ?? 0)
}

function startRetryPacing(): void {
  const until = Date.now() + RECONCILE_RETRY_COOLDOWN_MS
  retryPacingUntil = until
  getDatabase().putCache(RECONCILE_RETRY_KEY, until, RECONCILE_RETRY_COOLDOWN_MS)
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
async function computeMovieDiscrepancies(): Promise<WatchStatusDiscrepancy[]> {
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
  const snapshot = await simklWatchedSnapshot('background')
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
      remoteWatched: remote
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
      try {
        const detail = await metadata('movie', discrepancy.id, 'background')
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
    if (db.getCache(RECONCILE_COOLDOWN_KEY)) {
      // Inside the cooldown, but that no longer means "nothing to say" —
      // the background watch-sync job may have run the diff moments ago.
      // Reported as ran: false, which is the truth (this call did not run
      // one) and is all the renderer has ever keyed off; what it acts on
      // is whether there are discrepancies.
      const cached = cachedReconcileResult()
      return { ran: false, discrepancies: cached.filter((d) => !justPushed.has(d.id)) }
    }
    db.putCache(RECONCILE_COOLDOWN_KEY, true, RECONCILE_COOLDOWN_MS)
    try {
      const discrepancies = await computeMovieDiscrepancies()
      writeReconcileResult(discrepancies)
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
      (['movie', 'series', 'anime'] as const).map((kind) =>
        catalogData(kind, false, 'visible').catch(() => [])
      )
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
    const recommendationCandidates = all.filter(
      (x) =>
        !watchedIds.has(String(x.id)) &&
        !trackedIds.has(String(x.id)) &&
        !dislikedIds.has(String(x.id))
    )
    const recommendations = rankPersonalizedRecommendations(recommendationCandidates, {
      history,
      preferredGenres: genres
    }).slice(0, 18)

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
      recommendations: recommendations.length
        ? recommendations
        : rankPersonalizedRecommendations(all, { history, preferredGenres: genres }).slice(0, 18),
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
