// Watched episodes, show by show, against each service's whole set.
//
// Progress on a show is a set of watched episodes here (watch_history rows),
// and the same at Simkl and Trakt. The pulls (the Simkl catch-up and the
// Trakt history pull) only ever add, so after them every episode a service
// had told this app about is held here too. What they cannot see is the
// other half: an episode held here that a service does not have, because a
// push failed for good, the service was connected after the episode was
// marked, or it was marked on a device that never told that service. Nor
// can anybody see what a pull took in, show by show, to take it back out.
//
// This module is both halves:
//
//  - The comparison (compareEpisodeSets). After the pulls, for a service
//    whose activity stamp moved since the last comparison, the service's
//    whole watched set is read once and compared per show with the set held
//    here. Episodes here that the service lacks are sent to it, on the
//    title's own push chain, so a failure is kept and retried like any
//    history push (historyRetry.ts). Episodes only the service holds are
//    already here after the pulls, with one exception: the first comparison
//    against a Trakt account takes in what Trakt holds for the shows held
//    here, since the Trakt pull starts from the moment it first runs. It
//    never removes anything, anywhere (rules 1 and 4 of
//    docs/WATCHLIST-SYNC.md), and a read that failed or came back cut off
//    writes nothing and records nothing (rule 5).
//  - The record of what was merged (noteMerge), per show and per service:
//    what arrived from the service (written by the pulls as well), what was
//    sent to it, and what could not be sent. The desktop's review panel
//    lists it, and its choices (decideShow) are the only way an episode is
//    removed at a service: always by exact episodes, never a bare show
//    reference (rule 3), queued in the same durable record as a failed
//    history push and sent with it.
//
// The record is a catalog_cache entry per profile, like reconcile:pending:v2,
// with each service's part stamped with the account it was made under (rule
// 7). Free of Electron, with its reads and sends handed in, so
// tests/episodeSync.test.ts drives it against a real temporary database.

import type { ImportedPlay, MediaKind } from '../../shared/media-hub/types'
import type { MediaHubDatabase } from './database'
import {
  historyPushKey,
  watchKeyOf,
  type HistoryService,
  type PendingHistoryPush,
  type PendingHistoryPushes
} from './historyRetry'
import { parseSimklLibrary, type SimklLibraryTitle } from './simklCatchUpRules'

export type EpisodeService = 'simkl' | 'trakt'
export const EPISODE_SERVICES: readonly EpisodeService[] = ['simkl', 'trakt']

export interface Ep {
  season: number
  episode: number
}

/** A show as the record keeps it: enough to name it to a service again. */
export interface SyncShow {
  id: string
  type: 'series' | 'anime'
  title: string
  year?: string
}

const DAY = 24 * 60 * 60 * 1000

/** How long a show stays in the record after the last pass that added to it. */
export const SHOW_SYNC_TTL_MS = 90 * DAY
/** An episode marked here this recently may still have its own push on the
 *  way. Sending it again could land a second play at Trakt, so the
 *  comparison leaves it for the next one. */
export const RECENT_LOCAL_MS = 15 * 60 * 1000
/** The most shows one comparison sends episodes to per service. Each is a
 *  request, and Simkl allows an account 500 a day across every device. The
 *  rest are sent by the next comparison, which the sends themselves cause
 *  (they move the service's activity stamp). */
export const MAX_SENT_SHOWS = 20

function epKey(ep: Ep): string {
  return `${ep.season}:${ep.episode}`
}

function isCount(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min
}

function sortEps(eps: Iterable<Ep>): Ep[] {
  const seen = new Map<string, Ep>()
  for (const ep of eps) seen.set(epKey(ep), { season: ep.season, episode: ep.episode })
  return [...seen.values()].sort((a, b) => a.season - b.season || a.episode - b.episode)
}

function union(a: readonly Ep[], b: readonly Ep[]): Ep[] {
  return sortEps([...a, ...b])
}

function without(a: readonly Ep[], b: readonly Ep[]): Ep[] {
  const drop = new Set(b.map(epKey))
  return a.filter((ep) => !drop.has(epKey(ep)))
}

/** The seasons a list of episodes touches, in order. */
export function seasonsOf(eps: readonly Ep[]): number[] {
  return [...new Set(eps.map((ep) => ep.season))].sort((a, b) => a - b)
}

/**
 * One show's two sets compared: the episodes only held here, and the ones
 * only the service holds. Nothing else is a difference — the set is the
 * progress, and "the episode I am on" is worked out from it.
 */
export function showEpisodeDiff(
  local: readonly Ep[],
  remote: readonly Ep[]
): { localOnly: Ep[]; remoteOnly: Ep[] } {
  const here = new Set(local.map(epKey))
  const there = new Set(remote.map(epKey))
  return {
    localOnly: sortEps(local.filter((ep) => !there.has(epKey(ep)))),
    remoteOnly: sortEps(remote.filter((ep) => !here.has(epKey(ep))))
  }
}

