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
import { logError } from './logger'
import { simklCredentials } from './settingsStore'
import { watchedFromAllItems, type SimklMoviesPayload, type SimklShowsPayload } from './simkl'
import { getDatabase } from './dbState'

export function simklUrl(pathname: string, clientId: string): string {
  const url = new URL(pathname, 'https://api.simkl.com')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('app-name', 'r3v07v3r-media-hub')
  url.searchParams.set('app-version', app.getVersion())
  return url.toString()
}

/** Authenticated Simkl request (requires both a client ID and a connected account's access token). */
export async function simklRequest<T = unknown>(
  pathname: string,
  options: RequestInit = {}
): Promise<T> {
  const { clientId, accessToken } = simklCredentials()
  if (!clientId || !accessToken) throw new Error('Simkl is not connected.')
  return fetchJson<T>(simklUrl(pathname, clientId), {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': `r3v07v3r-media-hub/${app.getVersion()}`,
      ...options.headers
    }
  })
}

/** Client-ID-only Simkl request (search/lookup endpoints that don't require a connected account). */
export async function simklPublicRequest<T = unknown>(
  pathname: string,
  options: RequestInit = {}
): Promise<T> {
  const { clientId } = simklCredentials()
  if (!clientId) throw new Error('Add a Simkl Client ID in Settings to search movies & series.')
  return fetchJson<T>(simklUrl(pathname, clientId), {
    ...options,
    headers: {
      'User-Agent': `r3v07v3r-media-hub/${app.getVersion()}`,
      ...options.headers
    }
  })
}

const WATCHED_HISTORY_CACHE_KEY = 'simkl:watched:v1'

/** What Simkl reports as watched, plus whether that picture can be trusted at all. */
export interface SimklWatchedSnapshot {
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
export async function simklWatchedSnapshot(): Promise<SimklWatchedSnapshot> {
  if (!simklCredentials().accessToken) return { entries: [], complete: true }
  const key = WATCHED_HISTORY_CACHE_KEY
  const db = getDatabase()
  const cached = db.getCache<HistoryEntry[]>(key)
  if (cached) return { entries: cached, complete: true }

  try {
    const [movies, shows] = await Promise.all([
      simklRequest<SimklMoviesPayload>('/sync/all-items/movies/completed?extended=full'),
      simklRequest<SimklShowsPayload>(
        '/sync/all-items/shows/all?extended=full&episode_watched_at=yes'
      )
    ])
    const entries = watchedFromAllItems(movies, shows)
    db.putCache(key, entries, 20 * 60 * 1000)
    return { entries, complete: true }
  } catch (error) {
    logError('simkl:watched-history', error)
    const stale = db.getCache<HistoryEntry[]>(key, { allowExpired: true })
    // A stale snapshot is still a genuine picture of this account, just an
    // old one — that's the whole point of keeping expired rows readable.
    // Only the no-row case is a real "we don't know."
    return stale ? { entries: stale, complete: true } : { entries: [], complete: false }
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
  const existing = db.getCache<HistoryEntry[]>(WATCHED_HISTORY_CACHE_KEY, { allowExpired: true })
  db.putCache(WATCHED_HISTORY_CACHE_KEY, existing ?? [], 0)
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
 * A delete, not a stamp — worth knowing which of the two this is. The
 * pending-push queue in tracking.ts defends itself the stronger way:
 * every entry carries a simklAccountMark() and is checked against it
 * before being sent, so a queue that outlives its account is inert rather
 * than dangerous. This cache deserves the same, because the delete below
 * is best-effort (see deleteCache) and a database that was read-only at
 * the wrong moment leaves the previous account's library readable. That
 * mark is private to tracking.ts, which imports THIS module and so can't
 * be imported back; giving the cache the same guarantee means lifting it
 * somewhere both can reach. Worth doing, not done here.
 */
export function forgetSimklWatchedCache(): void {
  getDatabase().deleteCache(WATCHED_HISTORY_CACHE_KEY)
}
