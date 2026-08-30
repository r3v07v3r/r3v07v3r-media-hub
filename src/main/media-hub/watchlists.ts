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
// IT SYNCS BOTH WAYS NOW, under the rules in docs/WATCHLIST-SYNC.md.
// Read that before changing anything here — this is the first sync in the
// app that can delete something somebody meant to keep, and the rules are
// what stop it guessing.
//
// The one that matters most: A REMOVAL ONLY PROPAGATES INWARD IF THIS APP
// SAW THE TITLE ARRIVE. Absent-from-a-service is an ambiguous state — it
// means either "you added it here and the service has not heard" or "you
// removed it there and this app has not heard", and a snapshot cannot
// tell those apart. The origins record below is what makes it answerable:
// a title this app pulled from Trakt, now gone from Trakt, was removed
// there. A title with no recorded origin was added here and is pushed
// out, never deleted.

import { getDatabase } from './dbState'
import { logError } from './logger'
import { kitsuIdForExternal } from './idBridge'
import { malRequest } from './malSync'
import { simklRequest } from './simklClient'
import { malCredentials, readSettings, simklCredentials, traktCredentials } from './settingsStore'
import { traktRequest } from './traktClient'
import { pushPlanEverywhere } from './watchlistPush'
import { plannedRemovals, type PlannedOrigin } from './watchlistRules'
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
  /** Titles removed locally because they left every service that had
   *  them — only ever titles this app had pulled in itself. */
  removed: number
}

const REPORT_CACHE_KEY = 'planned:last-sync'

/**
 * Where each pulled title came from, and when.
 *
 * The whole safety property of two-way sync rests on this. Written when a
 * pull ADDS a title, never when somebody plans one here — so its presence
 * is proof the app watched the title arrive from a service, and its
 * absence is proof it did not. A first sync against an account nobody has
 * pulled from before cannot delete anything, because nothing has an
 * origin yet.
 *
 * Durable and long-lived on purpose: it is the app's memory of what came
 * from where, and forgetting it turns a later removal into a guess.
 */
const ORIGINS_CACHE_KEY = 'planned:origins'
const ORIGINS_TTL_MS = 365 * 24 * 60 * 60 * 1000

type PlannedOrigins = Record<string, PlannedOrigin>

function plannedOrigins(): PlannedOrigins {
  return getDatabase().getCache<PlannedOrigins>(ORIGINS_CACHE_KEY, { allowExpired: true }) ?? {}
}

function writeOrigins(origins: PlannedOrigins): void {
  getDatabase().putCache(ORIGINS_CACHE_KEY, origins, ORIGINS_TTL_MS, { durable: true })
}

/** Whether the person has asked for changes here to reach the services.
 *  Off leaves the pull running and stops every write — see the doc. */
export function twoWaySyncEnabled(): boolean {
  return readSettings().watchlistTwoWay !== false
}

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

  const report = (added: number, removed = 0): PlannedSyncReport => {
    const full = { at: Date.now(), services, added, removed }
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
      rememberOrigin(entry.id, entry.source)
      added += 1
    } catch (error) {
      logError('watchlists:track', error)
    }
  }

  db.putCache(PLANNED_SOURCES_CACHE_KEY, sources, SOURCES_TTL_MS, { durable: true })

  // --- the inward half of two-way: what has LEFT the services ----------
  //
  // Only over services that actually answered. A title is absent from a
  // list this pass never successfully read in exactly the same way it is
  // absent from an empty one, and treating those alike would let an
  // outage read as "they emptied their watchlist" — see rule 5.
  const answered = new Set(
    services.filter((entry) => entry.connected && !entry.error).map((entry) => entry.service)
  )
  let removed = 0
  if (twoWaySyncEnabled() && answered.size > 0) {
    const origins = plannedOrigins()
    // The decision lives in watchlistRules, which has no database or
    // network in it and is tested directly. This half just carries it
    // out — a second copy of the reasoning here is how the tested rule
    // and the shipped behaviour drift apart.
    const doomed = plannedRemovals({
      tracked: db.tracked().map((item) => String(item.id)),
      origins,
      sources,
      answered
    })
    for (const id of doomed) {
      try {
        db.untrack(id)
        delete origins[id]
        removed += 1
      } catch (error) {
        logError('watchlists:untrack', error)
      }
    }
    // Origins for titles already gone locally are dropped too, so the
    // record does not grow a tail of entries about things nobody has.
    for (const id of Object.keys(origins)) {
      if ((sources[id] ?? []).length === 0 && !db.isTracked(id)) delete origins[id]
    }
    writeOrigins(origins)
  }

  return report(added, removed)
}

/**
 * Records that a pull put this title on the local list.
 *
 * Called only from the add loop above. Anything planned in this app has
 * no entry here, which is precisely what protects it from ever being
 * removed by a pull.
 */
function rememberOrigin(id: string, source: PlannedSource): void {
  const origins = plannedOrigins()
  if (origins[id]) return
  origins[id] = { source, addedAt: Date.now() }
  writeOrigins(origins)
}

/**
 * Sends a local plan/un-plan out to every connected service.
 *
 * Fire-and-forget from the caller's point of view: the IPC that toggles a
 * title answers immediately on the local write, because making somebody
 * wait on three third-party APIs to see a button change state is the
 * wrong trade. Failures are logged per service by the push itself.
 */
export function pushLocalPlanChange(
  item: { id: string; type: MediaKind; title: string; year?: string },
  planned: boolean
): void {
  if (!twoWaySyncEnabled()) return
  void pushPlanEverywhere(item, planned).then((outcome) => {
    // A local removal also ends this app's memory of where the title came
    // from. Keeping it would let the next pull see an origin with no
    // remote presence and "remove" something already gone — harmless, but
    // it would also resurrect the entry if the person re-planned it here.
    if (planned) return
    const origins = plannedOrigins()
    if (!origins[item.id]) return
    delete origins[item.id]
    writeOrigins(origins)
    void outcome
  })
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