// ---------------------------------------------------------------------------
// The record of what was merged.

/** One service's side of a show's row, made under one account. */
export interface ShowSyncPart {
  /** settingsStore's account mark for the service when written. */
  mark: string
  arrived: Ep[]
  sent: Ep[]
  unsendable: Ep[]
}

export interface ShowSyncEntry extends SyncShow {
  /** When a pass last added to this entry. */
  at: number
  parts: Partial<Record<EpisodeService, ShowSyncPart>>
}

export interface ShowSyncRecord {
  entries: Record<string, ShowSyncEntry>
  /** Per service, account and show: the unsendable set last raised. The
   *  same set found again does not bring a reviewed row back. */
  quiet: Record<string, string>
}

export function showSyncKey(profile: string): string {
  return `episode-sync:merged:v1:${profile}`
}

function emptyRecord(): ShowSyncRecord {
  return { entries: {}, quiet: {} }
}

function epsFrom(value: unknown): Ep[] {
  if (!Array.isArray(value)) return []
  return sortEps(
    value.filter(
      (ep): ep is Ep =>
        Boolean(ep) && isCount((ep as Ep).season, 0) && isCount((ep as Ep).episode, 1)
    )
  )
}

/** A stored record, with anything malformed left out. */
function normalizeRecord(stored: unknown): ShowSyncRecord {
  const record = emptyRecord()
  if (!stored || typeof stored !== 'object') return record
  const value = stored as Partial<ShowSyncRecord>
  for (const [id, raw] of Object.entries(value.entries ?? {})) {
    if (!raw || typeof raw !== 'object' || raw.id !== id) continue
    if (raw.type !== 'series' && raw.type !== 'anime') continue
    const parts: ShowSyncEntry['parts'] = {}
    for (const service of EPISODE_SERVICES) {
      const part = raw.parts?.[service]
      if (!part || typeof part.mark !== 'string' || !part.mark) continue
      parts[service] = {
        mark: part.mark,
        arrived: epsFrom(part.arrived),
        sent: epsFrom(part.sent),
        unsendable: epsFrom(part.unsendable)
      }
    }
    if (!Object.keys(parts).length) continue
    record.entries[id] = {
      id,
      type: raw.type,
      title: typeof raw.title === 'string' ? raw.title : id,
      ...(typeof raw.year === 'string' && raw.year ? { year: raw.year } : {}),
      at: typeof raw.at === 'number' ? raw.at : 0,
      parts
    }
  }
  for (const [key, quiet] of Object.entries(value.quiet ?? {})) {
    if (typeof quiet === 'string') record.quiet[key] = quiet
  }
  return record
}

/** The stored record for a profile. */
export function readShowSync(
  db: Pick<MediaHubDatabase, 'getCache'>,
  profile: string
): ShowSyncRecord {
  return normalizeRecord(db.getCache<unknown>(showSyncKey(profile), { allowExpired: true }))
}

/**
 * Writes the record back and says whether it stuck. Durable: a choice is
 * acted on only once the record saying it was made exists, as with
 * reconcile:pending:v2 (tracking.ts's writePendingPushes).
 */
export function writeShowSync(
  db: Pick<MediaHubDatabase, 'getCache' | 'putCache'>,
  profile: string,
  record: ShowSyncRecord
): boolean {
  db.putCache(showSyncKey(profile), record, SHOW_SYNC_TTL_MS, { durable: true })
  return JSON.stringify(readShowSync(db, profile)) === JSON.stringify(normalizeRecord(record))
}

/** What one pass did for one show at one service. */
export interface MergeNote {
  service: EpisodeService
  mark: string
  show: SyncShow
  arrived?: readonly Ep[]
  sent?: readonly Ep[]
  /** The full set of episodes that cannot be sent, as of this pass. Left
   *  out, what the record holds is kept. */
  unsendable?: readonly Ep[]
}

function quietKey(service: EpisodeService, mark: string, id: string): string {
  return `${service}|${mark}|${id}`
}

/**
 * Adds one pass's findings to the record. Arrivals and sends add to what the
 * row already holds; the unsendable set replaces it. A part made under
 * another account is replaced, never added to. A show gets a row (or its row
 * comes back) only for something new: an arrival, a send, or an unsendable
 * set different from the one last raised.
 */
