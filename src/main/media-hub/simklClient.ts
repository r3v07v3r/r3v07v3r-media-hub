// Ported from r3v07v3r-media-hub's src/main.cjs (simklUrl/simklRequest/
// simklPublicRequest/simklWatchedHistory). Pulled out into its own module
// (the original had these inline alongside everything else in main.cjs)
// because three different handler domains all need Simkl API access:
// catalog.ts (search, id resolution), tracking.ts (history sync, OAuth PIN
// flow), and malSync.ts (reconciliation needs Simkl's watched history too)
// — centralizing here avoids a tracking.ts <-> malSync.ts import cycle.
//
// TODO(media-hub-integration): the `app-name`/User-Agent strings below are
// copied verbatim from the original app ('r3v07v3r-media-hub'). Left
// as-is rather than rebranded to this project's name, since it's unclear
// whether Simkl's developer console ties a Client ID's app-name query
// param to anything enforced server-side — changing it is a functional
// risk for zero user-visible benefit. Revisit if that's confirmed safe.

import { app } from 'electron'
import type { HistoryEntry } from '../../shared/media-hub/types'
import { fetchJson } from './httpClient'
import type { TaskPriority } from './taskScheduler'
import { logError } from './logger'
import { simklAccountMark, simklCredentials } from './settingsStore'
import { watchedFromAllItems, type SimklMoviesPayload, type SimklShowsPayload } from './simkl'
import type { SimklLibraryKind } from './simklCatchUpRules'
import { getDatabase } from './dbState'

export function simklUrl(pathname: string, clientId: string): string {
  const url = new URL(pathname, 'https://api.simkl.com')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('app-name', 'r3v07v3r-media-hub')
  url.searchParams.set('app-version', app.getVersion())
  return url.toString()
}

/**
 * Authenticated Simkl request (requires both a client ID and a connected
 * account's access token). `scheduling` is for the rare call that needs
 * more than the default 30 seconds, or whose body is the whole answer and
 * must not be read as empty when it was cut off — see simklLibrary.
 */
export async function simklRequest<T = unknown>(
  pathname: string,
  options: RequestInit = {},
  priority: TaskPriority = 'interactive',
  scheduling: { timeoutMs?: number; strictBody?: boolean } = {}
): Promise<T> {
  const { clientId, accessToken } = simklCredentials()
  if (!clientId || !accessToken) throw new Error('Simkl is not connected.')
  return fetchJson<T>(
    simklUrl(pathname, clientId),
    {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': `r3v07v3r-media-hub/${app.getVersion()}`,
        ...options.headers
      }
    },
    {
      priority,
      label: 'Simkl',
      timeoutMs: scheduling.timeoutMs,
      strictBody: scheduling.strictBody
    }
  )
}

/**
 * When each part of the connected account's library last changed — the
 * one request Simkl asks every client to make before fetching any of it.
 * Raw; simklCatchUpRules.ts's parseSimklActivities reads it.
 */
export function simklActivities(priority: TaskPriority = 'interactive'): Promise<unknown> {
  // Strict: a body that was cut off would read as "Simkl gave no stamps",
  // which the catch-up treats as a reason to fetch, not as a failure.
  return simklRequest<unknown>('/sync/activities', {}, priority, { strictBody: true })
}

const LIBRARY_PATHS: Record<SimklLibraryKind, string> = {
  // Completed only: a film anywhere else on Simkl is not a viewing, and
  // plan to watch arrives through the watchlist pull.
  movie: '/sync/all-items/movies/completed?extended=full',
  show: '/sync/all-items/shows/all?extended=full&episode_watched_at=yes&include_all_episodes=yes',
  anime: '/sync/all-items/anime/all?extended=full&episode_watched_at=yes&include_all_episodes=yes'
}

/** A whole library over a phone's connection can outlast the default 30
 *  seconds, and a timeout here costs the whole kind until its backoff ends. */
const LIBRARY_TIMEOUT_MS = 90 * 1000

