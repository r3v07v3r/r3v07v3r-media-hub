// Plan-to-watch, pulled from wherever the person actually keeps it.
//
// This app has always PUSHED watch history to the tracking services and
// pulled history back from Simkl. What it never did was read a WATCHLIST
// from any of them — so "Planned" only ever held what somebody marked
// here, in this app, and a list built up over years in Trakt or Simkl was
// invisible. That is the gap this closes.
//
// THREE SERVICES, NOT FOUR. Simkl, Trakt and MyAnimeList each have an
// authenticated account in this app and a personal list to read. Kitsu
// does not: it is used here as a public anime catalog (artwork, mappings,
// season data) with no login at all, so there is no "your Kitsu list" to
// fetch. Listing it as a source would be a promise nothing could keep.
//
// WHAT THIS DOES NOT DO is decide anything about removals. A title that
// has left a remote list is not un-planned here, and a title planned here
// is not pushed anywhere by this module. Pulling is safe and idempotent;
// mirroring deletions in both directions needs a conflict policy that
// nobody has designed yet, and guessing at one would delete somebody's
// list. See the reconcile queue in tracking.ts for what that costs to do
// properly.

import { getDatabase } from './dbState'
import { logError } from './logger'
import { kitsuIdForExternal } from './idBridge'
import { malRequest } from './malSync'
import { simklRequest } from './simklClient'
import { malCredentials, simklCredentials, traktCredentials } from './settingsStore'
import { traktRequest } from './traktClient'
import type { MediaKind } from '../../shared/media-hub/types'
import type { TaskPriority } from './taskScheduler'

/** Which services a title is planned on. The renderer tags cards with it. */
export const PLANNED_SOURCES_CACHE_KEY = 'planned:sources'

/** A day. The pull runs with the background watch sync, so this only has
 *  to outlive the gap between two of those — long enough that tags
 *  survive a restart, short enough that a list somebody emptied on the
 *  web stops being claimed here within a day. */
const SOURCES_TTL_MS = 24 * 60 * 60 * 1000

export type PlannedSource = 'simkl' | 'trakt' | 'mal'

export interface PlannedEntry {
  /** IMDb id for film and series, `kitsu:<id>` for anime — the same
   *  identity the catalog and the tracked table use, or this would add
   *  duplicates of titles already on the list. */
  id: string
  type: MediaKind
  title: string
  year?: string
  source: PlannedSource
}

/** Map of media id -> the services that have it planned. */
export type PlannedSources = Record<string, PlannedSource[]>

interface SimklPlannedPayload {
  movies?: { movie?: { title?: string; year?: number; ids?: { imdb?: string } } }[]
  shows?: { show?: { title?: string; year?: number; ids?: { imdb?: string } } }[]
}

/**
 * Simkl's plan-to-watch, which it calls `plantowatch`.
 *
 * Anime is deliberately not requested. Simkl returns it under its own
 * ids, and this app identifies anime by Kitsu id — mapping between them
 * is the job animeSeasons.ts does with real care, and doing it badly here
 * would file somebody's anime as an unmatched stranger.
 */
async function fetchSimklPlanned(priority: TaskPriority): Promise<PlannedEntry[]> {
  if (!simklCredentials().accessToken) return []
  const [movies, shows] = await Promise.all([
    simklRequest<SimklPlannedPayload>('/sync/all-items/movies/plantowatch', {}, priority),
    simklRequest<SimklPlannedPayload>('/sync/all-items/shows/plantowatch', {}, priority)
  ])
  const out: PlannedEntry[] = []
  for (const entry of movies.movies || []) {
    const imdb = entry.movie?.ids?.imdb
    if (!imdb) continue
    out.push({
      id: imdb,
      type: 'movie',
      title: entry.movie?.title ?? '',
      year: entry.movie?.year ? String(entry.movie.year) : undefined,
      source: 'simkl'
    })
  }
  for (const entry of shows.shows || []) {
    const imdb = entry.show?.ids?.imdb
    if (!imdb) continue
    out.push({
      id: imdb,
      type: 'series',
      title: entry.show?.title ?? '',
      year: entry.show?.year ? String(entry.show.year) : undefined,
      source: 'simkl'
    })
  }
  return out
}

interface TraktWatchlistRow {
  movie?: { title?: string; year?: number; ids?: { imdb?: string } }
  show?: { title?: string; year?: number; ids?: { imdb?: string } }
}