export function noteMerge(record: ShowSyncRecord, note: MergeNote, now: number): ShowSyncRecord {
  const entries = { ...record.entries }
  const quiet = { ...record.quiet }
  const existing = entries[note.show.id]
  const prev = existing?.parts[note.service]
  const base: ShowSyncPart =
    prev && prev.mark === note.mark
      ? prev
      : { mark: note.mark, arrived: [], sent: [], unsendable: [] }
  let raise = Boolean(note.arrived?.length || note.sent?.length)
  let unsendable = base.unsendable
  if (note.unsendable) {
    const key = quietKey(note.service, note.mark, note.show.id)
    const sorted = sortEps(note.unsendable)
    const signature = sorted.map(epKey).join(',')
    if (!signature) delete quiet[key]
    else if (quiet[key] !== signature) raise = true
    if (signature) quiet[key] = signature
    unsendable = sorted
  }
  if (!raise && !(prev && prev.mark === note.mark)) return { entries, quiet }
  const part: ShowSyncPart = {
    mark: note.mark,
    arrived: union(base.arrived, note.arrived ?? []),
    sent: union(base.sent, note.sent ?? []),
    unsendable
  }
  const parts = { ...(existing?.parts ?? {}) }
  if (part.arrived.length || part.sent.length || part.unsendable.length) {
    parts[note.service] = part
  } else {
    delete parts[note.service]
  }
  if (!Object.keys(parts).length) {
    delete entries[note.show.id]
    return { entries, quiet }
  }
  entries[note.show.id] = {
    id: note.show.id,
    type: note.show.type,
    title: note.show.title || existing?.title || note.show.id,
    ...((note.show.year ?? existing?.year) ? { year: note.show.year ?? existing?.year } : {}),
    at: raise ? now : (existing?.at ?? now),
    parts
  }
  return { entries, quiet }
}

/** The rows that belong to the accounts connected now, newest first. A part
 *  made under another account is inert (rule 7) and left out. */
export function liveShowSync(
  record: ShowSyncRecord,
  marks: Readonly<Record<EpisodeService, string>>
): ShowSyncEntry[] {
  const live: ShowSyncEntry[] = []
  for (const entry of Object.values(record.entries)) {
    const parts: ShowSyncEntry['parts'] = {}
    for (const service of EPISODE_SERVICES) {
      const part = entry.parts[service]
      if (part && marks[service] && part.mark === marks[service]) parts[service] = part
    }
    if (Object.keys(parts).length) live.push({ ...entry, parts })
  }
  return live.sort((a, b) => b.at - a.at || a.title.localeCompare(b.title))
}

/** Takes a show's row out, or one service's part of it. */
export function dismissShow(
  record: ShowSyncRecord,
  id: string,
  service?: EpisodeService
): ShowSyncRecord {
  const entries = { ...record.entries }
  const entry = entries[id]
  if (!entry) return record
  if (service) {
    const parts = { ...entry.parts }
    delete parts[service]
    if (Object.keys(parts).length) entries[id] = { ...entry, parts }
    else delete entries[id]
  } else {
    delete entries[id]
  }
  return { entries, quiet: record.quiet }
}

/** History rows a pull wrote, noted as arrivals from `service`. Films and
 *  rows with no episode are not part of this record. */
export function noteArrivals(
  record: ShowSyncRecord,
  service: EpisodeService,
  mark: string,
  rows: readonly ImportedPlay[],
  now: number
): ShowSyncRecord {
  if (!mark) return record
  const byShow = new Map<string, { show: SyncShow; eps: Ep[] }>()
  for (const row of rows) {
    if (row.type !== 'series' && row.type !== 'anime') continue
    if (!isCount(row.season, 0) || !isCount(row.episode, 1)) continue
    const group = byShow.get(row.id) ?? {
      show: {
        id: row.id,
        type: row.type,
        title: row.title,
        ...(row.year ? { year: String(row.year) } : {})
      },
      eps: []
    }
    group.eps.push({ season: row.season, episode: row.episode })
    byShow.set(row.id, group)
  }
  let next = record
  for (const { show, eps } of byShow.values()) {
    next = noteMerge(next, { service, mark, show, arrived: eps }, now)
  }
  return next
}

// ---------------------------------------------------------------------------
// Reading a service's whole set.

/** Where each comparison reads from. Simkl keeps shows and anime apart, each
 *  with its own activity stamp, so each is read only when its own moved. */
export type EpisodeSource = 'simkl-shows' | 'simkl-anime' | 'trakt-shows'
export const EPISODE_SOURCES: readonly EpisodeSource[] = [
  'simkl-shows',
  'simkl-anime',
  'trakt-shows'
]
export const SOURCE_SERVICE: Record<EpisodeSource, EpisodeService> = {
  'simkl-shows': 'simkl',
  'simkl-anime': 'simkl',
  'trakt-shows': 'trakt'
}
/** Whether a first comparison takes in what only the service holds. Only
 *  Trakt's: the Simkl catch-up reads each kind whole the first time, while
 *  the Trakt pull starts from the moment it first runs. */
