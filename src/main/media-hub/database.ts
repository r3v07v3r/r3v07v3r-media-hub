// Local SQLite persistence for the media-hub integration — ported from
// r3v07v3r-media-hub's `src/database.cjs`, logic preserved 1:1 (same table
// schema, same migration guard, same upsert clauses, same sort orders).
// Only the typing is new: node:sqlite's `DatabaseSync`/`StatementSync` come
// from this project's bundled @types/node (see node_modules/@types/node/
// sqlite.d.ts) which already ships the v22 `node:sqlite` surface, so no
// ambient declarations were needed here.
import crypto from 'node:crypto'
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite'
import { readBackup, restoreBackup, writeBackup, type RestoreSummary } from './backup'
import { migrate } from './migrations'
import { MAX_RATING, MIN_RATING, ratingWeight } from '../../shared/media-hub/rating'
import type {
  CatalogItem,
  Episode,
  HistoryEntry,
  MediaKind,
  CustomList,
  CustomListItem,
  PlayRecord,
  TrackedItem,
  TrackedUpdate,
  ViewingStats
} from '../../shared/media-hub/types'

/** JSON.parse that falls back instead of throwing on malformed/absent data. */
function parse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

// Callers pass in loosely-shaped catalog items (from Simkl/Cinemeta/etc, or
// a bare `{id}` when only untracking/looking up); `id` is the only field we
// require. `name` is accepted as a legacy title fallback even though it's
// not part of CatalogItem — some upstream sources used `name` instead of
// `title`, and the original JS preserved that fallback.
type TrackInput = Partial<CatalogItem> & { id: unknown; name?: string }

// Some catalog sources (e.g. Simkl) label an episode's air date `firstAired`
// instead of `released`; CatalogItem's `Episode` type only declares
// `released`, so we widen locally to read either without lying to the rest
// of the codebase about what `Episode` guarantees.
type EpisodeLike = Episode & { firstAired?: string }

interface EpisodePosition {
  season: number
  episode: number
}

/** Normalizes an arbitrary catalog-ish item into the shape we persist for tracked/watched rows. */
function normalizeTitle(item: TrackInput): TrackedItem {
  return {
    id: String(item.id),
    simklId: item.simklId || null,
    type: (item.type || 'movie') as MediaKind,
    title: item.title || item.name || 'Untitled',
    poster: item.poster || '',
    background: item.background || '',
    logo: item.logo || '',
    year: String(item.year || ''),
    genres: Array.isArray(item.genres) ? item.genres : [],
    description: item.description || '',
    rating: item.rating || '',
    runtime: item.runtime || '',
    trailers: Array.isArray(item.trailers) ? item.trailers : []
  }
}

// `Number(v.season) || 1` would silently turn a real season 0 (the
// specials convention) into season 1 — 0 is falsy in JS, not "missing".
function episodePosition(v: EpisodeLike): EpisodePosition {
  const season = Number(v.season)
  const episode = Number(v.episode ?? v.number)
  return {
    season: Number.isFinite(season) ? season : 1,
    episode: Number.isFinite(episode) ? episode : 0
  }
}

function compareEpisode(a: EpisodePosition, b: EpisodePosition): number {
  return a.season - b.season || a.episode - b.episode
}

/** Highest already-aired episode position at `now`, or {0,0} when nothing has aired yet. */
function latestReleased(videos: EpisodeLike[] | undefined, now: Date): EpisodePosition {
  return (
    (videos || [])
      .filter((v) => {
        const released = v.released || v.firstAired
        return !released || new Date(released) <= now
      })
      .map(episodePosition)
      .filter((v) => v.episode > 0)
      .sort(compareEpisode)
      .at(-1) || { season: 0, episode: 0 }
  )
}

// node:sqlite's fail-fast rows are `Record<string, SQLOutputValue>`
// (string | number | bigint | Buffer-like | null). Every read below casts a
// specific column to the type its `CREATE TABLE` declaration guarantees
// (e.g. `metadata_json TEXT NOT NULL` -> `string`) rather than leaving the
// value as `SQLOutputValue` throughout.
type Row = Record<string, SQLOutputValue>

/**
 * A stored runtime as a number of minutes.
 *
 * The value is a DISPLAY string from whichever source supplied the title —
 * "48 min", "2h 15m", "1 h 30", or a bare "148" — so the shape has to be
 * recognised rather than assumed. Taking the first number, which is what this
 * used to do, read "2h 15m" as two minutes: a comment listing that exact form
 * as supported sat directly above the regex that could not parse it, and the
 * stats under-reported a film by most of its length.
 *
 * Anything unrecognisable is 0 rather than a guess — a title contributing
 * nothing to an estimate is honest, where a wrong number is not.
 */
function runtimeMinutes(value: unknown): number {
  const text = String(value ?? '').toLowerCase()
  if (!text) return 0
  // An explicit hours-and-minutes form wins, including when the minutes are
  // absent ("2h") or unlabelled ("1 h 30").
  const hours = text.match(/(\d+)\s*h/)
  if (hours) {
    const rest = text.slice(text.indexOf(hours[0]) + hours[0].length)
    const minutes = rest.match(/(\d+)/)
    return Number(hours[1]) * 60 + (minutes ? Number(minutes[1]) : 0)
  }
  const plain = text.match(/(\d+)/)
  return plain ? Number(plain[1]) : 0
}

function toEpisodePosition(row: Row | undefined): EpisodePosition {
  if (!row) return { season: 0, episode: 0 }
  return { season: (row.season as number) || 0, episode: (row.episode as number) || 0 }
}

/** The JS original always threw; typed as `never` so callers can still satisfy their declared return types. */
function fail(error: Error): never {
  throw new Error('Local database error: ' + error.message)
}

export interface PlaybackPositionResult {
  positionSeconds: number
  durationSeconds: number | null
  /** Playback volume in use when the bookmark was written, as the same
   *  0-2 multiplier the player speaks (1 = the source's own level).
   *  Optional because only the single-bookmark read carries it: the
   *  episode grid's list read has no use for a volume and does not ask
   *  for one, and absent is the honest way to say that. */
  volume?: number | null
}

export interface EpisodePlaybackPosition extends PlaybackPositionResult {
  season: number | null
  episode: number | null
}

