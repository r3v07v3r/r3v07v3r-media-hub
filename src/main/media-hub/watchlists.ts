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
import { notifyLibraryChanged } from './rendererBridge'
import { kitsuIdForExternal } from './idBridge'
import { malRequest } from './malSync'
import { simklRequest } from './simklClient'
import {
  malCredentials,
  readSettings,
  simklCredentials,
  traktCredentials,
  trackingAccountMarks
} from './settingsStore'
import { titlePushQueue, titlePushKey } from './titlePushQueue'
import { traktRequest } from './traktClient'
import { failedServices, firstFailure, pushPlanEverywhere, type PushOutcome } from './watchlistPush'
import {
  answeredServices,
  plannedRemovals,
  remotePlanAdoptable,
  removalEvidence,
  startedHere,
  startedTitles,
  type PlannedOrigin
} from './watchlistRules'
import { resolveAnimeGroupTarget } from './animeSeasons'
import { indexTrackedTitle } from './catalog'
import type { MediaKind } from '../../shared/media-hub/types'
import { isForegroundPriority, type TaskPriority } from './taskScheduler'

/** Which services a title is planned on. The renderer tags cards with it. */
const PLANNED_SOURCES_CACHE_KEY = 'planned:sources'

/** A day. The pull runs with the background watch sync, so this only has
 *  to outlive the gap between two of those — long enough that tags
 *  survive a restart, short enough that a list somebody emptied on the
 *  web stops being claimed here within a day. */
const SOURCES_TTL_MS = 24 * 60 * 60 * 1000

export type PlannedSource = 'simkl' | 'trakt' | 'mal'

interface PlannedEntry {
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
type PlannedSources = Record<string, PlannedSource[]>

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
  /** The list was not read this pass — see SimklListSkip. Never evidence
   *  of anything: watchlistRules' answeredServices leaves it out. */
  skipped?: boolean
}