/** The least time between two reads of a source once it has been compared
 *  under an account, however often its stamp moves. Simkl's stamp moves with
 *  every episode pushed from here, its whole lists are the largest reads
 *  this app makes, and its allowance is shared with a linked phone; what a
 *  pass in between would find (a push that failed) is retried anyway. */
const MIN_INTERVAL_MS: Record<EpisodeSource, number> = {
  'simkl-shows': 6 * 60 * 60 * 1000,
  'simkl-anime': 6 * 60 * 60 * 1000,
  'trakt-shows': 0
}
const TAKES_IN_ON_FIRST: Record<EpisodeSource, boolean> = {
  'simkl-shows': false,
  'simkl-anime': false,
  'trakt-shows': true
}

export interface RemoteShow {
  show: SyncShow
  /** `season:episode` -> when the service says it was watched. */
  episodes: Map<string, string>
}

export interface RemoteRead {
  /** Every show the service holds that this read could place, by local id. */
  shows: Map<string, RemoteShow>
  /** Whether this read speaks for a local show at all. A show it does not
   *  cover is not compared: its absence from `shows` says nothing. */
  covers(row: { id: string; type: MediaKind; season: number }): boolean
}

function addEpisode(
  shows: Map<string, RemoteShow>,
  show: SyncShow,
  ep: Ep,
  watchedAt: string
): void {
  const entry = shows.get(show.id) ?? { show, episodes: new Map<string, string>() }
  const key = epKey(ep)
  const held = entry.episodes.get(key)
  if (!held || Date.parse(watchedAt) > Date.parse(held)) entry.episodes.set(key, watchedAt)
  shows.set(show.id, entry)
}

const IMDB = /^tt\d+$/

function parsesAsDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

/** Simkl's shows/all, as a read. Anime arrives through its own list. */
export function simklShowsRead(payload: unknown): RemoteRead {
  const shows = new Map<string, RemoteShow>()
  for (const title of parseSimklLibrary({ shows: payload }).titles) {
    if (title.kind !== 'show' || !title.imdb) continue
    const show: SyncShow = {
      id: title.imdb,
      type: 'series',
      title: title.title,
      ...(title.year ? { year: title.year } : {})
    }
    for (const ep of title.episodes) {
      if (ep.season === null) continue
      addEpisode(shows, show, { season: ep.season, episode: ep.episode }, ep.watchedAt)
    }
  }
  return {
    shows,
    covers: (row) => row.type === 'series' && IMDB.test(row.id)
  }
}

/**
 * Where one Simkl anime entry is kept here:
 *  - `placed`: under this show, at this season;
 *  - `mismatched`: a member of a merged show whose place in the group cannot
 *    be shown to be its season on the page — the ids named are not compared
 *    at all, rather than compared by position;
 *  - `none`: nothing here can be this entry;
 *  - `unanswered`: nobody could be asked, and the read is incomplete.
 */
export type AnimePlace =
  | { kind: 'placed'; id: string; season: number }
  | { kind: 'mismatched'; ids: string[] }
  | { kind: 'none' }
  | { kind: 'unanswered' }

/** Simkl anime kinds that are not episodes of a show here. */
const NOT_EPISODIC = new Set(['movie', 'music video'])

/**
 * Simkl's anime list, as a read. Each entry is one season at Simkl and is
 * placed by `place` (the wiring asks animeSeasons.ts's laterSeasonOf, never
 * a position). An entry that cannot be placed because nobody answered makes
 * the read incomplete, and it throws: rule 5.
 */
export async function simklAnimeRead(
  payload: unknown,
  place: (title: SimklLibraryTitle) => Promise<AnimePlace>
): Promise<RemoteRead> {
  const shows = new Map<string, RemoteShow>()
  const skipped = new Set<string>()
  for (const title of parseSimklLibrary({ anime: payload }).titles) {
    if (title.kind !== 'anime' || NOT_EPISODIC.has(title.animeType ?? '')) continue
    const where = await place(title)
    if (where.kind === 'unanswered') {
      throw new Error('An anime entry at Simkl could not be looked up; nothing was compared.')
    }
    if (where.kind === 'mismatched') {
      for (const id of where.ids) skipped.add(id)
      continue
    }
    if (where.kind === 'none') continue
    const show: SyncShow = { id: where.id, type: 'anime', title: title.title }
    for (const ep of title.episodes) {
      // An entry is one season; a block it numbers past its first is not
      // one this app can place (the catch-up refuses it the same way).
      if (ep.season !== null && ep.season !== 1) continue
      addEpisode(shows, show, { season: where.season, episode: ep.episode }, ep.watchedAt)
    }
  }
  for (const id of skipped) shows.delete(id)
  return {
    shows,
    covers: (row) =>
      row.type === 'anime' && row.id.startsWith('kitsu:') && row.season >= 1 && !skipped.has(row.id)
  }
}