/**
 * One kind of the connected account's library, with every watched episode
 * and its date. Raw; simklCatchUpRules.ts's parseSimklLibrary reads it.
 * Only ever called behind simklActivities — see simklCatchUp.ts.
 *
 * Strict about its body: the lenient default turns a read cut off by the
 * timeout or a dropped connection into `{}`, which is exactly how an empty
 * library looks. The catch-up would record the kind as applied and not
 * fetch it again until something else changed at Simkl.
 *
 * `since` is Simkl's `date_from`: only what changed after that moment (an
 * activity stamp, passed back exactly as Simkl gave it). Simkl asks a client
 * that keeps in step to fetch whole once and by `date_from` afterwards, and
 * says it suspends ones that go on downloading everything. Null fetches the
 * kind whole — see simklCatchUpRules.ts's librarySince for when.
 */
export function simklLibrary(
  kind: SimklLibraryKind,
  priority: TaskPriority = 'background',
  since: string | null = null
): Promise<unknown> {
  const path = since
    ? `${LIBRARY_PATHS[kind]}&date_from=${encodeURIComponent(since)}`
    : LIBRARY_PATHS[kind]
  return simklRequest<unknown>(path, {}, priority, {
    timeoutMs: LIBRARY_TIMEOUT_MS,
    strictBody: true
  })
}

/**
 * Client-ID-only Simkl request (search/lookup endpoints that don't require a
 * connected account). `label` names the request in the scheduler's queue.
 */
export async function simklPublicRequest<T = unknown>(
  pathname: string,
  priority: TaskPriority = 'interactive',
  options: RequestInit = {},
  label = 'Simkl'
): Promise<T> {
  const { clientId } = simklCredentials()
  // Title search no longer runs through here — it reads the index and
  // Cinemeta (see catalog.ts's catalog:search) — so the message must not
  // claim it does. What still needs a Client ID is resolving a Simkl id.
  if (!clientId) throw new Error('Add a Simkl Client ID in Settings to look titles up on Simkl.')
  return fetchJson<T>(
    simklUrl(pathname, clientId),
    {
      ...options,
      headers: {
        'User-Agent': `r3v07v3r-media-hub/${app.getVersion()}`,
        ...options.headers
      }
    },
    { priority, label }
  )
}

// v2 stamps the payload with WHOSE history it is (see CachedWatchedHistory).
// The v1 rows left on disk carry a bare array with no account on it, so they
// can never satisfy the check below and are simply never read again; the
// database's own prune reclaims them.
const WATCHED_HISTORY_CACHE_KEY = 'simkl:watched:v2'
/**
 * The films alone, for the review panel's diff, which compares films and
 * nothing else. Kept apart from the whole snapshot above so the MAL preview,
 * which needs the shows too, never takes a films-only read for a whole one.
 */
const WATCHED_MOVIES_CACHE_KEY = 'simkl:watched-movies:v1'
/** How long either snapshot is reused. */
const WATCHED_CACHE_TTL_MS = 20 * 60 * 1000

/** The cache payload: the history, and the account it belongs to. */
interface CachedWatchedHistory {
  account: string
  entries: HistoryEntry[]
}

/**
 * The cached history, but ONLY if it belongs to `account`. A row stamped
 * with anyone else is not a weaker answer to fall back on, it's the wrong
 * person's library — so it reads as no row at all, and the caller reports
 * "couldn't read" rather than serving it.
 *
 * This, not forgetSimklWatchedCache, is what actually makes the account
 * boundary hold. Clearing on sign-out is tidying: it is best-effort, it
 * can't run if the app was killed, and it can't do anything about a
 * request that was already in flight when the account changed. The stamp
 * covers all of those, because it is checked at the point of USE.
 */
function cachedHistoryFor(
  account: string,
  allowExpired = false,
  key: string = WATCHED_HISTORY_CACHE_KEY
): HistoryEntry[] | null {
  // No account connected matches no stamp — never the empty-string account
  // a malformed row might carry.
  if (!account) return null
  const row = getDatabase().getCache<CachedWatchedHistory>(key, {
    allowExpired
  })
  return row?.account === account && Array.isArray(row.entries) ? row.entries : null
}

