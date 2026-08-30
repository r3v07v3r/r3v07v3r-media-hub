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

/**
 * What one service's pull actually did.
 *
 * Reported per service rather than as one total, because the failure that
 * matters most is the quiet one: two lists arriving and a third erroring
 * looks exactly like a short list unless somebody is told. `unmapped`
 * carries the other silent case — anime entries dropped for want of a
 * Kitsu id, which used to vanish with nobody counting them.
 */
export interface PlannedServiceReport {
  service: PlannedSource
  connected: boolean
  pulled: number
  unmapped: number
  error?: string
}

export interface PlannedSyncReport {
  at: number
  services: PlannedServiceReport[]
  /** Titles newly added to the local list by this pull. */
  added: number
}

const REPORT_CACHE_KEY = 'planned:last-sync'

interface SimklIds {
  imdb?: string
  mal?: number | string
  anidb?: number | string
}

interface SimklPlannedPayload {
  movies?: { movie?: { title?: string; year?: number; ids?: SimklIds } }[]
  shows?: { show?: { title?: string; year?: number; ids?: SimklIds } }[]
  anime?: { show?: { title?: string; year?: number; ids?: SimklIds } }[]
}

/**
 * Simkl's plan-to-watch, which it calls `plantowatch`.
 *
 * ANIME COMES THROUGH ITS FOREIGN IDS. Simkl files anime under its own
 * id, which means nothing here — but it also carries `mal` and `anidb`
 * on the same record, and both are keys the id bridge can already turn
 * into the Kitsu id this app files anime under. So the mapping is the
 * bridge's existing job rather than a second, worse one written here.
 * An entry that resolves to nothing is counted and dropped, never
 * invented: a row that cannot be opened is worse than a row that is not
 * there, and now the count says how often that happens.
 */
async function fetchSimklPlanned(
  priority: TaskPriority
): Promise<{ entries: PlannedEntry[]; unmapped: number }> {
  if (!simklCredentials().accessToken) return { entries: [], unmapped: 0 }
  const [movies, shows, anime] = await Promise.all([
    simklRequest<SimklPlannedPayload>('/sync/all-items/movies/plantowatch', {}, priority),
    simklRequest<SimklPlannedPayload>('/sync/all-items/shows/plantowatch', {}, priority),
    simklRequest<SimklPlannedPayload>('/sync/all-items/anime/plantowatch', {}, priority)
  ])
  let unmapped = 0
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
  for (const entry of anime.anime || []) {
    const ids = entry.show?.ids
    // MAL first, AniDB second — both are supported by the bridge, and MAL
    // is the one Simkl fills in most reliably for anime.
    const kitsuId =
      (ids?.mal !== undefined ? await kitsuIdForExternal('mal', ids.mal, priority) : null) ??
      (ids?.anidb !== undefined ? await kitsuIdForExternal('anidb', ids.anidb, priority) : null)
    if (!kitsuId) {
      unmapped += 1
      continue
    }
    out.push({
      id: `kitsu:${kitsuId}`,
      type: 'anime',
      title: entry.show?.title ?? '',
      year: entry.show?.year ? String(entry.show.year) : undefined,
      source: 'simkl'
    })
  }
  return { entries: out, unmapped }
}

interface TraktWatchlistRow {
  movie?: { title?: string; year?: number; ids?: { imdb?: string } }
  show?: { title?: string; year?: number; ids?: { imdb?: string } }
}

/** Trakt's watchlist, which is its plan-to-watch by another name. */
async function fetchTraktPlanned(
  priority: TaskPriority
): Promise<{ entries: PlannedEntry[]; unmapped: number }> {
  if (!traktCredentials().accessToken) return { entries: [], unmapped: 0 }
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
  return { entries: out, unmapped: 0 }
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
async function fetchMalPlanned(): Promise<{ entries: PlannedEntry[]; unmapped: number }> {
  if (!malCredentials().accessToken) return { entries: [], unmapped: 0 }
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
  let unmapped = 0
  for (const row of rows) {
    if (row.list_status?.status !== 'plan_to_watch') continue
    const malId = row.node?.id
    if (malId === undefined) continue
    // The same resolver malSync uses for its own pushes, so a title
    // lands under exactly the id the rest of the app files it by.
    const kitsuId = await kitsuIdForExternal('mal', malId, 'background')
    if (!kitsuId) {
      unmapped += 1
      continue
    }
    out.push({
      id: `kitsu:${kitsuId}`,
      type: 'anime',
      title: row.node?.title ?? '',
      year: row.node?.start_date ? row.node.start_date.slice(0, 4) : undefined,
      source: 'mal'
    })
  }
  return { entries: out, unmapped }
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
): Promise<PlannedSyncReport> {
  const connected = {
    simkl: Boolean(simklCredentials().accessToken),
    trakt: Boolean(traktCredentials().accessToken),
    mal: Boolean(malCredentials().accessToken)
  }
  const settled = await Promise.allSettled([
    fetchSimklPlanned(priority),
    fetchTraktPlanned(priority),
    fetchMalPlanned()
  ])
  const order: PlannedSource[] = ['simkl', 'trakt', 'mal']
  const entries: PlannedEntry[] = []
  const services: PlannedServiceReport[] = []
  settled.forEach((result, index) => {
    const service = order[index]
    if (result.status === 'fulfilled') {
      entries.push(...result.value.entries)
      services.push({
        service,
        connected: connected[service],
        pulled: result.value.entries.length,
        unmapped: result.value.unmapped
      })
      return
    }
    logError('watchlists:pull', result.reason)
    services.push({
      service,
      connected: connected[service],
      pulled: 0,
      unmapped: 0,
      // The real message, not a category. "Something went wrong" is what
      // sent somebody to the logs; the service's own words are usually
      // enough to say whether it is a token, a rate limit or a typo here.
      error: (result.reason as Error)?.message || String(result.reason)
    })
  })

  const report = (added: number): PlannedSyncReport => {
    const full = { at: Date.now(), services, added }
    getDatabase().putCache(REPORT_CACHE_KEY, full, SOURCES_TTL_MS, { durable: true })
    return full
  }

  // Nothing came back at all. The sources map is deliberately NOT cleared:
  // every service being unreachable is not evidence that anybody's list is
  // empty, and wiping the tags on that basis would make an outage look
  // like somebody had deleted their watchlists.
  if (!entries.length) return report(0)

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
  return report(added)
}

/** What the last pull did, for the Settings panel that shows it. Null
 *  before one has ever run. */
export function lastPlannedSyncReport(): PlannedSyncReport | null {
  return getDatabase().getCache<PlannedSyncReport>(REPORT_CACHE_KEY, { allowExpired: true })
}

/** Whatever the last pull recorded. Expired is still worth showing: a
 *  stale tag is a better answer than none, and the next pull corrects it. */
export function plannedSources(): PlannedSources {
  return (
    getDatabase().getCache<PlannedSources>(PLANNED_SOURCES_CACHE_KEY, { allowExpired: true }) ?? {}
  )
}