/**
 * Trakt's /sync/watched/shows, as a read: per show, every season and
 * episode with its last watched time. Not a list is not an answer (a body
 * cut off reads as `{}`), and throws. Anime is not compared at Trakt: this
 * app never sends anime there (trakt.ts), and Trakt files an anime under an
 * IMDb series this app keeps under a Kitsu id.
 */
export function traktShowsRead(payload: unknown): RemoteRead {
  if (!Array.isArray(payload)) throw new Error('Trakt answered without a list of shows.')
  const shows = new Map<string, RemoteShow>()
  for (const raw of payload) {
    const entry = (raw ?? {}) as {
      show?: { title?: unknown; year?: unknown; ids?: { imdb?: unknown } }
      seasons?: Array<{
        number?: unknown
        episodes?: Array<{ number?: unknown; last_watched_at?: unknown }>
      }>
    }
    const imdb = entry.show?.ids?.imdb
    if (typeof imdb !== 'string' || !IMDB.test(imdb)) continue
    const year = entry.show?.year
    const show: SyncShow = {
      id: imdb,
      type: 'series',
      title: typeof entry.show?.title === 'string' ? entry.show.title : imdb,
      ...(typeof year === 'number' || typeof year === 'string' ? { year: String(year) } : {})
    }
    for (const season of Array.isArray(entry.seasons) ? entry.seasons : []) {
      if (!isCount(season?.number, 0)) continue
      for (const ep of Array.isArray(season.episodes) ? season.episodes : []) {
        if (!isCount(ep?.number, 1) || !parsesAsDate(ep.last_watched_at)) continue
        addEpisode(
          shows,
          show,
          { season: season.number as number, episode: ep.number as number },
          ep.last_watched_at
        )
      }
    }
  }
  return {
    shows,
    covers: (row) => row.type === 'series' && IMDB.test(row.id)
  }
}

// ---------------------------------------------------------------------------
// The comparison.

/** Per source: the account and stamp the last complete comparison was made
 *  under. A source is read again only when one of the two differs. */
export type CompareState = Partial<
  Record<EpisodeSource, { mark: string; stamp: string; at: number }>
>

export function comparedKey(profile: string): string {
  return `episode-sync:compared:v1:${profile}`
}

const COMPARED_TTL_MS = 400 * DAY

function readCompareState(db: Pick<MediaHubDatabase, 'getCache'>, profile: string): CompareState {
  const stored = db.getCache<CompareState>(comparedKey(profile), { allowExpired: true })
  const state: CompareState = {}
  if (!stored || typeof stored !== 'object') return state
  for (const source of EPISODE_SOURCES) {
    const value = stored[source]
    if (value && typeof value.mark === 'string' && typeof value.stamp === 'string') {
      state[source] = {
        mark: value.mark,
        stamp: value.stamp,
        at: typeof value.at === 'number' ? value.at : 0
      }
    }
  }
  return state
}

export interface CompareDeps {
  db: Pick<
    MediaHubDatabase,
    'activeProfile' | 'getCache' | 'putCache' | 'history' | 'importWatched'
  >
  /** settingsStore's account marks. Empty is "not connected". */
  marks(): Readonly<Record<EpisodeService, string>>
  /** The source's activity stamp as the pass that just ran read it, or null
   *  when it was not read (the source is then left alone). */
  stamp(source: EpisodeSource): string | null
  /** The service's whole set. Throws on a failure or a partial answer. */
  read(source: EpisodeSource): Promise<RemoteRead>
  /** History keys (watchKeyOf) with a change owed to the service or on its
   *  way there. Not counted against it either way: the retry sends them. */
  pending(service: EpisodeService): ReadonlySet<string>
  /** Whether an episode of a show can be named to the service at all. */
  canSend(service: EpisodeService, show: SyncShow, ep: Ep): boolean
  /** Sends the episodes to the service as an add, on the title's chain. */
  send(service: EpisodeService, show: SyncShow, eps: Ep[]): void
  /** The backup before history rows are written (autoBackup.ts). */
  backup(): void
  announce(): void
  now(): number
  log(scope: string, error: unknown): void
}

export interface CompareReport {
  compared: EpisodeSource[]
  /** Episodes taken in here. */
  added: number
  /** Episodes sent to services. */
  sent: number
}

interface LocalShow {
  show: SyncShow
  eps: Map<string, { ep: Ep; watchedAt: string | null }>
}

/**
 * One comparison of every source whose stamp moved since the last. Never
 * throws; a source that fails is logged, writes nothing and records nothing,
 * and is read again next time.
 */