/** What Simkl reports as watched, plus whether that picture can be trusted at all. */
interface SimklWatchedSnapshot {
  entries: HistoryEntry[]
  /**
   * True when `entries` is a real answer about the remote side: freshly
   * fetched, served from this module's cache, or accurately empty because
   * no account is connected. False ONLY when an account IS connected and
   * its history could not be read — the request failed and there was no
   * cached snapshot to fall back on — which leaves `entries` empty for
   * lack of knowledge rather than lack of watches.
   *
   * Anything that DIFFS local state against Simkl has to check this.
   * "We couldn't ask" and "Simkl has nothing" produce the same empty
   * array but mean opposite things, and reading the first as the second
   * turns every locally watched title into a discrepancy against a remote
   * account that never actually disagreed.
   */
  complete: boolean
  /**
   * True only when this call read the library from Simkl itself — not from
   * the cache, fresh or stale, and not for want of an account. The
   * recurring watch-sync pass (watchSync.ts) records Simkl's activity stamp
   * against what it diffed, and a snapshot that may predate that stamp
   * cannot vouch for it.
   */
  fetched: boolean
}

/**
 * Flattened, cached view of everything Simkl reports as watched for the
 * connected account (movies + show episodes). Never throws for a Simkl
 * problem — callers merge this into local watch history, and a tracking
 * service being unreachable shouldn't fail whatever they were doing.
 * Falls back to a stale cache entry on error rather than losing the last
 * good answer; when even that is unavailable, says so via `complete`
 * instead of posing as an account with nothing watched.
 */
export async function simklWatchedSnapshot(
  priority: TaskPriority = 'interactive',
  options: { moviesOnly?: boolean } = {}
): Promise<SimklWatchedSnapshot> {
  // Read once, up front: this is the account the whole call is about, and
  // everything below is checked against it rather than against whatever
  // happens to be connected by the time each step runs.
  const account = simklAccountMark()
  if (!account) return { entries: [], complete: true, fetched: false }
  if (options.moviesOnly) return simklWatchedMovies(account, priority)
  const cached = cachedHistoryFor(account)
  if (cached) return { entries: cached, complete: true, fetched: false }

  try {
    // Two whole-library reads that take seconds each. The default above
    // is `interactive` because the MyAnimeList reconcile preview calls
    // this with somebody watching a spinner — but the recurring
    // watch-history pass calls it too, and that one has to go behind
    // anything the person is actually doing.
    const [movies, shows] = await Promise.all([
      simklRequest<SimklMoviesPayload>(
        '/sync/all-items/movies/completed?extended=full',
        {},
        priority
      ),
      simklRequest<SimklShowsPayload>(
        '/sync/all-items/shows/all?extended=full&episode_watched_at=yes',
        {},
        priority
      )
    ])
    // These requests take seconds, and signing out or authorizing someone
    // else during them is an ordinary thing to do. Both carry the OLD
    // account's bearer token, so what came back is the OLD account's
    // library — writing it now would repopulate the key that sign-out just
    // cleared, and hand the NEW account twenty minutes of somebody else's
    // watch history to be diffed and "corrected" against.
    if (simklAccountMark() !== account) return { entries: [], complete: false, fetched: false }
    const entries = watchedFromAllItems(movies, shows)
    getDatabase().putCache(
      WATCHED_HISTORY_CACHE_KEY,
      { account, entries } satisfies CachedWatchedHistory,
      WATCHED_CACHE_TTL_MS
    )
    return { entries, complete: true, fetched: true }
  } catch (error) {
    logError('simkl:watched-history', error)
    // Re-read the mark for the same reason as above — the account can have
    // changed while this request was failing, and the stale row would then
    // belong to the account that left. A stale snapshot of the account
    // still connected is a genuine picture, just an old one, which is the
    // whole point of keeping expired rows readable; anything else is a
    // real "we don't know."
    const stale = cachedHistoryFor(simklAccountMark(), true)
    return stale
      ? { entries: stale, complete: true, fetched: false }
      : { entries: [], complete: false, fetched: false }
  }
}

/**
 * The films Simkl reports as watched, for the review panel's diff.
 *
 * That diff compares films and nothing else, and it used to pay for the
 * whole snapshot: the shows library with every episode's date, the largest
 * thing this app asks Simkl for, read and thrown away. This reads the films
 * alone. A whole snapshot already in the cache answers for it (its films
 * are as good), and a films-only read is kept under its own key, so the
 * MyAnimeList preview, which needs the shows, never mistakes it for a whole
 * one. Same account checks and the same stale fallback as above.
 */