export interface PlannedSyncReport {
  at: number
  /** When the pull began, before its first request. A caller that read
   *  something first (watchSync.ts's activity stamps) needs to know the
   *  lists were fetched after it, and a pull it merely joined may not
   *  have been. */
  startedAt?: number
  services: PlannedServiceReport[]
  /** Titles newly added to the local list by this pull. */
  added: number
  /** Titles removed locally because they left every service that had
   *  them — only ever titles this app had pulled in itself. */
  removed: number
  /** Watch-history changes (marks, un-marks) that failed to reach a service
   *  and are waiting to be retried — see historyRetry.ts. Filled in when the
   *  report is handed to the interface, not stored with it. */
  historyPending?: number
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

const ORDER: PlannedSource[] = ['simkl', 'trakt', 'mal']

type AccountMarks = Partial<Record<PlannedSource, string>>

/**
 * Which of the stored account stamps still name the account connected
 * now.
 *
 * Everything this file persists about a service is stamped with the
 * connection it was made under — see settingsStore's simklAccountMark for
 * why that is a stamp rather than a clear-on-sign-out. A service whose
 * mark has changed is treated as one this app has never read: its tags
 * are dropped and its origins can justify nothing.
 */
function trustedServices(stamped: AccountMarks | undefined): Set<PlannedSource> {
  const now = trackingAccountMarks()
  return new Set(ORDER.filter((service) => stamped?.[service] && stamped[service] === now[service]))
}

/** The tags map as stored: the map itself, plus who each service was when
 *  it was written. */
interface StoredSources {
  marks: AccountMarks
  sources: PlannedSources
}

function writeOrigins(origins: PlannedOrigins): void {
  getDatabase().putCache(ORIGINS_CACHE_KEY, origins, ORIGINS_TTL_MS, { durable: true })
}

/** Whether the person has asked for changes here to reach the services.
 *  Off leaves the pull running and stops every write — see the doc. */
function twoWaySyncEnabled(): boolean {
  return readSettings().watchlistTwoWay !== false
}

/**
 * Removals that were made here and have not reached a service yet.
 *
 * Without this, a failed remote removal quietly undoes itself: the title
 * is gone locally, the next pull still finds it on the service, and the
 * add loop puts it straight back — reversing something somebody did on
 * purpose, with no sign that anything went wrong.
 *
 * So a removal that fails is kept, retried at the start of each sync, and
 * suppresses the re-add in the meantime. Stamped per service like
 * everything else here: a queued removal belongs to the account it was
 * made against, and must never be delivered to a different one.
 */
const PENDING_CACHE_KEY = 'planned:pending-removals'
const PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** Where "keep trying" stops being honest. After this the entry is
 *  dropped and a later pull is allowed to add the title back — which is
 *  the truth of the situation: it is still on their list at the service,
 *  and pretending otherwise hides a failure rather than fixing it. */
const PENDING_MAX_ATTEMPTS = 10

interface PendingRemoval {
  item: { id: string; type: MediaKind; title: string; year?: string }
  /** The services still owed the change. Shrinks as they succeed. */
  services: PlannedSource[]
  /** True for an ADD that a service refused — the same queue, the other
   *  direction. Absent on entries written before adds were queued, which
   *  were all removals. Rule 1 says adds always propagate; before this, one
   *  that failed simply did not, with nothing to try again. */
  planned?: boolean
  attempts: number
  at: number
  marks: AccountMarks
  lastError?: string
}

type PendingRemovals = Record<string, PendingRemoval>

/** Queued removals belonging to the accounts connected right now.
 *  Anything stamped otherwise is dropped on sight. */
function pendingRemovals(): PendingRemovals {
  const stored = getDatabase().getCache<PendingRemovals>(PENDING_CACHE_KEY, { allowExpired: true })
  if (!stored) return {}
  const out: PendingRemovals = {}
  for (const [id, entry] of Object.entries(stored)) {
    const trusted = trustedServices(entry.marks)
    const services = entry.services.filter((service) => trusted.has(service))
    if (services.length) out[id] = { ...entry, services }
  }
  return out
}

function writePendingRemovals(pending: PendingRemovals): void {
  getDatabase().putCache(PENDING_CACHE_KEY, pending, PENDING_TTL_MS, { durable: true })
}

/**
 * Titles whose un-plan is still owed to a service.
 *
 * Only removals: a queued ADD is the opposite case — the title is on the
 * local list already. Read by the pull's own add loop and by the catch-up
 * (simklCatchUp.ts), neither of which may put one of these back on the
 * list: the service still holds it only because the removal has not landed
 * (docs/WATCHLIST-SYNC.md rule 6).
 */
export function idsAwaitingRemoval(): Set<string> {
  return new Set(
    Object.entries(pendingRemovals())
      .filter(([, entry]) => entry.planned !== true)
      .map(([id]) => id)
  )
}

/**
 * Ids with a viewing recorded here, and the history id a title is kept
 * under. A merged anime's later season is planned under its own Kitsu id
 * but watched under the show it belongs to, so "has it been started" has
 * to ask the show.
 */
function historyIds(): Set<string> {
  return new Set(
    getDatabase()
      .history()
      .map((entry) => String(entry.id))
  )
}

function historyIdOf(id: string): string {
  return id.startsWith('kitsu:') ? resolveAnimeGroupTarget(id).id : id
}

/**
 * Tries the queued removals again, before the pull that would otherwise
 * undo them.
 *
 * Only the services that still owe one are asked — the ones that already
 * succeeded are not re-sent, so the outcome keeps meaning what it says.
 * `onServices` carries the original evidence through, which is what keeps
 * Simkl's unscoped removal gated on the retry exactly as it was the first
 * time.
 */
async function retryPendingRemovals(): Promise<void> {
  const pending = pendingRemovals()
  const ids = Object.keys(pending)
  if (!ids.length) return
  if (!twoWaySyncEnabled()) return
  const origins = plannedOrigins()
  let touchedOrigins = false
  for (const id of ids) {
    const entry = pending[id]
    const planned = entry.planned === true
    // A removal queued before the show was started here, retried after:
    // the unscoped delete would now erase that viewing at Simkl, so it is
    // held back exactly as a fresh un-plan would be. A removal owed only to
    // Simkl then sends nothing, reports nothing failed, and is dropped as
    // settled below — which is the truth: nothing is owed that may be sent.
    const onServices = planned
      ? entry.services
      : removalEvidence(entry.services, startedHere(entry.item, historyIds(), historyIdOf))
    const outcome = await pushPlanEverywhere(entry.item, planned, {
      onServices,
      only: entry.services
    })
    // An add that got through is evidence of presence from now on, exactly
    // as it would have been had it succeeded first time.
    if (planned) rememberPushedSources(id, sentServices(outcome))
    const failed = failedServices(outcome)
    if (!failed.length) {
      delete pending[id]
      if (!planned && origins[id]) {
        delete origins[id]
        touchedOrigins = true
      }
      continue
    }
    entry.services = failed
    entry.attempts += 1
    entry.lastError = firstFailure(outcome)
    if (entry.attempts >= PENDING_MAX_ATTEMPTS) {
      logError(
        'watchlists:push-abandoned',
        new Error(
          `gave up ${planned ? 'adding' : 'removing'} ${id} ${planned ? 'at' : 'from'} ${failed.join(', ')}: ${entry.lastError ?? 'unknown'}`
        )
      )
      delete pending[id]
    }
  }
  writePendingRemovals(pending)
  if (touchedOrigins) writeOrigins(origins)
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
const STRICT = { strictBody: true } as const

async function fetchSimklPlanned(
  priority: TaskPriority
): Promise<{ entries: PlannedEntry[]; unmapped: number }> {
  if (!simklCredentials().accessToken) return { entries: [], unmapped: 0 }
  const [movies, shows, anime] = await Promise.all([
    // Strict about the body, all three. A list cut off part way would read
    // as an empty one, and an empty list from a service that answered is
    // exactly what the removal rule acts on: every title this app pulled
    // from it would be taken off the plan. It would then be recorded as
    // read, and not looked at again until Simkl's stamps moved or a day had
    // passed (watchSync.ts). Cut off, it is an error, and an error is never
    // an answer.
    simklRequest<SimklPlannedPayload>('/sync/all-items/movies/plantowatch', {}, priority, STRICT),
    simklRequest<SimklPlannedPayload>('/sync/all-items/shows/plantowatch', {}, priority, STRICT),
    simklRequest<SimklPlannedPayload>('/sync/all-items/anime/plantowatch', {}, priority, STRICT)
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
 * Why a pull is leaving Simkl's list unread.
 *
 * Simkl asks every client to read /sync/activities before any of
 * /sync/all-items, and counts requests per person rather than per device —
 * so the recurring pull goes through watchSync.ts's gate, which says one of
 * two things here:
 *
 *  - `unchanged`: Simkl's stamps are where they were when the list was last
 *    read. The counts from that read are passed back in so the report still
 *    says what the list holds, rather than "0 titles".
 *  - `unasked`: the gate itself could not be read, so nothing may be
 *    fetched behind it. Reported as the error it is.
 *
 * Either way Simkl has said NOTHING this pass. It is left out of the
 * `answered` set exactly as a failed fetch is, its tags from the last real
 * read are carried over, and so the only thing a skip can do to a removal
 * is hold it back. Only ever passed by a background caller: the Sync
 * button reads everything, always.
 */
export type SimklListSkip =
  { reason: 'unchanged'; pulled: number; unmapped: number } | { reason: 'unasked'; error: string }

export interface PlannedPullOptions {
  skipSimkl?: SimklListSkip
}

/** The pull that is running, if one is; whether somebody is waiting on it
 *  at a screen; and whether it is leaving Simkl unread — see
 *  syncPlannedFromServices. */
let plannedSyncInFlight: {
  run: Promise<PlannedSyncReport>
  foreground: boolean
  skipsSimkl: boolean
} | null = null

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
export function syncPlannedFromServices(
  priority: TaskPriority = 'background',
  options: PlannedPullOptions = {}
): Promise<PlannedSyncReport> {
  // One pull at a time. The 30-minute job, the Sync button and the catch-up
  // (simklCatchUp.ts) can all land together, and two passes interleave
  // their read-modify-writes of the origins and sources records: one
  // writes back a map the other has already changed underneath it, and
  // the evidence rule 3 depends on is lost or resurrected at random.
  const foreground = isForegroundPriority(priority)
  const skipsSimkl = Boolean(options.skipSimkl)
  const running = plannedSyncInFlight
  if (running) {
    // A caller no more urgent than the pull already running shares it —
    // provided that pull reads everything this caller wants read. One that
    // is leaving Simkl out is no answer for a caller whose gate has just
    // said Simkl moved.
    const readsEnough = !running.skipsSimkl || skipsSimkl
    if ((running.foreground || !foreground) && readsEnough) return running.run
    // The Sync button, pressed while a background pull is under way, does
    // not: that pull's requests went out before whatever was just added
    // on the web, and they are queued at a tier that stands down for
    // other work (see isForegroundPriority). So it waits for the one
    // running to finish — the passes stay one at a time — and then gets
    // a pull of its own.
    return running.run.then(
      () => syncPlannedFromServices(priority, options),
      () => syncPlannedFromServices(priority, options)
    )
  }
  const run = pullPlanned(priority, options).finally(() => {
    if (plannedSyncInFlight?.run === run) plannedSyncInFlight = null
  })
  plannedSyncInFlight = { run, foreground, skipsSimkl }
  return run
}

/** What a fetch that was not made contributes: nothing. */
const NOT_READ: { entries: PlannedEntry[]; unmapped: number } = { entries: [], unmapped: 0 }

async function pullPlanned(
  priority: TaskPriority,
  options: PlannedPullOptions
): Promise<PlannedSyncReport> {
  const startedAt = Date.now()
  // Whose list this pull is about. Everything below the fetches writes to
  // the active profile's tracked table; a switch while three services were
  // being read would pour this profile's remote lists into the next one's.
  const profile = getDatabase().activeProfile()
  // First, because the pull is what would undo them: a removal still
  // owed to a service is a title the service still lists, and the add
  // loop below would put it back.
  try {
    await retryPendingRemovals()
  } catch (error) {
    logError('watchlists:retry-removals', error)
  }
  const connected = {
    simkl: Boolean(simklCredentials().accessToken),
    trakt: Boolean(traktCredentials().accessToken),
    mal: Boolean(malCredentials().accessToken)
  }
  // Only a connected Simkl can be skipped: with no account there is no
  // list, and "not connected" is what the report should say.
  const skipSimkl = connected.simkl ? options.skipSimkl : undefined
  const settled = await Promise.allSettled([
    skipSimkl ? NOT_READ : fetchSimklPlanned(priority),
    fetchTraktPlanned(priority),
    fetchMalPlanned()
  ])
  const entries: PlannedEntry[] = []
  const services: PlannedServiceReport[] = []
  settled.forEach((result, index) => {
    // Same order as the Promise.allSettled above, which is why ORDER is
    // one shared constant rather than a literal in each place.
    const service = ORDER[index]
    if (service === 'simkl' && skipSimkl) {
      // Not read, so not an answer — `skipped` is what keeps this line out
      // of the `answered` set below. See SimklListSkip.
      services.push(
        skipSimkl.reason === 'unchanged'
          ? {
              service,
              connected: true,
              pulled: skipSimkl.pulled,
              unmapped: skipSimkl.unmapped,
              skipped: true
            }
          : {
              service,
              connected: true,
              pulled: 0,
              unmapped: 0,
              skipped: true,
              error: skipSimkl.error
            }
      )
      return
    }
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
    const full = { at: Date.now(), startedAt, services, added, removed }
    getDatabase().putCache(REPORT_CACHE_KEY, full, SOURCES_TTL_MS, { durable: true })
    return full
  }

  // --- which services are actually evidence this pass -------------------
  //
  // Computed BEFORE anything short-circuits, because "answered and empty"
  // and "did not answer" are the two states this whole feature turns on.
  // A title is absent from a list that failed to load in exactly the same
  // way it is absent from an empty one — see rule 5 — and from one that
  // was not read at all, which is why a skipped Simkl is not in this set.
  const answered = answeredServices(services)

  // Nothing answered — not "nothing is planned". The sources map is
  // deliberately NOT touched: every service being unreachable is not
  // evidence that anybody's list is empty, and wiping the tags on that
  // basis would make an outage look like somebody had deleted their
  // watchlists.
  //
  // An EMPTY answer is a different thing entirely and falls through:
  // somebody whose last remotely-planned title has just been removed
  // gets an empty list from every service, and that is the most ordinary
  // removal there is. Stopping here would mean the one case the inward
  // half exists for never ran.
  if (answered.size === 0) return report(0)
  // Before the first write, after the last wait: see `profile` above.
  if (getDatabase().activeProfile() !== profile) return report(0)

  const sources: PlannedSources = {}
  for (const entry of entries) {
    const list = sources[entry.id] ?? []
    if (!list.includes(entry.source)) list.push(entry.source)
    sources[entry.id] = list
  }
  // Tags belonging to a service that did NOT answer are carried over from
  // the last pull rather than dropped, for the same reason as above — and
  // it matters twice, because this map is also the "somebody still has
  // it" evidence the removal rule reads. Carrying a stale tag can only
  // ever hold a removal back. A Simkl skipped as unchanged lands here too,
  // and its tags are not even stale: they are the list as it still stands.
  for (const [id, list] of Object.entries(plannedSources())) {
    const kept = list.filter((service) => !answered.has(service))
    if (!kept.length) continue
    const merged = sources[id] ?? []
    for (const service of kept) if (!merged.includes(service)) merged.push(service)
    sources[id] = merged
  }

  const db = getDatabase()
  const alreadyTracked = new Set(db.tracked().map((item) => String(item.id)))
  // A title whose removal has not reached its service yet is still on the
  // service's list, so the pull finds it. Adding it back would undo, in
  // silence, something somebody did on purpose.
  // Only removals still owed suppress a re-add. A queued ADD is the opposite
  // case: the title is on the local list already, and a pull that finds it
  // at a service that did take it must be free to record that source.
  const awaitingRemoval = idsAwaitingRemoval()
  // Watched here outranks planned there — see remotePlanAdoptable.
  const history = db.history()
  const watched = new Set(history.map((entry) => String(entry.id)))
  let added = 0
  // One row per id, not per entry: a film on all three lists is one title
  // planned three times over, not three titles.
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    if (!remotePlanAdoptable(entry.id, { tracked: alreadyTracked, awaitingRemoval, watched })) {
      continue
    }
    try {
      db.track({ id: entry.id, type: entry.type, title: entry.title, year: entry.year })
      // The grids, My Stuff and the Planned row read the index by id, so a
      // pulled title the crawl never reached would be planned and shown
      // nowhere. The row has no art yet; opening the title fills it in.
      indexTrackedTitle({ id: entry.id, type: entry.type, title: entry.title, year: entry.year })
      rememberOrigin(entry.id, entry.source)
      added += 1
    } catch (error) {
      logError('watchlists:track', error)
    }
  }

  // Rule 8's other half: a title watched here and no longer on the local
  // plan keeps no removal evidence. unplanBecauseWatched cleared it; this
  // rebuild would put it back from the service's own list, and a later
  // re-plan and un-plan would then send Simkl the unscoped delete against
  // a title that has history.
  for (const id of Object.keys(sources)) {
    if (watched.has(id) && !db.isTracked(id)) delete sources[id]
  }
  const stored: StoredSources = { marks: trackingAccountMarks(), sources }
  db.putCache(PLANNED_SOURCES_CACHE_KEY, stored, SOURCES_TTL_MS, { durable: true })

  // --- the inward half of two-way: what has LEFT the services ----------
  let removed = 0
  if (twoWaySyncEnabled()) {
    const origins = plannedOrigins()
    const marks = trackingAccountMarks()
    const trackedNow = db.tracked()
    // Shows somebody has started here. Starting one is what moves it off
    // plan to watch at the service, and that is not a removal — see
    // plannedRemovals' sixth condition. Films are left out on purpose:
    // a film watched leaves the plan by rule 8.
    const started = startedTitles({
      history,
      tracked: trackedNow.map((item) => String(item.id)),
      historyIdOf
    })
    // The decision lives in watchlistRules, which has no database or
    // network in it and is tested directly. This half just carries it
    // out — a second copy of the reasoning here is how the tested rule
    // and the shipped behaviour drift apart.
    const doomed = plannedRemovals({
      tracked: trackedNow.map((item) => String(item.id)),
      origins,
      sources,
      answered,
      // Whose accounts these are right now. An origin stamped with a
      // different login is not evidence about the list in front of us.
      accounts: marks,
      started
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

  // Both the hourly pull and the Sync button land here, and neither had a
  // way to reach the Planned grid: the button's own handler shows the
  // report and nothing else. One notification covers both.
  if (added || removed) notifyLibraryChanged('planned-sync', 'planned')
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
  // Stamped with the account it arrived from, not just the service. The
  // record's whole job is to justify a deletion later, and "it came from
  // Trakt" stops being a reason the moment somebody signs into a
  // different Trakt.
  origins[id] = { source, addedAt: Date.now(), account: trackingAccountMarks()[source] }
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
  // Queued behind whatever push for the SAME title is still in flight —
  // another plan change, or its watch history (see titlePushQueue.ts). A
  // plan followed by an un-plan before the first push settled used to read
  // the evidence record ahead of the add that writes to it: the removal
  // found nothing, skipped Simkl's destructive delete for want of evidence,
  // and the add then completed and recorded a presence the next pull
  // restored locally. In order, the removal sees the add's outcome.
  void titlePushQueue.run(titlePushKey(item), () => applyPlanChange(item, planned))
}

/**
 * The same change as pushLocalPlanChange, run now rather than queued.
 *
 * Only to be called from inside a task that is already on titlePushQueue
 * for this title — the task is the place in the order, and this is the
 * work done there. Called from anywhere else it runs unordered, which is
 * the race the queue exists to close; and pushLocalPlanChange must not be
 * used from inside a task instead, since it would queue behind the very
 * task that called it (see titlePushQueue.ts).
 */
export async function applyLocalPlanChange(
  item: { id: string; type: MediaKind; title: string; year?: string },
  planned: boolean
): Promise<void> {
  if (!twoWaySyncEnabled()) return
  await applyPlanChange(item, planned)
}

/**
 * Takes a title off the plan because it has just been marked watched.
 *
 * NOT pushLocalPlanChange(item, false), and the difference is the whole
 * point (docs/WATCHLIST-SYNC.md rule 8). Two of the three services must
 * not be asked to remove it:
 *
 *  - Simkl's removal is /sync/history/remove — the un-watch endpoint — and
 *    mayRemoveAt would let it through, since the title IS on the Simkl
 *    plan list. Sent after the history push, it deletes the watch just
 *    recorded. Simkl moves a title from plan to watch to completed by
 *    itself when its history arrives, so nothing needs sending.
 *  - MAL's removal deletes the whole list entry when the status is still
 *    plan_to_watch — which is where pushMalProgress leaves it whenever the
 *    episode total is unknown. The status change IS the plan removal
 *    there, and it happens on the progress push.
 *
 * Trakt's watchlist removal is scoped and harmless, so Trakt is told. The
 * local bookkeeping is cleared regardless: a stale 'simkl' tag in the
 * sources record is exactly the evidence a later un-plan needs to fire
 * that unscoped delete against a title that now has history, and an
 * origin left standing would let the next pull "remove" it again.
 *
 * Callers run this on the same per-title chain as the history push (see
 * titlePushQueue.ts) so it cannot overtake it.
 */
export async function unplanBecauseWatched(item: {
  id: string
  type: MediaKind
  title: string
  year?: string
}): Promise<void> {
  const queued = pendingRemovals()
  if (queued[item.id]) {
    // A plan add still owed from an outage must not be retried now — it
    // would put the title back on the service it was just watched on.
    delete queued[item.id]
    writePendingRemovals(queued)
  }
  if (twoWaySyncEnabled()) {
    const onServices = plannedSources()[item.id] ?? []
    try {
      const outcome = await pushPlanEverywhere(item, false, { onServices, only: ['trakt'] })
      const failed = failedServices(outcome)
      if (failed.length) {
        const pending = pendingRemovals()
        pending[item.id] = {
          item,
          services: failed,
          attempts: 1,
          at: Date.now(),
          marks: trackingAccountMarks(),
          lastError: firstFailure(outcome)
        }
        writePendingRemovals(pending)
      }
    } catch (error) {
      logError('watchlists:unplan-watched', error)
    }
  }
  forgetPushedSources(item.id, ['simkl', 'trakt', 'mal'])
  const origins = plannedOrigins()
  if (origins[item.id]) {
    delete origins[item.id]
    writeOrigins(origins)
  }
}

const sentServices = (outcome: PushOutcome): PlannedSource[] =>
  (Object.keys(outcome) as PlannedSource[]).filter((s) => outcome[s].state === 'sent')

async function applyPlanChange(
  item: { id: string; type: MediaKind; title: string; year?: string },
  planned: boolean
): Promise<void> {
  // What is known to hold this title: the last pull's findings, plus any
  // add this app has made since (recorded below). A removal at a service
  // whose delete is not scoped to the watchlist is only sent with that
  // evidence in hand — see simklPlan, where sending it without evidence
  // would erase watch history rather than a list row.
  // A new intent replaces whatever the previous one still owed. An add
  // queued during an outage, followed by an un-plan that got through, must
  // not be retried at the next sync — that would put the title back on the
  // service and reverse the person's latest decision. Dropped before the
  // push rather than after, so nothing is owed in either direction while
  // this change is in flight; a failure below queues the new direction.
  const queued = pendingRemovals()
  if (queued[item.id]) {
    delete queued[item.id]
    writePendingRemovals(queued)
  }
  // A show with viewings recorded here never sends the unscoped removal,
  // evidence or not: at Simkl it is a bare show reference to the un-watch
  // endpoint, and would erase every episode watched there. Taking a show
  // somebody is half way through off the list means "stop showing me
  // this", not "forget I watched it" — see removalEvidence.
  const onServices = planned
    ? []
    : removalEvidence(plannedSources()[item.id] ?? [], startedHere(item, historyIds(), historyIdOf))
  const outcome = await pushPlanEverywhere(item, planned, { onServices })
  if (planned) {
    // An add this app made IS evidence the title is on those services —
    // the same evidence a pull records. Without writing it down, a title
    // planned and un-planned again before the next pull had no record of
    // ever reaching Simkl, so the removal there was skipped for lack of
    // it, and the next pull found the title still on Simkl's list and
    // quietly planned it here again.
    rememberPushedSources(item.id, sentServices(outcome))
    // A service that refused the add is owed it, the same way one that
    // refused a removal is. Queued and retried at the next sync rather than
    // dropped — dropping it made "adds always propagate" untrue the first
    // time a service was down.
    const failedAdd = failedServices(outcome)
    if (failedAdd.length) {
      const pending = pendingRemovals()
      pending[item.id] = {
        item,
        services: failedAdd,
        planned: true,
        attempts: 1,
        at: Date.now(),
        marks: trackingAccountMarks(),
        lastError: firstFailure(outcome)
      }
      writePendingRemovals(pending)
    }
    return
  }
  // The mirror image: a removal that went out is no longer evidence of a
  // presence. Left standing, a later un-plan whose re-plan had failed at
  // Simkl would send the unscoped delete on the strength of a list entry
  // that is not there — the one request this whole record exists to hold
  // back.
  forgetPushedSources(item.id, sentServices(outcome))
  const failed = failedServices(outcome)
  if (failed.length) {
    // Kept, retried at the next sync, and suppressing the re-add until
    // then. The origin stays too: it is still true that this title came
    // from that service, and it is what the retry's success will clear.
    const pending = pendingRemovals()
    pending[item.id] = {
      item,
      services: failed,
      attempts: 1,
      at: Date.now(),
      marks: trackingAccountMarks(),
      lastError: firstFailure(outcome)
    }
    writePendingRemovals(pending)
    return
  }
  // Nothing left owed, so this app's memory of where the title came
  // from ends here. Keeping it would let the next pull see an origin
  // with no remote presence and "remove" something already gone —
  // harmless, but it would also resurrect the entry if the person
  // re-planned it here.
  const origins = plannedOrigins()
  if (!origins[item.id]) return
  delete origins[item.id]
  writeOrigins(origins)
}

/** What the last pull did, for the Settings panel that shows it. Null
 *  before one has ever run. */
export function lastPlannedSyncReport(): PlannedSyncReport | null {
  return getDatabase().getCache<PlannedSyncReport>(REPORT_CACHE_KEY, { allowExpired: true })
}

/**
 * Adds services this app itself just planned a title at to the sources
 * record, under the account marks in force now — see pushLocalPlanChange.
 * Merged into whatever the last pull wrote rather than replacing it, and
 * only ever added to: the pull remains the authority on what has LEFT.
 */
function rememberPushedSources(id: string, services: PlannedSource[]): void {
  if (!services.length) return
  const sources = { ...plannedSources() }
  const merged = new Set(sources[id] ?? [])
  for (const service of services) merged.add(service)
  sources[id] = [...merged]
  writeSources(sources)
}

/** The reverse of rememberPushedSources, for a removal that went out. */
function forgetPushedSources(id: string, services: PlannedSource[]): void {
  if (!services.length) return
  const sources = { ...plannedSources() }
  const remaining = (sources[id] ?? []).filter((s) => !services.includes(s))
  if (remaining.length) sources[id] = remaining
  else delete sources[id]
  writeSources(sources)
}

function writeSources(sources: PlannedSources): void {
  const stored: StoredSources = { marks: trackingAccountMarks(), sources }
  getDatabase().putCache(PLANNED_SOURCES_CACHE_KEY, stored, SOURCES_TTL_MS, { durable: true })
}

/** Whatever the last pull recorded. Expired is still worth showing: a
 *  stale tag is a better answer than none, and the next pull corrects it. */
export function plannedSources(): PlannedSources {
  const stored = getDatabase().getCache<StoredSources>(PLANNED_SOURCES_CACHE_KEY, {
    allowExpired: true
  })
  // The unstamped shape written by earlier versions is discarded rather
  // than read: it cannot say which account its tags belong to, and the
  // next pull rewrites it within the minute.
  if (!stored?.sources) return {}
  const trusted = trustedServices(stored.marks)
  const out: PlannedSources = {}
  for (const [id, list] of Object.entries(stored.sources)) {
    // A tag from an account nobody is signed into any more is not this
    // person's tag. Dropping it costs a badge until the next pull;
    // showing it tells somebody their list is on an account it is not.
    const kept = list.filter((service) => trusted.has(service))
    if (kept.length) out[id] = kept
  }
  return out
}