export async function compareEpisodeSets(deps: CompareDeps): Promise<CompareReport> {
  const { db } = deps
  const profile = db.activeProfile()
  const report: CompareReport = { compared: [], added: 0, sent: 0 }
  for (const source of EPISODE_SOURCES) {
    const service = SOURCE_SERVICE[source]
    const mark = deps.marks()[service]
    if (!mark) continue
    const stamp = deps.stamp(source)
    if (stamp === null) continue
    const last = readCompareState(db, profile)[source]
    if (last && last.mark === mark) {
      if (last.stamp === stamp) continue
      if (deps.now() - last.at < MIN_INTERVAL_MS[source]) continue
    }
    const first = !last || last.mark !== mark

    let read: RemoteRead
    try {
      read = await deps.read(source)
    } catch (error) {
      deps.log(`episode-sync:${source}`, error)
      continue
    }
    // Whose history and whose account, checked after the wait as every pull
    // here does.
    if (db.activeProfile() !== profile) return report
    if (deps.marks()[service] !== mark) continue

    const now = deps.now()
    const pending = deps.pending(service)
    const local = new Map<string, LocalShow>()
    for (const row of db.history()) {
      if (row.type !== 'series' && row.type !== 'anime') continue
      if (!isCount(row.season, 0) || !isCount(row.episode, 1)) continue
      const id = String(row.id)
      if (!read.covers({ id, type: row.type, season: row.season })) continue
      const group: LocalShow = local.get(id) ?? {
        show: {
          id,
          type: row.type,
          title: String(row.title ?? id),
          ...(row.year ? { year: String(row.year) } : {})
        },
        eps: new Map()
      }
      const ep = { season: row.season, episode: row.episode }
      group.eps.set(epKey(ep), { ep, watchedAt: row.watchedAt })
      local.set(id, group)
    }

    let record = readShowSync(db, profile)
    const before = JSON.stringify(record)
    const imports: ImportedPlay[] = []
    const sends: Array<{ show: SyncShow; eps: Ep[] }> = []
    let leftOver = false
    for (const [id, here] of local) {
      const there = read.shows.get(id)
      const remote = there?.episodes ?? new Map<string, string>()
      // What this app saw arrive from the service and is gone from it now
      // was removed there. Sending it back would undo that; removing it here
      // is a choice the panel offers, not something done unasked.
      const fromThere = new Set(
        (record.entries[id]?.parts[service]?.mark === mark
          ? record.entries[id].parts[service]!.arrived
          : []
        ).map(epKey)
      )
      if (first && TAKES_IN_ON_FIRST[source] && there) {
        for (const [key, watchedAt] of remote) {
          if (here.eps.has(key)) continue
          const [season, episode] = key.split(':').map(Number)
          if (pending.has(watchKeyOf(id, season, episode))) continue
          imports.push({
            id,
            type: here.show.type,
            title: here.show.title,
            ...(here.show.year ? { year: here.show.year } : {}),
            season,
            episode,
            watchedAt
          })
        }
      }
      const localOnly: Ep[] = []
      for (const { ep, watchedAt } of here.eps.values()) {
        const key = epKey(ep)
        if (remote.has(key) || fromThere.has(key)) continue
        if (pending.has(watchKeyOf(id, ep.season, ep.episode))) continue
        const at = watchedAt ? Date.parse(watchedAt) : NaN
        if (Number.isFinite(at) && now - at < RECENT_LOCAL_MS) continue
        localOnly.push(ep)
      }
      const sendable = sortEps(localOnly.filter((ep) => deps.canSend(service, here.show, ep)))
      const unsendable = without(sortEps(localOnly), sendable)
      let sent: Ep[] = []
      if (sendable.length) {
        if (sends.length < MAX_SENT_SHOWS) {
          sends.push({ show: here.show, eps: sendable })
          sent = sendable
        } else {
          leftOver = true
        }
      }
      record = noteMerge(record, { service, mark, show: here.show, sent, unsendable }, now)
    }

    if (imports.length) {
      deps.backup()
      try {
        report.added += db.importWatched(imports)
      } catch (error) {
        // Nothing landed: nothing is recorded as having arrived, and the
        // stamp is left so the next pass tries again.
        deps.log(`episode-sync:${source}:write`, error)
        continue
      }
      record = noteArrivals(record, service, mark, imports, now)
    }
    if (JSON.stringify(record) !== before) writeShowSync(db, profile, record)
    for (const { show, eps } of sends) {
      deps.send(service, show, eps)
      report.sent += eps.length
    }
    if (!leftOver) {
      const state = readCompareState(db, profile)
      state[source] = { mark, stamp, at: now }
      db.putCache(comparedKey(profile), state, COMPARED_TTL_MS, { durable: true })
    }
    report.compared.push(source)
  }
  if (report.added) deps.announce()
  return report
}

// ---------------------------------------------------------------------------
// The panel's choices.

export type ShowAction = 'keep' | 'undo' | 'service-match-here' | 'here-match-service'

export interface ShowPush {
  service: HistoryService
  action: 'add' | 'remove'
  episodes: Ep[]
}