async function simklWatchedMovies(
  account: string,
  priority: TaskPriority
): Promise<SimklWatchedSnapshot> {
  const films = (entries: HistoryEntry[]): HistoryEntry[] =>
    entries.filter((entry) => entry.type === 'movie')
  const whole = cachedHistoryFor(account)
  if (whole) return { entries: films(whole), complete: true, fetched: false }
  const cached = cachedHistoryFor(account, false, WATCHED_MOVIES_CACHE_KEY)
  if (cached) return { entries: cached, complete: true, fetched: false }
  try {
    const movies = await simklRequest<SimklMoviesPayload>(
      '/sync/all-items/movies/completed?extended=full',
      {},
      priority
    )
    if (simklAccountMark() !== account) return { entries: [], complete: false, fetched: false }
    const entries = watchedFromAllItems(movies)
    getDatabase().putCache(
      WATCHED_MOVIES_CACHE_KEY,
      { account, entries } satisfies CachedWatchedHistory,
      WATCHED_CACHE_TTL_MS
    )
    return { entries, complete: true, fetched: true }
  } catch (error) {
    logError('simkl:watched-movies', error)
    // As above: the account still connected, read again after the failure.
    const now = simklAccountMark()
    const staleWhole = cachedHistoryFor(now, true)
    const stale =
      cachedHistoryFor(now, true, WATCHED_MOVIES_CACHE_KEY) ??
      (staleWhole ? films(staleWhole) : null)
    return stale
      ? { entries: stale, complete: true, fetched: false }
      : { entries: [], complete: false, fetched: false }
  }
}

/**
 * Forces the next simklWatchedSnapshot() call to refetch instead of reusing
 * its 20-minute cache. Needed after a "keep local" reconcile resolution
 * pushes a change to Simkl directly (bypassing this module's own request
 * path) — without this, the stale cached snapshot still disagrees with the
 * now-correct remote account, and the same discrepancy resurfaces on every
 * later reconcile check until the cache happens to expire on its own.
 * Rewrites the existing payload with an already-elapsed TTL rather than
 * deleting it outright, so the error-path "fall back to stale cache"
 * behavior above still has real data to fall back to if the refetch fails.
 */
export function invalidateSimklWatchedCache(): void {
  const db = getDatabase()
  // Both snapshots: the films-only one is what the review panel's diff reads.
  for (const key of [WATCHED_HISTORY_CACHE_KEY, WATCHED_MOVIES_CACHE_KEY]) {
    const existing = db.getCache<CachedWatchedHistory>(key, { allowExpired: true })
    // Nothing cached means there is nothing to keep readable. Writing an
    // empty payload here — which is what `existing ?? []` used to do —
    // would MANUFACTURE the "Simkl has nothing watched" answer that
    // `complete` exists to distinguish from "Simkl could not be reached",
    // and a later failed refetch would fall back onto it and report every
    // locally watched title as a discrepancy.
    if (!existing) continue
    db.putCache(key, existing, 0)
  }
}

/**
 * Throws the cached watched history away entirely, for when the CONNECTED
 * ACCOUNT changes — signing out, or authorizing a different one.
 *
 * Deliberately not invalidateSimklWatchedCache above. That one keeps the
 * payload readable on purpose, so a failed refetch can still fall back on
 * it; correct when the snapshot is merely one push out of date, and
 * exactly wrong here. What's cached belongs to the account that just went
 * away, and serving it as a fallback means diffing the NEW account's local
 * history against the OLD account's remote one — a review panel full of
 * disagreements that are really just somebody else's library, offering to
 * "fix" them by pushing or erasing watches on an account that was never
 * out of sync.
 *
 * Tidying, not the safety guarantee — same division as clearPendingPushes
 * in tracking.ts, and worth knowing which of the two this is. The delete
 * below is best-effort (see deleteCache), can't run at all if the app was
 * killed, and can do nothing about a request already in flight. What
 * actually keeps one account's history from being served to the next is
 * the stamp every payload carries, checked at the point of use — see
 * cachedHistoryFor. This just frees the row rather than leaving it to sit
 * there unreadable until the prune.
 */
export function forgetSimklWatchedCache(): void {
  getDatabase().deleteCache(WATCHED_HISTORY_CACHE_KEY)
  getDatabase().deleteCache(WATCHED_MOVIES_CACHE_KEY)
}