export interface MediaHubDatabase {
  /**
   * Re-scopes every subsequent read and write to `profileId`.
   *
   * Deliberately module state rather than an argument on all ~20 methods
   * below. There is exactly one active profile for the whole app at any
   * moment — the same shape the playback session already has — and threading
   * an id through every call site would be a large diff whose only effect is
   * to let callers get it wrong. Set once at startup and again on a profile
   * switch; nothing else may call it.
   */
  setActiveProfile(profileId: string): void
  /** Which profile every read and write above is currently scoped to.
   *  Exposed so a caller needing to key something else by profile — a stored
   *  ranking, a notification watermark — can ask the connection rather than
   *  importing the profile machinery, which drags Electron in with it. */
  activeProfile(): string
  /** How many times each title has been played by the active profile, keyed by
   *  content id. Titles never played are absent rather than zero. */
  playCounts(): Map<string, number>
  /**
   * Records what the active profile thought of a title, 1-10. A score outside
   * that range — including the 0 the UI sends when somebody clears their
   * rating — removes it instead, because "no opinion" and "the lowest possible
   * opinion" are different things and only one of them should weigh on what
   * gets recommended.
   */
  rate(contentId: string | number, score: number): void
  /** Every score the active profile has given, keyed by content id. */
  ratings(): Map<string, number>
  /**
   * Erases everything one profile owns, in one transaction.
   *
   * Takes the id rather than acting on the active profile: a profile can only
   * be deleted while somebody else is active, so this is never about the
   * current scope.
   */
  deleteProfileData(profileId: string): void
  /** The active profile's own named lists, with their sizes. */
  lists(): CustomList[]
  /** Creates a list and returns it. Names are not unique — two lists called
   *  "Halloween" is somebody's business, not an error to raise at them. */
  createList(name: string): CustomList
  renameList(listId: string, name: string): boolean
  /** Removes the list and everything in it (the foreign key cascades). */
  deleteList(listId: string): boolean
  listItems(listId: string): CustomListItem[]
  /** Adds a title, or updates the metadata already stored for it. */
  addToList(listId: string, item: Partial<CatalogItem> & { id: unknown }): boolean
  removeFromList(listId: string, contentId: string | number): boolean
  /** Which of this profile's lists a title is in — one read for a picker that
   *  has to tick several boxes at once. */
  listsContaining(contentId: string | number): string[]
  /**
   * The active profile's viewing, newest first — one row per play rather than
   * one per title, so a rewatch appears twice.
   *
   * Capped rather than unbounded: this feeds a scrollable view, and a library
   * with years of episodes in it has no business parsing all of them to draw
   * the first screen.
   */
  plays(limit?: number): PlayRecord[]
  /** Removes one play. Returns false when it was already gone — two clicks on
   *  the same row is not an error. */
  deletePlay(playId: number): boolean
  /**
   * What the active profile's viewing adds up to.
   *
   * Computed on demand rather than stored, unlike the recommendation ranking.
   * The two look similar and are not: that one runs on the LAUNCH path
   * against a two-thousand-title catalog crawl, this one runs when somebody
   * opens a tab, against rows already on disk. Storing it would buy
   * milliseconds and cost a staleness problem.
   */
  viewingStats(): ViewingStats
  /** Writes every profile's library to one JSON file — see backup.ts for what
   *  a backup does and does not carry. NOT scoped to the active profile:
   *  a backup is of the install, not of whoever happens to be watching. */
  exportBackup(
    filePath: string,
    options: { appVersion: string; profiles: Record<string, unknown>[] }
  ): void
  /** Replaces every backed-up table with the file's contents, or changes
   *  nothing. Also not profile-scoped, for the same reason. */
  importBackup(filePath: string): RestoreSummary
  track(item: Partial<CatalogItem> & { id: unknown }, now?: Date): TrackedItem
  untrack(id: string | number): boolean
  isTracked(id: string | number): boolean
  tracked(): TrackedItem[]
  markWatched(
    item: Partial<CatalogItem> & { id: unknown },
    playback?: { season?: number; episode?: number }
  ): TrackedItem
  unmarkWatched(id: string | number, season?: number, episode?: number): boolean
  history(): HistoryEntry[]
  dislike(item: Partial<CatalogItem> & { id: unknown }, now?: Date): TrackedItem
  undislike(id: string | number): boolean
  isDisliked(id: string | number): boolean
  disliked(): TrackedItem[]
  preferredGenres(limit?: number): string[]
  /** Upserts a resume bookmark for one movie/episode, or clears it —
   *  see the implementation's own comment for exactly which. */
  savePlaybackPosition(
    contentId: string | number,
    playback: { season?: number; episode?: number } | undefined,
    positionSeconds: number,
    durationSeconds?: number,
    volume?: number
  ): void
  getPlaybackPosition(
    contentId: string | number,
    playback?: { season?: number; episode?: number }
  ): PlaybackPositionResult | null
  /** Every stored bookmark for one title at once — see
   *  EpisodePlaybackPosition (shared/media-hub/types.ts) for why the
   *  episode grid needs the whole set rather than one lookup per row. */
  listPlaybackPositions(contentId: string | number): EpisodePlaybackPosition[]
  /** Content ids whose resume bookmark has not moved since `before` (an ISO
   *  timestamp). A bookmark only exists between 20 seconds in and 90% through
   *  — savePlaybackPosition clears it either side of that — so a row this old
   *  is something started and left, not something in progress. */
  abandonedContentIds(before: string): string[]
  /** `durable: true` for the few rows in here that are a record of
   *  something a person decided rather than something refetched — see the
   *  `durable` helper in createDatabase. catalog_cache is a general
   *  key-value store, not only a cache, so "it is in catalog_cache" does
   *  NOT imply "losing it costs a refetch". */
  putCache<T>(key: string, payload: T, ttlMs: number, opts?: { durable?: boolean }): void
  getCache<T>(key: string, opts?: { allowExpired?: boolean }): T | null
  /** Removes a cache row outright. Distinct from letting a row expire,
   *  which the `allowExpired: true` readers can still serve back as a
   *  stale fallback — this is for a payload that has become WRONG rather
   *  than merely old, and must not be served again. */
  deleteCache(key: string): void
  trackedUpdates(details: CatalogItem[], now?: Date): TrackedUpdate[]
  close(): void
  filename: string
}