export interface ShowDecisionPlan {
  /** Episodes removed here. */
  removeHere: Ep[]
  /** Exact episodes per service and direction. */
  pushes: ShowPush[]
  /** What a service was meant to be told and cannot be. */
  cannotSend: Array<{ service: EpisodeService; episodes: Ep[] }>
}

export interface DecisionContext {
  /** `season:episode` keys of this show held here now. */
  held: ReadonlySet<string>
  /** Which services are connected now. */
  connected: Readonly<Record<HistoryService, boolean>>
  canSend(service: EpisodeService, ep: Ep): boolean
}

/**
 * What one choice does, as exact episodes. Every removal at a service is of
 * an episode not held here once the choice is made, and every add of one
 * that is; that is also what keeps a queued change valid in historyRetry.ts.
 *
 *  - undo: what arrived from each service is removed here, at the service
 *    it came from, and at any service the comparison passed it on to.
 *  - service-match-here: the service ends up with the set held here before
 *    it was merged: what arrived from it is removed here and there (and
 *    where it was passed on), and what it lacked is sent again.
 *  - here-match-service: this app ends up with the service's set: what was
 *    held here and not there is removed here, taken back from the service
 *    where the comparison sent it, and removed at the other services too;
 *    what arrived from the service is sent on to the others (rule 1).
 */
export function planShowDecision(
  entry: ShowSyncEntry,
  action: ShowAction,
  service: EpisodeService | undefined,
  ctx: DecisionContext
): ShowDecisionPlan {
  const plan: ShowDecisionPlan = { removeHere: [], pushes: [], cannotSend: [] }
  if (action === 'keep') return plan
  const isHeld = (ep: Ep): boolean => ctx.held.has(epKey(ep))
  const part = (s: EpisodeService): ShowSyncPart | undefined => entry.parts[s]
  const toServices = new Map<string, Ep[]>()
  const unreachable = new Map<EpisodeService, Ep[]>()
  const owe = (s: EpisodeService, direction: 'add' | 'remove', eps: readonly Ep[]): void => {
    if (!eps.length || !ctx.connected[s]) return
    const ok = eps.filter((ep) => ctx.canSend(s, ep))
    const blocked = without(eps, ok)
    if (blocked.length) unreachable.set(s, union(unreachable.get(s) ?? [], blocked))
    if (!ok.length) return
    const key = `${s}|${direction}`
    toServices.set(key, union(toServices.get(key) ?? [], ok))
  }
  /** Removes what arrived from `from` here, there, and wherever it was
   *  passed on to. */
  const takeBack = (from: EpisodeService): void => {
    const arrived = (part(from)?.arrived ?? []).filter(isHeld)
    if (!arrived.length) return
    plan.removeHere = union(plan.removeHere, arrived)
    owe(from, 'remove', arrived)
    for (const other of EPISODE_SERVICES) {
      if (other === from) continue
      const passedOn = new Set((part(other)?.sent ?? []).map(epKey))
      owe(
        other,
        'remove',
        arrived.filter((ep) => passedOn.has(epKey(ep)))
      )
    }
  }

  if (action === 'undo') {
    for (const s of EPISODE_SERVICES) takeBack(s)
  } else if (service && part(service)) {
    const mine = part(service)!
    if (action === 'service-match-here') {
      takeBack(service)
      owe(service, 'add', union(mine.sent, mine.unsendable).filter(isHeld))
    } else {
      const notThere = union(mine.sent, mine.unsendable).filter(isHeld)
      plan.removeHere = union(plan.removeHere, notThere)
      owe(service, 'remove', mine.sent.filter(isHeld))
      // Its own unsendable episodes cannot be named to it; saying so would
      // only repeat what the row already says.
      unreachable.delete(service)
      const arrived = mine.arrived.filter(isHeld)
      for (const other of EPISODE_SERVICES) {
        if (other === service) continue
        owe(other, 'remove', notThere)
        owe(other, 'add', arrived)
      }
    }
  }

  for (const [key, episodes] of toServices) {
    const [s, direction] = key.split('|') as [EpisodeService, 'add' | 'remove']
    plan.pushes.push({ service: s, action: direction, episodes })
  }
  // MyAnimeList is sent a count per entry, worked out from what is held
  // here, so it hears about the seasons whose count this choice changes.
  if (entry.type === 'anime' && ctx.connected.mal && plan.removeHere.length) {
    plan.pushes.push({
      service: 'mal',
      action: 'remove',
      episodes: seasonsOf(plan.removeHere).map((season) => ({ season, episode: 0 }))
    })
  }
  for (const [s, episodes] of unreachable) plan.cannotSend.push({ service: s, episodes })
  return plan
}