/** Trakt's watchlist, which is its plan-to-watch by another name. */
async function fetchTraktPlanned(priority: TaskPriority): Promise<PlannedEntry[]> {
  if (!traktCredentials().accessToken) return []
  const [movies, shows] = await Promise.all([
    traktRequest<TraktWatchlistRow[]>('/sync/watchlist/movies', {}, priority),
    traktRequest<TraktWatchlistRow[]>('/sync/watchlist/shows', {}, priority)
  ])
  const out: PlannedEntry[] = []
  for (const row of Array.isArray(movies) ? movies : []) {
    const imdb = row.movie?.ids?.imdb
    if (!imdb) continue
    out.push({
      id: imdb,
      type: 'movie',
      title: row.movie?.title ?? '',
      year: row.movie?.year ? String(row.movie.year) : undefined,
      source: 'trakt'
    })
  }
  for (const row of Array.isArray(shows) ? shows : []) {
    const imdb = row.show?.ids?.imdb
    if (!imdb) continue
    out.push({
      id: imdb,
      type: 'series',
      title: row.show?.title ?? '',
      year: row.show?.year ? String(row.show.year) : undefined,
      source: 'trakt'
    })
  }
  return out
}

interface MalListRow {
  node?: { id?: number; title?: string; start_date?: string }
  list_status?: { status?: string }
}

interface MalListResponse {
  data?: MalListRow[]
  paging?: { next?: string }
}

/**
 * MyAnimeList's plan_to_watch entries.
 *
 * Its ids are MAL's own, and this app files anime under Kitsu ids, so
 * each one needs the mapping the anime catalog already maintains. Where
 * there is no mapping the entry is dropped rather than added under an id
 * nothing else in the app would ever match — a row that cannot be opened
 * is worse than a row that is not there.
 */
async function fetchMalPlanned(): Promise<PlannedEntry[]> {
  if (!malCredentials().accessToken) return []
  const rows: MalListRow[] = []
  let pathname: string | null =
    '/users/@me/animelist?fields=list_status&limit=1000&status=plan_to_watch'
  for (let page = 0; page < 10 && pathname; page++) {
    const result: MalListResponse = await malRequest<MalListResponse>(pathname)
    rows.push(...(result.data || []))
    pathname = result.paging?.next
      ? result.paging.next.replace('https://api.myanimelist.net/v2', '')
      : null
  }
  const out: PlannedEntry[] = []
  for (const row of rows) {
    if (row.list_status?.status !== 'plan_to_watch') continue
    const malId = row.node?.id
    if (malId === undefined) continue
    // The same resolver malSync uses for its own pushes, so a title
    // lands under exactly the id the rest of the app files it by.
    const kitsuId = await kitsuIdForExternal('mal', malId, 'background')
    if (!kitsuId) continue
    out.push({
      id: `kitsu:${kitsuId}`,
      type: 'anime',
      title: row.node?.title ?? '',
      year: row.node?.start_date ? row.node.start_date.slice(0, 4) : undefined,
      source: 'mal'
    })
  }
  return out
}

/**
 * Pulls every connected service's plan-to-watch and folds it into the
 * local list.
 *
 * Adds only. Anything already tracked keeps the record it has — the local
 * one is the one with this app's own artwork and ids resolved against the
 * catalog, and replacing it with a thinner remote row would lose that for
 * no gain. What the remote pass DOES contribute for those is the source
 * tag, which is the point: a title on the list can now say where it came
 * from and which services agree about it.
 *
 * Failures are per-service. One unreachable account does not lose the
 * other two: each fetch is caught on its own and the merge proceeds with
 * whatever answered, because a partial list is much closer to right than
 * no list at all.
 */
export async function syncPlannedFromServices(
  priority: TaskPriority = 'background'
): Promise<{ added: number; sources: PlannedSources }> {
  const settled = await Promise.allSettled([
    fetchSimklPlanned(priority),
    fetchTraktPlanned(priority),
    fetchMalPlanned()
  ])
  const entries: PlannedEntry[] = []
  for (const result of settled) {
    if (result.status === 'fulfilled') entries.push(...result.value)
    else logError('watchlists:pull', result.reason)
  }
  if (!entries.length) return { added: 0, sources: {} }

  const sources: PlannedSources = {}
  for (const entry of entries) {
    const list = sources[entry.id] ?? []
    if (!list.includes(entry.source)) list.push(entry.source)
    sources[entry.id] = list
  }

  const db = getDatabase()
  const alreadyTracked = new Set(db.tracked().map((item) => String(item.id)))
  let added = 0
  // One row per id, not per entry: a film on all three lists is one title
  // planned three times over, not three titles.
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    if (alreadyTracked.has(entry.id)) continue
    try {
      db.track({ id: entry.id, type: entry.type, title: entry.title, year: entry.year })
      added += 1
    } catch (error) {
      logError('watchlists:track', error)
    }
  }

  db.putCache(PLANNED_SOURCES_CACHE_KEY, sources, SOURCES_TTL_MS, { durable: true })
  return { added, sources }
}

/** Whatever the last pull recorded. Expired is still worth showing: a
 *  stale tag is a better answer than none, and the next pull corrects it. */
export function plannedSources(): PlannedSources {
  return (
    getDatabase().getCache<PlannedSources>(PLANNED_SOURCES_CACHE_KEY, { allowExpired: true }) ?? {}
  )
}