interface PreparedQueries {
  track: StatementSync
  lists: StatementSync
  createList: StatementSync
  renameList: StatementSync
  deleteList: StatementSync
  nextListOrder: StatementSync
  listItems: StatementSync
  addListItem: StatementSync
  removeListItem: StatementSync
  listOwned: StatementSync
  listMembership: StatementSync
  statsRows: StatementSync
  plays: StatementSync
  deletePlay: StatementSync
  rate: StatementSync
  clearRating: StatementSync
  ratings: StatementSync
  recordPlay: StatementSync
  deletePlays: StatementSync
  playCounts: StatementSync
  untrack: StatementSync
  isTracked: StatementSync
  tracked: StatementSync
  trackedRows: StatementSync
  watched: StatementSync
  unwatch: StatementSync
  history: StatementSync
  dislike: StatementSync
  undislike: StatementSync
  isDisliked: StatementSync
  disliked: StatementSync
  putCache: StatementSync
  getCache: StatementSync
  deleteCache: StatementSync
  lastEpisode: StatementSync
  savePosition: StatementSync
  clearPosition: StatementSync
  getPosition: StatementSync
  abandoned: StatementSync
  listPositions: StatementSync
}

/**
 * Opens (and migrates) the media-hub database.
 *
 * `defaultProfileId` is the profile this connection starts scoped to, and the
 * one every pre-existing row is attributed to when the profile-scoping
 * migration runs — see migrations.ts. Passed in rather than read from settings
 * here so this module stays free of the settings/profile machinery, and so a
 * test can open a database without either.
 */