/**
 * The plan's changes as owed history pushes (historyRetry.ts), each stamped
 * with the account it is for. They are sent by the same retry that sends a
 * failed push again, and count as owed until a service takes them: a
 * removal owed keeps the catch-up and the Trakt pull from taking the episode
 * back in (tracking.ts's removalsHeldBack). A newer change for the same
 * episode replaces an older one, whichever way either went.
 */
export function queueShowDecision(
  pending: PendingHistoryPushes,
  show: SyncShow,
  plan: ShowDecisionPlan,
  marks: Readonly<Record<HistoryService, string>>,
  now: number
): PendingHistoryPushes {
  const next = { ...pending }
  const item: PendingHistoryPush['item'] = {
    id: show.id,
    type: show.type,
    title: show.title,
    ...(show.year ? { year: show.year } : {})
  }
  for (const push of plan.pushes) {
    const mark = marks[push.service]
    if (!mark) continue
    for (const ep of push.episodes) {
      const episode = push.service === 'mal' ? null : ep.episode
      next[historyPushKey(push.service, show.id, ep.season, episode)] = {
        service: push.service,
        action: push.action,
        item,
        season: ep.season,
        episode,
        attempts: 0,
        at: now,
        mark
      }
    }
  }
  return next
}

export interface DecideDeps {
  db: Pick<
    MediaHubDatabase,
    'activeProfile' | 'getCache' | 'putCache' | 'history' | 'unmarkWatched'
  >
  marks(): Readonly<Record<HistoryService, string>>
  canSend(service: EpisodeService, show: SyncShow, ep: Ep): boolean
  /** historyRetry.ts's readHistoryPending / writeHistoryPending. */
  readPending(): PendingHistoryPushes
  writePending(pending: PendingHistoryPushes): void
  /** The backup before history rows are removed (autoBackup.ts). */
  backup(): void
  now(): number
}

export interface DecideOutcome {
  ok: boolean
  queued: boolean
  removedHere: number
  cannotSend: Array<{ service: EpisodeService; seasons: number[] }>
  error?: string
}

/**
 * Carries out one choice on one show. The changes owed to the services are
 * written down first; then the row leaves the record; then the episodes are
 * removed here. A choice that cannot be written down changes nothing. Once
 * made it stands: a push that fails later is retried, and does not bring
 * the row back or put the episodes back here.
 */
export function decideShow(
  deps: DecideDeps,
  id: string,
  action: ShowAction,
  service?: EpisodeService
): DecideOutcome {
  const { db } = deps
  const profile = db.activeProfile()
  const marks = deps.marks()
  const record = readShowSync(db, profile)
  const entry = liveShowSync(record, marks).find((row) => row.id === id)
  const fail = (error: string): DecideOutcome => ({
    ok: false,
    queued: false,
    removedHere: 0,
    cannotSend: [],
    error
  })
  if (!entry) return fail('There is nothing left to review for that show.')
  if ((action === 'service-match-here' || action === 'here-match-service') && !service) {
    return fail('Which service was not said.')
  }
  if (service && !entry.parts[service]) return fail('That service has nothing for this show.')

  if (action === 'keep') {
    if (!writeShowSync(db, profile, dismissShow(record, id))) {
      return fail('Could not keep that choice.')
    }
    return { ok: true, queued: false, removedHere: 0, cannotSend: [] }
  }

  const held = new Set(
    db
      .history()
      .filter((row) => String(row.id) === id && row.season != null && row.episode != null)
      .map((row) => `${row.season}:${row.episode}`)
  )
  const plan = planShowDecision(entry, action, service, {
    held,
    connected: {
      simkl: Boolean(marks.simkl),
      trakt: Boolean(marks.trakt),
      mal: Boolean(marks.mal)
    },
    canSend: (s, ep) => deps.canSend(s, entry, ep)
  })

  if (plan.pushes.length) {
    const queued = queueShowDecision(deps.readPending(), entry, plan, marks, deps.now())
    deps.writePending(queued)
    const now = deps.readPending()
    const stuck = Object.keys(queued).every(
      (key) => JSON.stringify(now[key]) === JSON.stringify(queued[key])
    )
    if (!stuck) return fail('Could not keep that choice. Nothing was changed.')
  }
  const after =
    action === 'service-match-here' ? dismissShow(record, id, service) : dismissShow(record, id)
  if (!writeShowSync(db, profile, after)) {
    // The changes are queued and are what was asked for; the row staying
    // only offers the same choice again.
  }
  if (plan.removeHere.length) {
    deps.backup()
    for (const ep of plan.removeHere) db.unmarkWatched(id, ep.season, ep.episode)
  }
  return {
    ok: true,
    queued: plan.pushes.length > 0,
    removedHere: plan.removeHere.length,
    cannotSend: plan.cannotSend.map(({ service: s, episodes }) => ({
      service: s,
      seasons: seasonsOf(episodes)
    }))
  }
}
