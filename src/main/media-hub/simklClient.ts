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

/**
 * Flattened, cached view of everything Simkl reports as watched for the
 * connected account (movies + show episodes). Returns `[]` (not an error)
 * when Simkl isn't connected — callers merge this into local watch
 * history unconditionally. Falls back to a stale cache entry on error
 * rather than failing the caller outright.
 */
export async function simklWatchedHistory(): Promise<HistoryEntry[]> {
  if (!simklCredentials().accessToken) return []
  const key = 'simkl:watched:v1'
  const db = getDatabase()
  const cached = db.getCache<HistoryEntry[]>(key)
  if (cached) return cached

  try {
    const [movies, shows] = await Promise.all([
      simklRequest<SimklMoviesPayload>('/sync/all-items/movies/completed?extended=full'),
      simklRequest<SimklShowsPayload>(
        '/sync/all-items/shows/all?extended=full&episode_watched_at=yes'
      )
    ])
    const entries = watchedFromAllItems(movies, shows)
    db.putCache(key, entries, 20 * 60 * 1000)
    return entries
  } catch (error) {
    logError('simkl:watched-history', error)
    return db.getCache<HistoryEntry[]>(key, { allowExpired: true }) || []
  }
}