export function createDatabase(filename: string, defaultProfileId: string): MediaHubDatabase {
  const sql = new DatabaseSync(filename)
  sql.exec('PRAGMA journal_mode = WAL')
  // The single biggest source of "the whole app freezes for a moment":
  // every statement here runs SYNCHRONOUSLY on the Electron main process,
  // and SQLite's default `synchronous = FULL` makes each implicit
  // transaction fsync the WAL before returning. Measured against a real
  // 19MB user database on this project's own hardware: 2.02 ms per
  // catalog_cache write at FULL vs 0.045 ms at NORMAL — a 45x difference,
  // every millisecond of it main-thread time the renderer cannot get an
  // IPC reply during. That matters because the write-heavy paths here are
  // not occasional: the anime franchise-grouping pass alone caches one
  // row per crawled title — ANIME_CATALOG_DEPTH titles, 2000 of them, plus
  // a second relationship pass over every one without a TVDB mapping — so
  // at FULL that single job is minutes of wall clock carrying seconds of
  // pure blocking fsync, in bursts, while the person is using the app.
  //
  // Running it at `maintenance` (see catalog.ts's startAnimeGrouping and
  // taskScheduler.ts) fixes when those writes are issued, not what each
  // one costs once issued: the tier defers the fetches, and then every
  // response that lands still stops the main thread for an fsync. The
  // scheduler and this pragma solve different halves of the same stall.
  //
  // NORMAL is the standard pairing for WAL: it still cannot corrupt the
  // database, it only gives up durability of the most recent commits if
  // the machine loses power before the WAL is synced.
  //
  // That trade is right for the caches and wrong for some of the rest, so
  // it is not applied uniformly — see `durable` below. NORMAL is the
  // default because the volume lives in catalog_cache, every row of which
  // is refetchable; the handful of writes that are somebody's actual
  // library, and would simply be gone, opt back into FULL individually.
  sql.exec('PRAGMA synchronous = NORMAL')
  sql.exec('PRAGMA foreign_keys = ON')

  /**
   * Runs one write with FULL durability, then restores the connection
   * default.
   *
   * For state that exists only here. A tracked title, a dislike and a
   * resume bookmark are all written straight to disk with no push and no
   * replay queue behind them (trackingToggle and trackingSavePosition in
   * tracking.ts are local-only by design), so a commit lost to a power
   * cut is a My List entry or a resume point the person simply does not
   * get back — unlike a lost cache row, which the next fetch rebuilds.
   * markWatched is included because the local row is the source of truth
   * even where a Simkl push also happens; the reconcile pending queue
   * covers review-panel decisions, not ordinary writes.
   *
   * Affordable precisely because these are rare — one per deliberate
   * action, at the ~2ms an fsync costs — where the cache writes this
   * pragma change exists for arrive in bursts of thousands. `finally`
   * rather than a trailing exec: every caller below reports failures by
   * throwing, and leaving the connection pinned at FULL after one of
   * those would silently undo the change for the rest of the session.
   */
  function durable<T>(write: () => T): T {
    sql.exec('PRAGMA synchronous = FULL')
    try {
      return write()
    } finally {
      sql.exec('PRAGMA synchronous = NORMAL')
    }
  }

  migrate(sql, defaultProfileId)
  let currentProfileId = defaultProfileId

  // Reclaims rows nothing has read in a long time. `catalog_cache` had no
  // eviction at all before this — every distinct key (a stream resolution,
  // a title's metadata, a TVDB mapping, ...) accumulated forever, for the
  // life of the install; a real user's database, inspected for the anime
  // catalog audit this fixes, already carried 298 expired rows with entire
  // categories (every related:v1:anime:*, meta:v3:anime:*, tmdb:season:*
  // entry) 100% expired and never reclaimed.
  //
  // NOT `WHERE expires_at < now` — getCache's `allowExpired: true` callers
  // (catalogData, metadata, similarTitles, localSimilar, relatedAnime, the
  // TorBox stream-resolve cache, Simkl's watched-history cache — eight
  // sites in total) deliberately serve an EXPIRED row as an emergency
  // fallback when a live refresh fails, e.g. the network is down right
  // when the app starts. Deleting a row the instant it expires would
  // quietly disarm that fallback for anyone who restarts between a normal
  // TTL lapse and their next successful refresh — turning "offline, but
  // here's the last good answer" into "offline, here's nothing." The grace
  // window below is generous specifically so that still works: it only
  // reclaims rows that have been unrefreshed for a full month, well past
  // every TTL in this app (the longest, the Kitsu/TMDB id-mapping caches,
  // is itself 30 days) and past any realistic length of time offline.
  const CACHE_PRUNE_GRACE_MS = 30 * 24 * 60 * 60 * 1000
  try {
    sql
      .prepare('DELETE FROM catalog_cache WHERE expires_at < ?')
      .run(Date.now() - CACHE_PRUNE_GRACE_MS)
  } catch {
    // Best-effort, same convention as every other cache operation in this
    // file — a failed prune must not stop the app from opening its database.
  }

  // Every statement scoped to one profile. `profile_id` is bound at call time
  // from `currentProfileId` rather than baked in, so switching profiles is a
  // variable assignment and not a re-prepare of the whole set.
  const q: PreparedQueries = {
    track: sql.prepare(
      `INSERT INTO tracked(profile_id,content_id,type,title,poster,metadata_json,tracked_at,baseline_season,baseline_episode)
       VALUES(@profile,@id,@type,@title,@poster,@json,@now,@baselineSeason,@baselineEpisode)
       ON CONFLICT(profile_id,content_id) DO UPDATE SET type=excluded.type,title=excluded.title,poster=excluded.poster,metadata_json=excluded.metadata_json`
    ),
    untrack: sql.prepare('DELETE FROM tracked WHERE profile_id=? AND content_id=?'),
    isTracked: sql.prepare('SELECT 1 FROM tracked WHERE profile_id=? AND content_id=?'),
    tracked: sql.prepare(
      'SELECT metadata_json FROM tracked WHERE profile_id=? ORDER BY tracked_at DESC'
    ),
    trackedRows: sql.prepare(
      'SELECT content_id,metadata_json,baseline_season,baseline_episode FROM tracked WHERE profile_id=? ORDER BY tracked_at DESC'
    ),
    watched: sql.prepare(
      `INSERT INTO watch_history(profile_id,watch_key,content_id,type,title,season,episode,watched_at,metadata_json)
       VALUES(@profile,@key,@id,@type,@title,@season,@episode,@now,@json)
       ON CONFLICT(profile_id,watch_key) DO UPDATE SET watched_at=excluded.watched_at,metadata_json=excluded.metadata_json`
    ),
    unwatch: sql.prepare('DELETE FROM watch_history WHERE profile_id=? AND watch_key=?'),
    history: sql.prepare(
      'SELECT metadata_json,season,episode,watched_at FROM watch_history WHERE profile_id=? ORDER BY watched_at DESC'
    ),
    // The append-only companion to `watched` above: that row answers "has this
    // been seen", this one records that it happened. A rewatch updates the
    // first and adds to the second.
    recordPlay: sql.prepare(
      `INSERT INTO plays(profile_id,content_id,type,title,season,episode,watched_at,metadata_json)
       VALUES(@profile,@id,@type,@title,@season,@episode,@now,@json)`
    ),
    // Paired with `unwatch`, which is somebody saying they have not seen this
    // after all. Leaving the plays behind would make the history view contradict
    // the badge that was just cleared.
    deletePlays: sql.prepare(
      `DELETE FROM plays WHERE profile_id=@profile AND content_id=@id
       AND season IS @season AND episode IS @episode`
    ),
    playCounts: sql.prepare(
      'SELECT content_id,COUNT(*) AS plays FROM plays WHERE profile_id=? GROUP BY content_id'
    ),
    plays: sql.prepare(
      `SELECT play_id,content_id,type,title,season,episode,watched_at,metadata_json
       FROM plays WHERE profile_id=? ORDER BY watched_at DESC, play_id DESC LIMIT ?`
    ),
    deletePlay: sql.prepare('DELETE FROM plays WHERE profile_id=? AND play_id=?'),
    // One pass over the profile's plays, joined to nothing. Everything the
    // stats need is already on the row or in its stored metadata, which is
    // what keeps this a local read rather than a catalog crawl.
    lists: sql.prepare(
      `SELECT l.list_id, l.name, l.created_at, COUNT(i.content_id) AS count
       FROM lists l LEFT JOIN list_items i ON i.list_id = l.list_id
       WHERE l.profile_id=? GROUP BY l.list_id ORDER BY l.sort_order, l.created_at`
    ),
    createList: sql.prepare(
      'INSERT INTO lists(list_id,profile_id,name,sort_order,created_at) VALUES(?,?,?,?,?)'
    ),
    renameList: sql.prepare('UPDATE lists SET name=? WHERE profile_id=? AND list_id=?'),
    // list_items has ON DELETE CASCADE and foreign keys are on, so its rows go
    // with the list rather than being orphaned.
    deleteList: sql.prepare('DELETE FROM lists WHERE profile_id=? AND list_id=?'),
    nextListOrder: sql.prepare(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM lists WHERE profile_id=?'
    ),
    // Scoped through the parent list rather than carrying its own profile
    // column: a list_id already belongs to exactly one profile, and a second
    // copy of that fact is a second thing that can disagree.
    listItems: sql.prepare(
      `SELECT i.content_id, i.added_at, i.metadata_json FROM list_items i
       JOIN lists l ON l.list_id = i.list_id
       WHERE l.profile_id=? AND i.list_id=? ORDER BY i.sort_order, i.added_at DESC`
    ),
    addListItem: sql.prepare(
      `INSERT INTO list_items(list_id,content_id,sort_order,added_at,metadata_json)
       VALUES(@list,@id,@order,@now,@json)
       ON CONFLICT(list_id,content_id) DO UPDATE SET metadata_json=excluded.metadata_json`
    ),
    removeListItem: sql.prepare('DELETE FROM list_items WHERE list_id=? AND content_id=?'),
    listOwned: sql.prepare('SELECT 1 FROM lists WHERE profile_id=? AND list_id=?'),
    listMembership: sql.prepare(
      `SELECT i.list_id FROM list_items i JOIN lists l ON l.list_id = i.list_id
       WHERE l.profile_id=? AND i.content_id=?`
    ),
    statsRows: sql.prepare(
      'SELECT content_id,type,title,season,episode,watched_at,metadata_json FROM plays WHERE profile_id=?'
    ),
    rate: sql.prepare(
      `INSERT INTO ratings(profile_id,content_id,score,rated_at) VALUES(@profile,@id,@score,@now)
       ON CONFLICT(profile_id,content_id) DO UPDATE SET score=excluded.score,rated_at=excluded.rated_at`
    ),
    clearRating: sql.prepare('DELETE FROM ratings WHERE profile_id=? AND content_id=?'),
    ratings: sql.prepare('SELECT content_id,score FROM ratings WHERE profile_id=?'),
    dislike: sql.prepare(
      `INSERT INTO disliked(profile_id,content_id,type,title,poster,metadata_json,disliked_at)
       VALUES(@profile,@id,@type,@title,@poster,@json,@now)
       ON CONFLICT(profile_id,content_id) DO UPDATE SET type=excluded.type,title=excluded.title,poster=excluded.poster,metadata_json=excluded.metadata_json`
    ),
    undislike: sql.prepare('DELETE FROM disliked WHERE profile_id=? AND content_id=?'),
    isDisliked: sql.prepare('SELECT 1 FROM disliked WHERE profile_id=? AND content_id=?'),
    disliked: sql.prepare(
      'SELECT metadata_json FROM disliked WHERE profile_id=? ORDER BY disliked_at DESC'
    ),
    // catalog_cache is deliberately NOT profile-scoped. It holds what the
    // catalogs say about a title — metadata, artwork, id mappings, stream
    // resolutions — none of which differ by who is watching, and duplicating a
    // 3.4MB catalog row per profile would be pure waste.
    putCache: sql.prepare(
      `INSERT INTO catalog_cache(cache_key,payload_json,expires_at,updated_at) VALUES(?,?,?,?)
       ON CONFLICT(cache_key) DO UPDATE SET payload_json=excluded.payload_json,expires_at=excluded.expires_at,updated_at=excluded.updated_at`
    ),
    getCache: sql.prepare('SELECT payload_json,expires_at FROM catalog_cache WHERE cache_key=?'),
    deleteCache: sql.prepare('DELETE FROM catalog_cache WHERE cache_key=?'),
    lastEpisode: sql.prepare(
      'SELECT season,episode FROM watch_history WHERE profile_id=? AND content_id=? AND season IS NOT NULL ORDER BY season DESC,episode DESC LIMIT 1'
    ),
    savePosition: sql.prepare(
      `INSERT INTO playback_positions(profile_id,position_key,content_id,season,episode,position_seconds,duration_seconds,volume,updated_at)
       VALUES(@profile,@key,@id,@season,@episode,@position,@duration,@volume,@now)
       ON CONFLICT(profile_id,position_key) DO UPDATE SET position_seconds=excluded.position_seconds,duration_seconds=excluded.duration_seconds,volume=COALESCE(excluded.volume,playback_positions.volume),updated_at=excluded.updated_at`
    ),
    clearPosition: sql.prepare(
      'DELETE FROM playback_positions WHERE profile_id=? AND position_key=?'
    ),
    getPosition: sql.prepare(
      'SELECT position_seconds,duration_seconds,volume FROM playback_positions WHERE profile_id=? AND position_key=?'
    ),
    abandoned: sql.prepare(
      'SELECT DISTINCT content_id FROM playback_positions WHERE profile_id=? AND updated_at < ?'
    ),
    listPositions: sql.prepare(
      'SELECT season,episode,position_seconds,duration_seconds FROM playback_positions WHERE profile_id=? AND content_id=?'
    )
  }

  const db: MediaHubDatabase = {
    setActiveProfile(profileId) {
      const next = String(profileId || '').trim()
      // An empty id would scope every query to a profile that owns nothing,
      // which reads as "this person has watched nothing, ever" rather than as
      // the error it is. Keeping the previous scope is the safer failure.
      if (next) currentProfileId = next
    },

    exportBackup(filePath, options) {
      try {
        writeBackup(sql, filePath, options)
      } catch (error) {
        return fail(error as Error)
      }
    },

    importBackup(filePath) {
      try {
        const summary = restoreBackup(sql, readBackup(filePath))
        // Not a cache invalidation but a correctness one: `preferredGenres`
        // and everything else derived from history is computed on demand, so
        // there is nothing stale to clear here — the restored rows are simply
        // what the next read sees.
        return summary
      } catch (error) {
        // Rethrown as-is rather than through `fail`, which prefixes every
        // message with "Local database error". These messages are written to
        // be shown to the person choosing the file — "That is not an R3 Media
        // Hub backup" needs no prefix explaining which subsystem said so.
        throw error as Error
      }
    },

    rate(contentId, score) {
      try {
        const id = String(contentId)
        const value = Math.round(Number(score))
        if (!Number.isFinite(value) || value < MIN_RATING || value > MAX_RATING) {
          durable(() => q.clearRating.run(currentProfileId, id))
          return
        }
        durable(() =>
          q.rate.run({
            profile: currentProfileId,
            id,
            score: value,
            now: new Date().toISOString()
          })
        )
      } catch (error) {
        return fail(error as Error)
      }
    },

    viewingStats() {
      const empty: ViewingStats = {
        totalPlays: 0,
        totalTitles: 0,
        estimatedHours: 0,
        byMonth: [],
        topGenres: [],
        byKind: [],
        mostPlayed: []
      }
      try {
        const rows = q.statsRows.all(currentProfileId) as Row[]

        const titles = new Map<string, { title: string; plays: number }>()
        // Keyed by the exact thing watched, not by the title. For a film those
        // are the same; for a series they are not, and conflating them makes
        // two DIFFERENT episodes look like a rewatch — which is the whole
        // question the "seen again" list answers.
        const repeats = new Map<string, number>()
        const genres = new Map<string, number>()
        const kinds = new Map<MediaKind, number>()
        const months = new Map<string, number>()
        // Runtime is a property of the TITLE, not of each viewing, but a
        // rewatch really is more time spent — so minutes accumulate per play
        // while the runtime itself is looked up once per title.
        const runtimeByTitle = new Map<string, number>()
        let minutes = 0

        for (const row of rows) {
          const id = String(row.content_id)
          const meta = parse<Partial<TrackedItem>>(row.metadata_json as string, {})
          const title = String(row.title ?? meta.title ?? 'Untitled')
          const existing = titles.get(id)
          if (existing) existing.plays += 1
          else titles.set(id, { title, plays: 1 })

          const kind = (row.type as MediaKind) || 'movie'
          kinds.set(kind, (kinds.get(kind) ?? 0) + 1)

          for (const genre of meta.genres ?? []) {
            const name = String(genre).trim()
            if (name) genres.set(name, (genres.get(name) ?? 0) + 1)
          }

          if (!runtimeByTitle.has(id)) {
            runtimeByTitle.set(id, runtimeMinutes(meta.runtime))
          }
          minutes += runtimeByTitle.get(id) ?? 0

          // Sliced off the ISO string rather than parsed into a Date: these
          // are timestamps this app wrote, always ISO, and a Date per row over
          // thousands of them is real main-thread time for a substring.
          const episodeKey = `${id}:${row.season ?? ''}:${row.episode ?? ''}`
          repeats.set(episodeKey, (repeats.get(episodeKey) ?? 0) + 1)

          const month = String(row.watched_at).slice(0, 7)
          if (/^\d{4}-\d{2}$/.test(month)) months.set(month, (months.get(month) ?? 0) + 1)
        }

        // The last twelve months INCLUDING the ones with nothing in them — a
        // chart that silently omits a quiet month draws a misleading line.
        const now = new Date()
        const byMonth: { month: string; plays: number }[] = []
        for (let back = 11; back >= 0; back--) {
          const point = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))
          const key = point.toISOString().slice(0, 7)
          byMonth.push({ month: key, plays: months.get(key) ?? 0 })
        }

        const rank = <T>(entries: Map<T, number>, limit: number): [T, number][] =>
          [...entries]
            .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
            .slice(0, limit)

        return {
          totalPlays: rows.length,
          totalTitles: titles.size,
          estimatedHours: Math.round(minutes / 60),
          byMonth,
          topGenres: rank(genres, 8).map(([genre, plays]) => ({ genre, plays })),
          byKind: rank(kinds, 3).map(([kind, plays]) => ({ kind, plays })),
          // How many times the most-repeated single thing in each title was
          // watched. A film seen twice reports 2; a series reports 2 only if
          // some ONE episode was seen twice, not because two episodes were
          // seen once each.
          mostPlayed: [...titles]
            .map(([contentId, entry]) => {
              let most = 0
              for (const [key, count] of repeats) {
                if (key.startsWith(`${contentId}:`) && count > most) most = count
              }
              return { contentId, title: entry.title, plays: most }
            })
            .filter((entry) => entry.plays > 1)
            .sort((a, b) => b.plays - a.plays || a.title.localeCompare(b.title))
            .slice(0, 6)
        }
      } catch {
        // Best-effort like every other read here: a stats page that cannot be
        // computed shows nothing, it does not take the page down with it.
        return empty
      }
    },

    lists() {
      try {
        return (q.lists.all(currentProfileId) as Row[]).map((row) => ({
          id: String(row.list_id),
          name: String(row.name),
          count: Number(row.count) || 0,
          createdAt: String(row.created_at)
        }))
      } catch {
        return []
      }
    },

    createList(name) {
      try {
        const trimmed = String(name || '')
          .trim()
          .slice(0, 80)
        if (!trimmed) throw new Error('A list needs a name.')
        const id = crypto.randomUUID()
        const now = new Date().toISOString()
        const order = Number((q.nextListOrder.get(currentProfileId) as Row | undefined)?.next ?? 0)
        durable(() => q.createList.run(id, currentProfileId, trimmed, order, now))
        return { id, name: trimmed, count: 0, createdAt: now }
      } catch (error) {
        return fail(error as Error)
      }
    },

    renameList(listId, name) {
      try {
        const trimmed = String(name || '')
          .trim()
          .slice(0, 80)
        if (!trimmed) return false
        return durable(
          () => q.renameList.run(trimmed, currentProfileId, String(listId)).changes > 0
        )
      } catch (error) {
        return fail(error as Error)
      }
    },

    deleteList(listId) {
      try {
        return durable(() => q.deleteList.run(currentProfileId, String(listId)).changes > 0)
      } catch (error) {
        return fail(error as Error)
      }
    },

    listItems(listId) {
      try {
        return (q.listItems.all(currentProfileId, String(listId)) as Row[]).map((row) => {
          const meta = parse<Partial<TrackedItem>>(row.metadata_json as string, {})
          return {
            contentId: String(row.content_id),
            title: String(meta.title ?? 'Untitled'),
            poster: String(meta.poster ?? ''),
            type: (meta.type ?? 'movie') as MediaKind,
            addedAt: String(row.added_at)
          }
        })
      } catch {
        return []
      }
    },

    addToList(listId, item) {
      try {
        const id = String(listId)
        // Checked rather than trusted: the list id crosses IPC, and without
        // this a renderer could write into another profile's list — the
        // list_items table has no profile column of its own, deliberately, so
        // this IS the check.
        if (!q.listOwned.get(currentProfileId, id)) return false
        const value = normalizeTitle(item)
        durable(() =>
          q.addListItem.run({
            list: id,
            id: value.id,
            // Newest first within a list, which is what the read's ORDER BY
            // resolves to once every row shares an order of 0. Explicit
            // ordering is a later feature; this is the sensible default until
            // there is something to drag.
            order: 0,
            now: new Date().toISOString(),
            json: JSON.stringify(value)
          })
        )
        return true
      } catch (error) {
        return fail(error as Error)
      }
    },

    removeFromList(listId, contentId) {
      try {
        const id = String(listId)
        if (!q.listOwned.get(currentProfileId, id)) return false
        return durable(() => q.removeListItem.run(id, String(contentId)).changes > 0)
      } catch (error) {
        return fail(error as Error)
      }
    },

    listsContaining(contentId) {
      try {
        return (q.listMembership.all(currentProfileId, String(contentId)) as Row[]).map((row) =>
          String(row.list_id)
        )
      } catch {
        return []
      }
    },

    plays(limit = 500) {
      try {
        const rows = q.plays.all(currentProfileId, Math.max(1, Math.floor(limit))) as Row[]
        return rows.map((row) => {
          const meta = parse<Partial<TrackedItem>>(row.metadata_json as string, {})
          return {
            playId: Number(row.play_id),
            contentId: String(row.content_id),
            type: row.type as MediaKind,
            title: String(row.title ?? meta.title ?? 'Untitled'),
            season: (row.season as number | null) ?? null,
            episode: (row.episode as number | null) ?? null,
            watchedAt: String(row.watched_at),
            poster: String(meta.poster ?? '')
          }
        })
      } catch {
        // Best-effort like every other read here: an unreadable table costs
        // the history view its rows, never the page they would sit on.
        return []
      }
    },

    deletePlay(playId) {
      try {
        const id = Number(playId)
        if (!Number.isInteger(id)) return false
        return durable(() => q.deletePlay.run(currentProfileId, id).changes > 0)
      } catch (error) {
        return fail(error as Error)
      }
    },

    deleteProfileData(profileId) {
      const id = String(profileId || '').trim()
      // An empty id would match no rows in the WHERE clauses below, but the
      // question is not worth asking of the database at all — and a caller
      // passing one has a bug this should not quietly absorb.
      if (!id) return
      try {
        durable(() => {
          sql.exec('BEGIN')
          try {
            // list_items has no profile column of its own (see the lists
            // queries above); it belongs to a profile through its parent list,
            // and the foreign key cascades when that list goes. Deleting the
            // lists is therefore what removes the items, and doing it first
            // would leave nothing for a direct delete to find.
            for (const table of [
              'tracked',
              'watch_history',
              'plays',
              'disliked',
              'playback_positions',
              'ratings',
              'lists'
            ]) {
              sql.prepare(`DELETE FROM ${table} WHERE profile_id=?`).run(id)
            }
            sql.exec('COMMIT')
          } catch (error) {
            sql.exec('ROLLBACK')
            throw error
          }
        })
      } catch (error) {
        return fail(error as Error)
      }
    },

    ratings() {
      try {
        const scores = new Map<string, number>()
        for (const row of q.ratings.all(currentProfileId) as Row[]) {
          scores.set(String(row.content_id), Number(row.score))
        }
        return scores
      } catch {
        // Best-effort like the other reads here. No ratings means the ranking
        // weighs every watched title equally, which is exactly what it did
        // before ratings existed.
        return new Map()
      }
    },

    activeProfile() {
      return currentProfileId
    },

    playCounts() {
      try {
        const counts = new Map<string, number>()
        for (const row of q.playCounts.all(currentProfileId) as Row[]) {
          counts.set(String(row.content_id), Number(row.plays) || 0)
        }
        return counts
      } catch {
        // Best-effort like every other read here: no counts costs a "watched
        // twice" label, never the list it would have sat on.
        return new Map()
      }
    },

    track(item, now = new Date()) {
      try {
        const value = normalizeTitle(item)
        const baseline = latestReleased(item.videos as EpisodeLike[] | undefined, now)
        durable(() =>
          q.track.run({
            profile: currentProfileId,
            id: value.id,
            type: value.type,
            title: value.title,
            poster: value.poster,
            json: JSON.stringify(value),
            now: now.toISOString(),
            baselineSeason: baseline.season,
            baselineEpisode: baseline.episode
          })
        )
        return value
      } catch (error) {
        return fail(error as Error)
      }
    },

    untrack(id) {
      try {
        return durable(() => q.untrack.run(currentProfileId, String(id)).changes > 0)
      } catch (error) {
        return fail(error as Error)
      }
    },

    isTracked(id) {
      try {
        return Boolean(q.isTracked.get(currentProfileId, String(id)))
      } catch (error) {
        return fail(error as Error)
      }
    },

    tracked() {
      try {
        return q.tracked
          .all(currentProfileId)
          .map((r) => parse<TrackedItem>((r as Row).metadata_json as string, {} as TrackedItem))
      } catch (error) {
        return fail(error as Error)
      }
    },

    markWatched(item, playback = {}) {
      try {
        const value = normalizeTitle(item)
        const season = Number.isFinite(playback.season) ? (playback.season as number) : null
        const episode = Number.isFinite(playback.episode) ? (playback.episode as number) : null
        const key = `${value.id}:${season ?? 'movie'}:${episode ?? 'movie'}`
        const now = new Date().toISOString()
        // Two parameter sets rather than one shared object: node:sqlite rejects
        // a named parameter the statement does not bind, and only `watched`
        // has a watch_key.
        const play = {
          profile: currentProfileId,
          id: value.id,
          type: value.type,
          title: value.title,
          season,
          episode,
          now,
          json: JSON.stringify(value)
        }
        const seen = { ...play, key }
        // Two writes, one transaction, because they are two halves of one
        // fact and a crash between them would leave the app disagreeing with
        // itself about whether this was watched.
        //
        // `watched` upserts — it is the "has this been seen" index every grid,
        // badge and next-episode calculation reads, and there is exactly one
        // answer per episode. `plays` appends, because a second viewing is a
        // second event and the record of the first is not the app's to throw
        // away. Before this the upsert was the only write, so a rewatch moved
        // the timestamp and the earlier viewing simply stopped having
        // happened.
        durable(() => {
          sql.exec('BEGIN')
          try {
            q.watched.run(seen)
            q.recordPlay.run(play)
            sql.exec('COMMIT')
          } catch (error) {
            sql.exec('ROLLBACK')
            throw error
          }
        })
        return value
      } catch (error) {
        return fail(error as Error)
      }
    },

    unmarkWatched(id, season, episode) {
      try {
        const seasonValue = Number.isFinite(season) ? (season as number) : null
        const episodeValue = Number.isFinite(episode) ? (episode as number) : null
        const key = `${String(id)}:${seasonValue ?? 'movie'}:${episodeValue ?? 'movie'}`
        // The plays go with it. This is somebody stating they have not seen
        // this after all, and a history that still listed the viewings would
        // contradict the badge they just cleared. It is the one thing that
        // removes from `plays` — playback only ever adds.
        return durable(() => {
          sql.exec('BEGIN')
          try {
            const removed = q.unwatch.run(currentProfileId, key).changes > 0
            q.deletePlays.run({
              profile: currentProfileId,
              id: String(id),
              season: seasonValue,
              episode: episodeValue
            })
            sql.exec('COMMIT')
            return removed
          } catch (error) {
            sql.exec('ROLLBACK')
            throw error
          }
        })
      } catch (error) {
        return fail(error as Error)
      }
    },

    history() {
      try {
        return q.history.all(currentProfileId).map((r) => {
          const row = r as Row
          return {
            ...parse<Partial<TrackedItem>>(row.metadata_json as string, {}),
            season: row.season as number | null,
            episode: row.episode as number | null,
            watchedAt: row.watched_at as string
          } as HistoryEntry
        })
      } catch (error) {
        return fail(error as Error)
      }
    },

    dislike(item, now = new Date()) {
      try {
        const value = normalizeTitle(item)
        durable(() =>
          q.dislike.run({
            profile: currentProfileId,
            id: value.id,
            type: value.type,
            title: value.title,
            poster: value.poster,
            json: JSON.stringify(value),
            now: now.toISOString()
          })
        )
        return value
      } catch (error) {
        return fail(error as Error)
      }
    },

    undislike(id) {
      try {
        return durable(() => q.undislike.run(currentProfileId, String(id)).changes > 0)
      } catch (error) {
        return fail(error as Error)
      }
    },

    isDisliked(id) {
      try {
        return Boolean(q.isDisliked.get(currentProfileId, String(id)))
      } catch (error) {
        return fail(error as Error)
      }
    },

    disliked() {
      try {
        return q.disliked
          .all(currentProfileId)
          .map((r) => parse<TrackedItem>((r as Row).metadata_json as string, {} as TrackedItem))
      } catch (error) {
        return fail(error as Error)
      }
    },

    preferredGenres(limit = 3) {
      // Weighted by what the person thought of each title, not by how many
      // times its genres appear. Before ratings existed this counted a film
      // somebody finished and resented exactly as heavily as one they loved,
      // which is how a genre nobody actually enjoys ends up leading the row.
      // An unrated title still weighs 1, so a library nobody has rated
      // produces precisely the old answer — see ratingWeight.
      const scores = db.ratings()
      const counts = new Map<string, number>()
      for (const item of db.history()) {
        const weight = ratingWeight(scores.get(String(item.id)))
        if (weight === 0) continue
        for (const genre of item.genres || []) {
          counts.set(genre, (counts.get(genre) || 0) + weight)
        }
      }
      return [...counts]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, limit)
        .map((x) => x[0])
    },

    // Below this many seconds in, there's nothing meaningful to resume —
    // saving (and later re-seeking to) the first few seconds would be a
    // worse experience than just starting fresh, since a tiny seek still
    // pays a real restart cost in compatibility mode.
    savePlaybackPosition(contentId, playback, positionSeconds, durationSeconds, volume) {
      try {
        const id = String(contentId)
        const season = Number.isFinite(playback?.season) ? (playback!.season as number) : null
        const episode = Number.isFinite(playback?.episode) ? (playback!.episode as number) : null
        const key = `${id}:${season ?? 'movie'}:${episode ?? 'movie'}`
        const nearStart = positionSeconds < 20
        // >=90% through reads as "finished" the same way the 80% auto-mark
        // (adapters.ts/PlaybackOverlay's own markWatchedNow) already treats
        // it as watched — once someone's essentially done, Play should
        // start the title over next time, not re-offer the last few
        // minutes of credits.
        const nearEnd =
          Number.isFinite(durationSeconds) &&
          (durationSeconds as number) > 0 &&
          positionSeconds / (durationSeconds as number) >= 0.9
        if (nearStart || nearEnd) {
          durable(() => q.clearPosition.run(currentProfileId, key))
          return
        }
        durable(() =>
          q.savePosition.run({
            profile: currentProfileId,
            key,
            id,
            season,
            episode,
            position: positionSeconds,
            duration:
              typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)
                ? durationSeconds
                : null,
            // TWO different silences, deliberately mapped to the same NULL —
            // which the upsert's COALESCE reads as "leave any stored volume
            // standing":
            //
            //   omitted — the caller has no volume to offer and is saying
            //     nothing about it, so it must not wipe what the player wrote.
            //   zero — the player IS saying something: muted, right now. Mute
            //     is what people do for a minute, so the level worth resuming
            //     is the last audible one. Not silence, which would come back
            //     as a film playing with no sound and no visible reason; and
            //     not a reset to 100%, which would throw away the boost the
            //     title was actually being watched at — the one thing this
            //     column exists to remember.
            volume:
              typeof volume === 'number' && Number.isFinite(volume) && volume > 0 ? volume : null,
            now: new Date().toISOString()
          })
        )
      } catch {
        // Best-effort — a failed resume-position write must never surface
        // to the player; worst case, the next play just starts from 0.
      }
    },

    getPlaybackPosition(contentId, playback) {
      try {
        const season = Number.isFinite(playback?.season) ? (playback!.season as number) : null
        const episode = Number.isFinite(playback?.episode) ? (playback!.episode as number) : null
        const key = `${String(contentId)}:${season ?? 'movie'}:${episode ?? 'movie'}`
        const row = q.getPosition.get(currentProfileId, key) as Row | undefined
        if (!row) return null
        return {
          positionSeconds: row.position_seconds as number,
          durationSeconds: (row.duration_seconds as number | null) ?? null,
          volume: (row.volume as number | null) ?? null
        }
      } catch {
        return null
      }
    },

    // Same best-effort contract as the two above: an unreadable
    // positions table costs the grid its resume slivers, never the grid
    // itself, so a failure here is an empty list rather than a throw.
    listPlaybackPositions(contentId) {
      try {
        return (q.listPositions.all(currentProfileId, String(contentId)) as Row[]).map((row) => ({
          season: (row.season as number | null) ?? null,
          episode: (row.episode as number | null) ?? null,
          positionSeconds: row.position_seconds as number,
          durationSeconds: (row.duration_seconds as number | null) ?? null
        }))
      } catch {
        return []
      }
    },

    abandonedContentIds(before) {
      try {
        return (q.abandoned.all(currentProfileId, String(before)) as Row[]).map((row) =>
          String(row.content_id)
        )
      } catch {
        // Best-effort, like every other read here: losing this signal
        // costs a slightly worse ranking, never a broken one.
        return []
      }
    },

    putCache<T>(
      key: string,
      payload: T,
      ttlMs: number,
      { durable: needsDurability = false }: { durable?: boolean } = {}
    ): void {
      try {
        const now = Date.now()
        const write = (): void => {
          q.putCache.run(key, JSON.stringify(payload), now + ttlMs, now)
        }
        if (needsDurability) durable(write)
        else write()
      } catch {
        // Cache writes are best-effort; a failure here must not surface to callers.
      }
    },

    getCache<T>(key: string, { allowExpired = false }: { allowExpired?: boolean } = {}): T | null {
      try {
        const row = q.getCache.get(key) as Row | undefined
        if (!row) return null
        const expiresAt = row.expires_at as number
        return allowExpired || expiresAt > Date.now()
          ? parse<T | null>(row.payload_json as string, null)
          : null
      } catch {
        return null
      }
    },

    deleteCache(key: string): void {
      try {
        q.deleteCache.run(key)
      } catch {
        // Best-effort, same convention as every other cache operation in
        // this file — a failed delete must not surface to callers.
      }
    },

    trackedUpdates(details, now = new Date()) {
      try {
        const byId = new Map(details.map((x) => [String(x.id), x]))
        const updates: TrackedUpdate[] = []
        for (const r of q.trackedRows.all(currentProfileId)) {
          const row = r as Row
          const tracked = parse<TrackedItem>(row.metadata_json as string, {} as TrackedItem)
          const detail = byId.get(String(row.content_id))
          if (!detail) continue

          const watchedRow = q.lastEpisode.get(currentProfileId, row.content_id as string) as
            Row | undefined
          const watched = toEpisodePosition(watchedRow)
          const baseline: EpisodePosition = {
            season: (row.baseline_season as number) || 0,
            episode: (row.baseline_episode as number) || 0
          }
          const last = compareEpisode(watched, baseline) >= 0 ? watched : baseline

          const released = ((detail.videos as EpisodeLike[] | undefined) || []).filter((v) => {
            const p = episodePosition(v)
            const date = v.released || v.firstAired
            return (!date || new Date(date) <= now) && compareEpisode(p, last) > 0
          })
          if (released.length) {
            updates.push({
              ...tracked,
              newEpisodeCount: released.length,
              latestEpisode: released.at(-1) as Episode
            })
          }
        }
        return updates
      } catch (error) {
        return fail(error as Error)
      }
    },

    close() {
      sql.close()
    },

    filename
  }

  return db
}
