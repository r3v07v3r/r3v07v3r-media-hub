// Local SQLite persistence for the media-hub integration — ported from
// r3v07v3r-media-hub's `src/database.cjs`, logic preserved 1:1 (same table
// schema, same migration guard, same upsert clauses, same sort orders).
// Only the typing is new: node:sqlite's `DatabaseSync`/`StatementSync` come
// from this project's bundled @types/node (see node_modules/@types/node/
// sqlite.d.ts) which already ships the v22 `node:sqlite` surface, so no
// ambient declarations were needed here.
import crypto from 'node:crypto'
import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync
} from 'node:sqlite'
import { readBackup, restoreBackup, writeBackup, type RestoreSummary } from './backup'
import { migrate } from './migrations'
import { logError } from './logger'
import { MAX_RATING, MIN_RATING, ratingWeight } from '../../shared/media-hub/rating'
import {
  parseRating,
  parseRuntimeMinutes,
  parseYear,
  titleSortKey
} from '../../shared/media-hub/catalogFields'
import {
  findBucket,
  EPISODES_BUCKETS,
  EPISODE_LENGTH_BUCKETS,
  RUNTIME_BUCKETS,
  SEASONS_BUCKETS,
  type Bucket
} from '../../shared/media-hub/catalogFilters'
import { runtimeMinutesOrZero } from '../../shared/media-hub/runtime'
import type {
  CatalogFacets,
  CatalogItem,
  CatalogQuery,
  CatalogQueryResult,
  CatalogSortKey,
  Episode,
  HistoryEntry,
  ImportedPlay,
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

/**
 * One "these rows are actually that title" instruction for remapContentIds.
 * `seasonOffset` shifts each moved row's season — a merged franchise's
 * sibling was written as its own season 1, and belongs at whatever season
 * it really occupies inside the group.
 */
export interface ContentIdRemap {
  fromId: string
  toId: string
  seasonOffset: number
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

function toEpisodePosition(row: Row | undefined): EpisodePosition {
  if (!row) return { season: 0, episode: 0 }
  return { season: (row.season as number) || 0, episode: (row.episode as number) || 0 }
}

/** The JS original always threw; typed as `never` so callers can still satisfy their declared return types. */
function fail(error: Error): never {
  throw new Error('Local database error: ' + error.message)
}

/**
 * The season/episode totals to store for one catalog item.
 *
 * Applies the same precedence the browse grid already uses (see
 * seasonEpisodeCounts in the renderer's adapters.ts): a normalizer's own
 * `episodeCounts` wins when present — a grouped anime's `videos` only ever
 * covers its first season, so deriving from it would under-report the
 * franchise — and everything else derives from the episode positions.
 *
 * Doing this once, here, at write time is what lets the index drop `videos`
 * entirely: it is the only thing the grid needed that array for, other than
 * the Completed badge, which is computed against watch history instead.
 *
 * `null` rather than 0 when there is nothing to count, so a query can tell
 * "no episode data" from "confirmed zero episodes" — the same distinction
 * seasonEpisodeCounts is careful to preserve by returning undefined.
 */
function indexEpisodeCounts(
  item: CatalogItem,
  now: number
): {
  totalSeasons: number | null
  totalEpisodes: number | null
  airedEpisodes: number | null
} {
  // The same rule airedEpisodes (renderer/lib/mediaHub/adapters.ts) applies:
  // not synthetic, and either no release date or one already past. `!released`
  // counting as aired is deliberate there and reproduced here — Kitsu's
  // synthesized episodes carry no dates, so for anime this equals the total,
  // which is the answer the in-memory version already reached.
  const aired = (item.videos || []).filter(
    (v) => !v.unplayable && (!v.released || new Date(v.released).getTime() <= now)
  ).length

  if (item.episodeCounts) {
    return {
      totalSeasons: item.episodeCounts.totalSeasons,
      totalEpisodes: item.episodeCounts.totalEpisodes,
      // A grouped anime's `videos` only covers its first season, so counting
      // aired episodes off it would under-report the franchise badly. The
      // supplied total is the better answer, and anime has no per-episode
      // dates to be more precise with anyway.
      airedEpisodes: item.episodeCounts.totalEpisodes
    }
  }
  // `unplayable` entries are synthetic — promotional clips reassigned into a
  // fabricated season 0 by disambiguateVideos — so they are excluded here
  // exactly as the grid excludes them, or they would inflate both counts.
  const playable = (item.videos || []).filter((v) => !v.unplayable)
  if (!playable.length) return { totalSeasons: null, totalEpisodes: null, airedEpisodes: null }
  const seasons = new Set(playable.map((v) => v.season).filter((s) => Number.isFinite(s)))
  return {
    totalSeasons: seasons.size || null,
    totalEpisodes: playable.length,
    airedEpisodes: aired || null
  }
}

/** ASCII unit separator. Matches the `char(31)` indexList joins genres
 *  with -- a delimiter no genre name can contain, unlike a comma. */
const GENRE_DELIMITER = '\u001f'

/**
 * Unpacks the genre list group_concat'd into one column by indexList.
 *
 * NULL when a title has no genre rows at all, which is a normal state — not
 * every source tags every title — so it has to read as "no genres" rather
 * than as one genre named "null".
 */
function splitGenres(value: SQLOutputValue | undefined): string[] {
  if (value == null) return []
  return String(value).split(GENRE_DELIMITER).filter(Boolean)
}

/**
 * The WHERE fragments and bound values for one browse query.
 *
 * Every clause here reproduces a specific line of the renderer's
 * applyCategoryFilters, and the NULL handling is the part worth reading
 * twice — it is where a SQL rewrite most easily changes a filter's meaning
 * without looking like it has:
 *
 *  - `year = ?` excludes rows with no year, because the original compared
 *    `String(releaseYear ?? '')` against the filter and '' never matched.
 *  - `COALESCE(rating,0) >= ?` treats an unrated title as 0, because the
 *    original wrote `(communityRating ?? 0) < minRating`.
 *  - every bucket requires its column to be NOT NULL, because the original
 *    bailed on `item.<field> == null` before it ever ran the test. A title
 *    with no known runtime is not evidence of a short one.
 *
 * A bucket value that resolves to no bucket contributes `0` — matches
 * nothing — rather than being dropped. Dropping it would turn a stale
 * bookmark into "show everything", which is the opposite of what the
 * original's `if (!bucket) return false` did.
 */
function indexWhere(
  query: CatalogQuery,
  profileId: string
): { sql: string; values: Record<string, SQLInputValue>; usesProfile: boolean } {
  const clauses: string[] = ['kind = @kind']
  // Named rather than positional, because the watch-state clauses below
  // reference @profile from inside subqueries and the same value is needed
  // again in the SELECT list — positions would have to be counted by hand
  // across fragments that are only conditionally present.
  const values: Record<string, SQLInputValue> = { kind: query.kind }
  // node:sqlite REJECTS a named parameter the statement does not use
  // ("Unknown named parameter"), so @profile is bound only when a clause
  // actually references it. The count query has no watch-state clause
  // unless one was asked for; the select query always does, because
  // COMPLETED_SQL is in its column list. `usesProfile` is what lets each
  // statement be given exactly the parameters it names.
  let usesProfile = false
  let n = 0
  const bind = (value: SQLInputValue): string => {
    const name = `v${n++}`
    values[name] = value
    return `@${name}`
  }

  if (query.genre) {
    clauses.push(
      `EXISTS (SELECT 1 FROM catalog_index_genre g WHERE g.id = catalog_index.id AND g.kind = catalog_index.kind AND g.genre = ${bind(query.genre)})`
    )
  }
  if (query.year) {
    const year = parseInt(query.year, 10)
    if (Number.isFinite(year)) {
      clauses.push(`year = ${bind(year)}`)
    } else {
      clauses.push('0')
    }
  }
  if (query.minRating != null) {
    clauses.push(`COALESCE(rating, 0) >= ${bind(query.minRating)}`)
  }
  if (query.status) {
    clauses.push(`status = ${bind(query.status)}`)
  }

  const buckets: [string | null | undefined, Bucket[], string][] = [
    [query.runtimeBucket, RUNTIME_BUCKETS, 'runtime_min'],
    [query.seasonsBucket, SEASONS_BUCKETS, 'total_seasons'],
    // Deliberately the same column as the runtime bucket: for a series the
    // stored runtime IS the per-episode length. Different boundaries, one
    // measurement — matching applyCategoryFilters, which reads
    // item.runtimeMinutes for both.
    [query.episodeLengthBucket, EPISODE_LENGTH_BUCKETS, 'runtime_min'],
    [query.episodesBucket, EPISODES_BUCKETS, 'total_episodes']
  ]
  for (const [value, list, column] of buckets) {
    if (!value) continue
    const bucket = findBucket(list, value)
    if (!bucket) {
      clauses.push('0')
      continue
    }
    clauses.push(`${column} IS NOT NULL`)
    if (bucket.min != null) {
      clauses.push(`${column} >= ${bind(bucket.min)}`)
    }
    if (bucket.max != null) {
      clauses.push(`${column} <= ${bind(bucket.max)}`)
    }
  }

  // The watch-state exclusions run HERE, in the same query, not over the
  // returned page — see CatalogQuery's own note on why filtering afterwards
  // makes both the page size and `total` wrong once anything is paged.
  if (query.hideWatched) {
    clauses.push(`NOT ${WATCHED_SQL}`)
    usesProfile = true
  }
  if (query.hideDisliked) {
    clauses.push(`NOT ${DISLIKED_SQL}`)
    usesProfile = true
  }
  if (query.hideCompleted) {
    clauses.push(`NOT ${COMPLETED_SQL}`)
    usesProfile = true
  }
  if (usesProfile) values.profile = profileId

  return { sql: clauses.join(' AND '), values, usesProfile }
}

/**
 * SQL expressions for one profile's relationship to a catalog row.
 *
 * `watched` and `disliked` are exact — they are existence checks against the
 * two tables that define them.
 *
 * `completed` is an APPROXIMATION, and the difference is worth stating rather
 * than discovering. The in-memory version (isSeriesCompleted, via
 * episodeWatchState) intersects the watch history with the actual list of
 * aired episodes, so a history row for an episode the catalog does not list
 * contributes nothing. The index stores the aired COUNT, not the episodes —
 * that is the whole reason a series row is not several KB — so this counts
 * distinct watched (season, episode) pairs and compares against it.
 *
 * The two answers differ only for a title where someone has watched episodes
 * OUTSIDE the catalog's own episode list while still missing some inside it:
 * their outside viewings can push the count over the line early. That needs a
 * catalog entry whose episode list is incomplete for a show the person is
 * partway through, which is uncommon and, when it happens, shows a badge a
 * little early rather than corrupting anything. The detail page still
 * computes the exact answer from real episodes.
 *
 * A movie has no episodes: it is complete exactly when it has been watched,
 * which is what the in-memory version says too.
 */
const WATCHED_SQL =
  'EXISTS (SELECT 1 FROM watch_history wh WHERE wh.profile_id = @profile AND wh.content_id = catalog_index.id)'
const DISLIKED_SQL =
  'EXISTS (SELECT 1 FROM disliked d WHERE d.profile_id = @profile AND d.content_id = catalog_index.id)'
const WATCHED_EPISODES_SQL =
  "(SELECT COUNT(DISTINCT wh.season || ':' || wh.episode) FROM watch_history wh" +
  ' WHERE wh.profile_id = @profile AND wh.content_id = catalog_index.id' +
  ' AND wh.season IS NOT NULL AND wh.episode IS NOT NULL)'
const COMPLETED_SQL =
  `(CASE WHEN catalog_index.kind = 'movie' THEN (${WATCHED_SQL})` +
  ` WHEN catalog_index.aired_episodes IS NULL OR catalog_index.aired_episodes <= 0 THEN 0` +
  ` ELSE (${WATCHED_EPISODES_SQL}) >= catalog_index.aired_episodes END)`

/**
 * The ORDER BY for one sort key.
 *
 * `rank, id` is appended to every one of them, and it is not decoration.
 * JavaScript's Array.prototype.sort is stable, so the in-memory sort this
 * replaces left equal-valued titles in their original (rank) order; SQLite
 * guarantees no such thing. Without an explicit total order, two titles with
 * the same year could swap between two calls — which for a PAGED reader
 * means seeing one of them twice and the other never.
 *
 * COALESCE mirrors the original's `?? 0` on every nullable term, so an
 * unknown year sorts where "year 0" would rather than wherever SQLite
 * happens to put NULL.
 *
 * 'title-asc' was `a.title.localeCompare(b.title)` and is now `ORDER BY
 * title_sort`, a byte comparison. SQLite has no locale-aware collation
 * without ICU, so the equivalence is bought in titleSortKey instead — see
 * catalogFields.ts, which lowercases AND removes diacritics for exactly this
 * reason. Measured across 200,000 random pairs of the real catalog's 3,860
 * titles, that leaves no disagreement with localeCompare; plain lowercasing
 * left 0.019%. Not a proof of equivalence for every script, but no gap this
 * catalog can demonstrate.
 */
function indexOrderBy(sort: CatalogSortKey | undefined): string {
  switch (sort) {
    case 'title-asc':
      return 'ORDER BY title_sort, rank, id'
    case 'year-desc':
      return 'ORDER BY COALESCE(year, 0) DESC, rank, id'
    case 'rating-desc':
      return 'ORDER BY COALESCE(rating, 0) DESC, rank, id'
    case 'runtime-asc':
      return 'ORDER BY COALESCE(runtime_min, 0) ASC, rank, id'
    case 'runtime-desc':
      return 'ORDER BY COALESCE(runtime_min, 0) DESC, rank, id'
    // 'trending' is the crawl's own merged order, which is what `rank` holds.
    default:
      return 'ORDER BY rank, id'
  }
}

/**
 * Rebuilds a CatalogItem from an index row.
 *
 * `videos` is deliberately empty and `episodeCounts` carries the stored
 * totals — the index holds no per-episode data (migration 2), and
 * seasonEpisodeCounts already prefers `episodeCounts` over deriving from
 * `videos`, so the grid's season/episode labels are unaffected by the
 * absence. The Completed badge is the one thing that genuinely needed the
 * positions, and it is resolved against watch history instead.
 *
 * The stringly-typed fields go back out as strings because CatalogItem is
 * what every existing consumer expects; this is a boundary, not a redesign
 * of the shape.
 */
function indexRowToItem(row: Row, kind: MediaKind, genres: string[]): CatalogItem {
  const seasons = row.total_seasons as number | null
  const episodes = row.total_episodes as number | null
  const simklId = row.simkl_id == null ? undefined : Number(row.simkl_id)
  return {
    id: String(row.id),
    title: String(row.title ?? ''),
    type: kind,
    poster: String(row.poster ?? ''),
    background: String(row.background ?? ''),
    logo: String(row.logo ?? ''),
    year: row.year == null ? '' : String(row.year),
    status: String(row.status ?? ''),
    description: String(row.description ?? ''),
    rating: row.rating == null ? '' : String(row.rating),
    runtime: row.runtime_min == null ? '' : `${row.runtime_min} min`,
    genres,
    videos: [],
    trailers: [],
    ...(Number.isFinite(simklId) && simklId ? { simklId } : {}),
    ...(row.grouped_ids ? { groupedIds: parse<string[]>(String(row.grouped_ids), []) } : {}),
    ...(seasons != null && episodes != null
      ? { episodeCounts: { totalSeasons: seasons, totalEpisodes: episodes } }
      : {})
  }
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
    options: { appVersion: string; profiles: Record<string, unknown>[]; activeProfileId: string }
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
  /**
   * Writes viewings brought in from another service, keeping their real
   * dates, in one transaction, without overwriting anything already here.
   *
   * Not markWatched in a loop, for three separate reasons:
   *
   *  - markWatched stamps NOW. A Trakt history is years deep, and dating it
   *    today would put all of it at the top of recently-watched and teach
   *    the cadence profile that this person watches everything at whatever
   *    hour they pressed Import.
   *  - markWatched runs one durable() transaction per row, and durable()
   *    toggles `synchronous` around an fsync. A few thousand rows is a few
   *    thousand fsyncs. This is one.
   *  - markWatched's plays insert is a bare append, so running an import
   *    twice would double every play and report the whole library as
   *    rewatched. These skip a viewing already recorded at the same instant,
   *    which makes the import repeatable.
   *
   * Existing rows are never modified. An import FILLS GAPS: if this profile
   * already has an episode marked, the local date is the one somebody here
   * actually saw happen, and the remote copy does not get to move it.
   *
   * Returns how many viewings were genuinely new.
   */
  importWatched(rows: ImportedPlay[]): number
  /**
   * Writes ratings from another service, skipping every title already rated
   * here. Same gap-filling rule as importWatched, and for the stronger
   * version of the same reason: a score is somebody's opinion, and the one
   * they last gave in this app is the current one.
   */
  importRatings(rows: { id: string; score: number }[]): number
  /**
   * Moves watch history, plays and ratings from one content id onto
   * another, for EVERY profile on the install.
   *
   * Deliberately not profile-scoped, unlike almost everything above: this
   * repairs rows written under an id nothing reads any more (see
   * animeSyncRepair.ts), and those rows belong to whoever happened to be
   * active when the old sync wrote them — a repair that only fixed the
   * profile that happens to be active at launch would leave every other
   * profile's library broken with no way to ask for it again.
   *
   * Rows are moved, never duplicated, and a move that would collide with a
   * row already at the destination is dropped rather than overwriting it:
   * the destination row is the one the app has been reading all along, and
   * its date is the viewing somebody can actually see. Returns how many
   * rows were genuinely relocated.
   */
  remapContentIds(mappings: ContentIdRemap[]): number
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
  /** Many cache rows in ONE transaction — for warms that would otherwise
   *  loop putCache's per-row implicit commits on the main thread. */
  putCacheBatch<T>(rows: Array<{ key: string; payload: T }>, ttlMs: number): void
  getCache<T>(key: string, opts?: { allowExpired?: boolean }): T | null
  /** Removes a cache row outright. Distinct from letting a row expire,
   *  which the `allowExpired: true` readers can still serve back as a
   *  stale fallback — this is for a payload that has become WRONG rather
   *  than merely old, and must not be served again. */
  deleteCache(key: string): void
  /**
   * Records what a crawl saw into the accumulating title index.
   *
   * ACCUMULATES — it never deletes, and `first_seen` is never overwritten.
   * That is the whole point of the table (see migration 2): the catalog it
   * replaces was a single blob rewritten wholesale every six hours, so a
   * title that fell out of Cinemeta's top window fell out of the library
   * with it. Here, a crawl that no longer mentions a title simply leaves its
   * row alone.
   *
   * `rank` is the item's position in `items`, offset by `rankBase` — callers
   * pass the merged, deduped order (Simkl trending first, then Cinemeta's
   * depth), which is the ordering the browse grid's default "trending" sort
   * reproduces. Rows the crawl did NOT see keep whatever rank they had
   * rather than being pushed to the end.
   *
   * One transaction for the whole batch: at full crawl depth this is
   * thousands of rows, and a statement-at-a-time loop outside a transaction
   * is one fsync per row.
   */
  indexUpsert(
    kind: MediaKind,
    items: readonly CatalogItem[],
    opts?: {
      source?: string
      rankBase?: number
      /** Explicit per-item ranks (aligned with `items`), for callers whose
       *  rows carry an absolute catalog position of their own — the LAN
       *  title sync, whose daemon ranks are the same scale as the crawl's.
       *  When present it wins over rankBase+offset for that item. */
      ranks?: readonly number[]
      now?: number
    }
    /** True when the batch COMMITTED. False means the transaction rolled
     *  back (disk full, I/O error) and nothing was written — callers that
     *  advance a bookmark past these rows must not. */
  ): boolean
  /** How many titles of one kind the index holds. This is the real library
   *  size — the number the category hero should be quoting. */
  indexCount(kind: MediaKind): number
  /** Titles of one kind in `rank` order. `videos` comes back empty and
   *  `episodeCounts` carries the stored totals — the index holds no
   *  per-episode data at all (see migration 2). */
  indexList(kind: MediaKind, limit: number, offset?: number): CatalogItem[]
  /** One filtered, sorted, paged slice of the library, plus how many titles
   *  match the filters in total. See indexWhere/indexOrderBy for how each
   *  clause maps onto the in-memory filter it reproduces. */
  indexQuery(query: CatalogQuery): CatalogQueryResult
  /** The genre/year/status values that actually occur for one kind — the
   *  filter bar's dropdown contents, over the whole library rather than
   *  over whatever slice happens to be loaded. */
  indexFacets(kind: MediaKind): CatalogFacets
  /** Rows for exactly these ids, all kinds. A `tt` id can exist as BOTH
   *  a movie and a series row (the two Cinemeta catalogs overlap), so a
   *  caller matching a mixed collection gets every kind-row and dedupes
   *  by its own rules. Exists for stage 4: id-matching surfaces (My
   *  Stuff, the Planned row) read the index instead of scanning a
   *  loaded array, so a tracked title stays visible however small the
   *  candidate pool becomes and however deep the index grows. */
  indexByIds(ids: readonly string[]): { items: CatalogItem[]; completedIds: string[] }
  /** Which of these ids the index already holds for one kind — the
   *  deep-scan skip set. A cheap id-only projection rather than
   *  indexByIds because the caller wants membership, not rows. */
  /** Null when membership could not be established (the lookup itself
   *  failed) — DISTINCT from an empty set. The deep scan advances a
   *  durable bookmark on this answer: claiming everything exists would
   *  make it add nothing AND move on, permanently skipping the chunk. */
  indexExistingIds(kind: MediaKind, ids: readonly string[]): Set<string> | null
  /** The highest rank any row of this kind holds — the floor above which
   *  deep-scanned rows must land to stay UNDER the curated ordering. */
  indexMaxRank(kind: MediaKind): number
  trackedUpdates(details: CatalogItem[], now?: Date): TrackedUpdate[]
  close(): void
  filename: string
}

interface PreparedQueries {
  importWatched: StatementSync
  importPlay: StatementSync
  importRating: StatementSync
  remapWatched: StatementSync
  dropRemappedWatched: StatementSync
  remapPlays: StatementSync
  dropRemappedPlays: StatementSync
  remapRating: StatementSync
  dropRemappedRating: StatementSync
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
  indexPut: StatementSync
  indexClearGenres: StatementSync
  indexPutGenre: StatementSync
  indexCount: StatementSync
  indexList: StatementSync
  facetGenres: StatementSync
  facetYears: StatementSync
  facetStatuses: StatementSync
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
    // The import pair — see importWatched. Both are deliberately
    // non-destructive: DO NOTHING rather than the DO UPDATE `watched` uses,
    // and a NOT EXISTS guard where recordPlay appends unconditionally.
    importWatched: sql.prepare(
      `INSERT INTO watch_history(profile_id,watch_key,content_id,type,title,season,episode,watched_at,metadata_json)
       VALUES(@profile,@key,@id,@type,@title,@season,@episode,@now,@json)
       ON CONFLICT(profile_id,watch_key) DO NOTHING`
    ),
    // Matched on the instant as well as the episode, because that is what
    // makes one viewing the SAME viewing. A genuine rewatch has its own
    // timestamp and is still recorded; re-running the import is not.
    importPlay: sql.prepare(
      `INSERT INTO plays(profile_id,content_id,type,title,season,episode,watched_at,metadata_json)
       SELECT @profile,@id,@type,@title,@season,@episode,@now,@json
       WHERE NOT EXISTS (
         SELECT 1 FROM plays WHERE profile_id=@profile AND content_id=@id
           AND season IS @season AND episode IS @episode AND watched_at=@now
       )`
    ),
    // The repair trio — see remapContentIds. Each is "copy the rows to the
    // new id, letting the primary key drop anything already there", paired
    // with a delete of whatever remains behind at the old id. Not scoped to
    // a profile: the rows being repaired can belong to any of them.
    //
    // Three things have to change together, and missing any one leaves a
    // row that is moved in name only:
    //
    //  - watch_key embeds the id AND the season, so it is rebuilt, not
    //    carried over. The season is cast to INTEGER first: @offset binds
    //    as a float, so a bare CAST(... AS TEXT) yields '2.0' and the key
    //    stops matching the `${id}:${season}:${episode}` form markWatched
    //    writes and unmarkWatched looks up.
    //  - metadata_json carries its own copy of the id, and history() reads
    //    THAT rather than content_id — leave it and every row comes back
    //    still claiming to be the sibling it no longer is.
    //  - type moves to 'anime' in both places, since a row arriving from
    //    an IMDb-keyed Trakt import was written as 'series'.
    remapWatched: sql.prepare(
      `INSERT INTO watch_history(profile_id,watch_key,content_id,type,title,season,episode,watched_at,metadata_json)
       SELECT profile_id,
              @to || ':' || CAST(CAST(season + @offset AS INTEGER) AS TEXT) || ':' || CAST(episode AS TEXT),
              @to,'anime',title,CAST(season + @offset AS INTEGER),episode,watched_at,
              json_set(metadata_json,'$.id',@to,'$.type','anime')
         FROM watch_history
        WHERE content_id=@from AND season IS NOT NULL AND episode IS NOT NULL
       ON CONFLICT(profile_id,watch_key) DO NOTHING`
    ),
    dropRemappedWatched: sql.prepare('DELETE FROM watch_history WHERE content_id=?'),
    // plays has no uniqueness to arbitrate with (it is an append-only
    // record, and a rewatch is legitimately two rows), so the copy is
    // unconditional and the delete below is what stops it doubling.
    remapPlays: sql.prepare(
      `INSERT INTO plays(profile_id,content_id,type,title,season,episode,watched_at,metadata_json)
       SELECT profile_id,@to,'anime',title,CAST(season + @offset AS INTEGER),episode,watched_at,
              json_set(metadata_json,'$.id',@to,'$.type','anime')
         FROM plays
        WHERE content_id=@from AND season IS NOT NULL AND episode IS NOT NULL`
    ),
    dropRemappedPlays: sql.prepare('DELETE FROM plays WHERE content_id=?'),
    // A rating already given to the canonical show wins — same rule as
    // importRating just below, and for the same reason.
    remapRating: sql.prepare(
      `INSERT INTO ratings(profile_id,content_id,score,rated_at)
       SELECT profile_id,@to,score,rated_at FROM ratings WHERE content_id=@from
       ON CONFLICT(profile_id,content_id) DO NOTHING`
    ),
    dropRemappedRating: sql.prepare('DELETE FROM ratings WHERE content_id=?'),
    // No ON CONFLICT clause at all, on purpose: an existing row means this
    // person already said what they thought, here, and the import does not
    // get an opinion about that.
    importRating: sql.prepare(
      `INSERT INTO ratings(profile_id,content_id,score,rated_at)
       VALUES(@profile,@id,@score,@now)
       ON CONFLICT(profile_id,content_id) DO NOTHING`
    ),
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
    // `first_seen` is absent from the DO UPDATE SET on purpose — it is the
    // one column a re-crawl must never touch.
    //
    // The COALESCE(NULLIF(...)) pairs are not decoration. The same title
    // arrives from more than one source (Simkl trending and Cinemeta's depth
    // overlap heavily) and they do not carry the same fields: a Simkl entry
    // has no logo, a Cinemeta one has no simkl_id. A plain `excluded.logo`
    // would let whichever source happened to be written second ERASE a good
    // value with an empty string. Blank never overwrites non-blank.
    indexPut: sql.prepare(
      `INSERT INTO catalog_index(id,kind,title,title_sort,year,rating,runtime_min,status,poster,background,logo,description,total_seasons,total_episodes,aired_episodes,simkl_id,grouped_ids,rank,source,first_seen,updated_at)
       VALUES(@id,@kind,@title,@titleSort,@year,@rating,@runtime,@status,@poster,@background,@logo,@description,@totalSeasons,@totalEpisodes,@airedEpisodes,@simklId,@groupedIds,@rank,@source,@now,@now)
       ON CONFLICT(id,kind) DO UPDATE SET
         title=excluded.title,
         title_sort=excluded.title_sort,
         year=COALESCE(excluded.year,catalog_index.year),
         rating=COALESCE(excluded.rating,catalog_index.rating),
         runtime_min=COALESCE(excluded.runtime_min,catalog_index.runtime_min),
         status=COALESCE(NULLIF(excluded.status,''),catalog_index.status),
         poster=COALESCE(NULLIF(excluded.poster,''),catalog_index.poster),
         background=COALESCE(NULLIF(excluded.background,''),catalog_index.background),
         logo=COALESCE(NULLIF(excluded.logo,''),catalog_index.logo),
         description=COALESCE(NULLIF(excluded.description,''),catalog_index.description),
         total_seasons=COALESCE(excluded.total_seasons,catalog_index.total_seasons),
         total_episodes=COALESCE(excluded.total_episodes,catalog_index.total_episodes),
         aired_episodes=COALESCE(excluded.aired_episodes,catalog_index.aired_episodes),
         simkl_id=COALESCE(excluded.simkl_id,catalog_index.simkl_id),
         grouped_ids=COALESCE(excluded.grouped_ids,catalog_index.grouped_ids),
         rank=excluded.rank,
         source=excluded.source,
         updated_at=excluded.updated_at`
    ),
    // Genres are replaced wholesale per title rather than merged: unlike the
    // scalar fields above, a shorter genre list is a legitimate correction
    // (a source dropping a mis-tagged genre), and there is no way to tell
    // that apart from "this source carries fewer genres" by merging.
    indexClearGenres: sql.prepare('DELETE FROM catalog_index_genre WHERE id=? AND kind=?'),
    indexPutGenre: sql.prepare(
      'INSERT OR IGNORE INTO catalog_index_genre(id,kind,genre) VALUES(?,?,?)'
    ),
    indexCount: sql.prepare('SELECT COUNT(*) AS n FROM catalog_index WHERE kind=?'),
    // Facets deliberately exclude the empty/absent values, matching what the
    // dropdowns did over the loaded array: `if (g)`, `if (item.releaseYear)`,
    // `if (item.status)`. An "unknown" option would filter to nothing.
    facetGenres: sql.prepare(
      "SELECT DISTINCT genre FROM catalog_index_genre WHERE kind=? AND genre<>''"
    ),
    facetYears: sql.prepare(
      'SELECT DISTINCT year FROM catalog_index WHERE kind=? AND year IS NOT NULL ORDER BY year DESC'
    ),
    facetStatuses: sql.prepare(
      "SELECT DISTINCT status FROM catalog_index WHERE kind=? AND status IS NOT NULL AND status<>''"
    ),
    // `, id` is a deliberate tiebreaker, not noise. Without a total order
    // SQLite may return equal-rank rows in any order between calls, and a
    // paged reader would then see the same title twice on two pages while
    // another never appeared at all.
    // Genres come back per row, via a correlated lookup on the genre table's
    // own index, rather than by reading every genre for the kind and joining
    // in JS. At browse scale that difference is the whole cost of the query:
    // one page is 30 rows, and the library it is being drawn from is tens of
    // thousands of titles with several genres each.
    //
    // char(31) — ASCII unit separator — rather than the default comma,
    // because a genre containing the delimiter would otherwise split into
    // two genres that do not exist.
    indexList: sql.prepare(
      `SELECT id,kind,title,year,rating,runtime_min,status,poster,background,logo,description,
              total_seasons,total_episodes,simkl_id,grouped_ids,
              (SELECT group_concat(genre, char(31)) FROM catalog_index_genre g
                WHERE g.id = catalog_index.id AND g.kind = catalog_index.kind) AS genres
       FROM catalog_index WHERE kind=? ORDER BY rank, id LIMIT ? OFFSET ?`
    ),
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
            runtimeByTitle.set(id, runtimeMinutesOrZero(meta.runtime))
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

    importWatched(rows) {
      try {
        const list = Array.isArray(rows) ? rows : []
        if (!list.length) return 0
        let added = 0
        // One transaction for the whole import — see the interface comment.
        durable(() => {
          sql.exec('BEGIN')
          try {
            for (const row of list) {
              const value = normalizeTitle({ ...row, id: row.id })
              const season = Number.isFinite(row.season) ? (row.season as number) : null
              const episode = Number.isFinite(row.episode) ? (row.episode as number) : null
              const params = {
                profile: currentProfileId,
                id: value.id,
                type: value.type,
                title: value.title,
                season,
                episode,
                now: row.watchedAt,
                json: JSON.stringify(value)
              }
              q.importWatched.run({
                ...params,
                key: `${value.id}:${season ?? 'movie'}:${episode ?? 'movie'}`
              })
              added += Number(q.importPlay.run(params).changes || 0)
            }
            sql.exec('COMMIT')
          } catch (error) {
            sql.exec('ROLLBACK')
            throw error
          }
        })
        return added
      } catch (error) {
        return fail(error as Error) as unknown as number
      }
    },

    importRatings(rows) {
      try {
        const list = Array.isArray(rows) ? rows : []
        if (!list.length) return 0
        const now = new Date().toISOString()
        let added = 0
        durable(() => {
          sql.exec('BEGIN')
          try {
            for (const row of list) {
              const score = Math.round(Number(row?.score))
              // Out of range is dropped rather than clamped. A score this app
              // cannot represent is not somebody's opinion rounded — it is a
              // row we did not understand, and guessing at it would write an
              // opinion nobody gave.
              if (!Number.isFinite(score) || score < MIN_RATING || score > MAX_RATING) continue
              added += Number(
                q.importRating.run({
                  profile: currentProfileId,
                  id: String(row.id),
                  score,
                  now
                }).changes || 0
              )
            }
            sql.exec('COMMIT')
          } catch (error) {
            sql.exec('ROLLBACK')
            throw error
          }
        })
        return added
      } catch (error) {
        return fail(error as Error) as unknown as number
      }
    },

    remapContentIds(mappings) {
      try {
        const list = Array.isArray(mappings) ? mappings : []
        if (!list.length) return 0
        let moved = 0
        durable(() => {
          sql.exec('BEGIN')
          try {
            for (const map of list) {
              const from = String(map.fromId)
              const to = String(map.toId)
              const offset = Number(map.seasonOffset) || 0
              if (!from || !to || from === to) continue

              // Every profile at once, and every row of that id — see the
              // interface comment for why this one method is not scoped to
              // the active profile.
              //
              // OR IGNORE, then DELETE what did not move: node:sqlite has
              // no UPDATE ... ON CONFLICT, and an UPDATE that collides with
              // an existing destination row would abort the whole
              // transaction. Inserting the moved copy first lets the
              // primary keys arbitrate — a destination row already there
              // wins and the source is simply dropped.
              moved += Number(q.remapWatched.run({ from, to, offset }).changes || 0)
              q.dropRemappedWatched.run(from)

              q.remapPlays.run({ from, to, offset })
              q.dropRemappedPlays.run(from)

              q.remapRating.run({ from, to })
              q.dropRemappedRating.run(from)
            }
            sql.exec('COMMIT')
          } catch (error) {
            sql.exec('ROLLBACK')
            throw error
          }
        })
        return moved
      } catch (error) {
        return fail(error as Error) as unknown as number
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

    putCacheBatch<T>(rows: Array<{ key: string; payload: T }>, ttlMs: number): void {
      // One transaction, not N implicit commits. DatabaseSync runs on the
      // main thread, so a caller looping putCache over hundreds of rows
      // (the TorBox library warm on the play click was the live case) is a
      // single uninterruptible block whose length is dominated by per-row
      // commit overhead; batched, the same warm is one commit. Same
      // best-effort contract as putCache — a rollback loses a cache warm,
      // never data.
      try {
        const now = Date.now()
        sql.exec('BEGIN')
        try {
          for (const row of rows) {
            q.putCache.run(row.key, JSON.stringify(row.payload), now + ttlMs, now)
          }
          sql.exec('COMMIT')
        } catch (error) {
          sql.exec('ROLLBACK')
          throw error
        }
      } catch {
        // Best-effort, same convention as putCache.
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

    indexUpsert(kind, items, { source = '', rankBase = 0, ranks, now = Date.now() } = {}) {
      if (!items.length) return true
      try {
        sql.exec('BEGIN')
        try {
          items.forEach((item, offset) => {
            const id = String(item?.id || '')
            // An idless entry is what a malformed source record normalizes
            // to (see normalizeMeta) — it can never be routed to, opened or
            // played, so it must not take a row.
            if (!id) return
            const counts = indexEpisodeCounts(item, now)
            q.indexPut.run({
              id,
              kind,
              title: String(item.title || ''),
              titleSort: titleSortKey(item.title),
              year: parseYear(item.year) ?? null,
              rating: parseRating(item.rating) ?? null,
              runtime: parseRuntimeMinutes(item.runtime) ?? null,
              status: String(item.status || ''),
              poster: String(item.poster || ''),
              background: String(item.background || ''),
              logo: String(item.logo || ''),
              description: String(item.description || ''),
              // Prefer the normalizer's own combined totals when it supplied
              // them (grouped anime), and otherwise derive from the episode
              // positions this item still carries — the SAME precedence the
              // browse grid's seasonEpisodeCounts already applies. Deriving
              // it once here is what lets the index drop `videos` entirely.
              totalSeasons: counts.totalSeasons,
              totalEpisodes: counts.totalEpisodes,
              airedEpisodes: counts.airedEpisodes,
              simklId: item.simklId != null ? String(item.simklId) : null,
              groupedIds: item.groupedIds?.length ? JSON.stringify(item.groupedIds) : null,
              rank: ranks?.[offset] ?? rankBase + offset,
              source,
              now
            })
            q.indexClearGenres.run(id, kind)
            for (const genre of item.genres || []) {
              const name = String(genre || '').trim()
              if (name) q.indexPutGenre.run(id, kind, name)
            }
          })
          sql.exec('COMMIT')
        } catch (error) {
          sql.exec('ROLLBACK')
          throw error
        }
        return true
      } catch {
        // Best-effort, like every other cache write here. A failed index
        // write costs this crawl's contribution and nothing else — the rows
        // already in the index are untouched, and the next crawl retries.
        // The FALSE return is for the one caller that advances a durable
        // bookmark: reporting rows as added while the transaction rolled
        // back would skip them forever.
        return false
      }
    },

    indexCount(kind) {
      try {
        return Number((q.indexCount.get(kind) as Row | undefined)?.n ?? 0)
      } catch {
        return 0
      }
    },

    indexList(kind, limit, offset = 0) {
      try {
        return (q.indexList.all(kind, limit, offset) as Row[]).map((row) =>
          indexRowToItem(row, kind, splitGenres(row.genres))
        )
      } catch {
        return []
      }
    },

    indexByIds(ids) {
      // Chunked: SQLite's bound-parameter ceiling is generous but a
      // watched-history id list is unbounded in principle, and 400 per
      // statement keeps every statement comfortably small.
      //
      // completedIds rides along for the same reason indexQuery carries
      // it: these rows come back with no episode data (the index stores
      // none), so `completed` is only derivable HERE, where the SQL can
      // join watch history against aired counts. Without it, every
      // id-fetched show read as un-completed and My Stuff's completed
      // badges and hideCompleted preference quietly broke.
      const out: CatalogItem[] = []
      const completedIds: string[] = []
      try {
        for (let start = 0; start < ids.length; start += 400) {
          const chunk = ids.slice(start, start + 400).filter((id) => typeof id === 'string')
          if (!chunk.length) continue
          // Named parameters throughout: COMPLETED_SQL binds @profile,
          // and one statement cannot mix ?-positional with named.
          const params: Record<string, string> = { profile: currentProfileId }
          chunk.forEach((id, i) => {
            params[`id${i}`] = id
          })
          const marks = chunk.map((_, i) => `@id${i}`).join(',')
          const rows = sql
            .prepare(
              `SELECT id,kind,title,year,rating,runtime_min,status,poster,background,logo,description,
                      total_seasons,total_episodes,simkl_id,grouped_ids,
                      (SELECT group_concat(genre, char(31)) FROM catalog_index_genre g
                        WHERE g.id = catalog_index.id AND g.kind = catalog_index.kind) AS genres,
                      ${COMPLETED_SQL} AS completed
               FROM catalog_index WHERE id IN (${marks})`
            )
            .all(params) as Row[]
          for (const row of rows) {
            out.push(indexRowToItem(row, String(row.kind) as MediaKind, splitGenres(row.genres)))
            if (Number(row.completed) === 1) completedIds.push(String(row.id))
          }
        }
        return { items: out, completedIds }
      } catch (error) {
        // Same reasoning as indexQuery: an empty answer here renders as
        // "you have nothing tracked", which is a claim — log it.
        logError('catalog:index:by-ids', error)
        return { items: out, completedIds }
      }
    },

    indexMaxRank(kind) {
      try {
        const row = sql
          .prepare('SELECT MAX(rank) AS r FROM catalog_index WHERE kind = ?')
          .get(kind) as Row | undefined
        const value = Number(row?.r)
        return Number.isFinite(value) ? value : 0
      } catch {
        // Zero makes the caller fall back to its own offset-derived
        // floor — depth may interleave a little, nothing is lost.
        return 0
      }
    },

    indexExistingIds(kind, ids) {
      const found = new Set<string>()
      try {
        for (let start = 0; start < ids.length; start += 400) {
          const chunk = ids.slice(start, start + 400).filter((id) => typeof id === 'string')
          if (!chunk.length) continue
          const marks = chunk.map(() => '?').join(',')
          const rows = sql
            .prepare(`SELECT id FROM catalog_index WHERE kind = ? AND id IN (${marks})`)
            .all(kind, ...chunk) as Row[]
          for (const row of rows) found.add(String(row.id))
        }
        // A grouped SIBLING exists too, under its canonical row. The
        // grouping pass removes sibling rows and records their ids only
        // in grouped_ids, so an id-column check alone would call a
        // returning franchise season "new" and insert it as a separate
        // ungrouped title beside its own franchise — permanently, since
        // the skip rule then protects the duplicate. One pass over the
        // grouped rows closes that door.
        const requested = new Set(ids)
        const groupedRows = sql
          .prepare(
            `SELECT grouped_ids FROM catalog_index WHERE kind = ? AND grouped_ids IS NOT NULL`
          )
          .all(kind) as Row[]
        for (const row of groupedRows) {
          const members = parse<string[]>(String(row.grouped_ids), [])
          for (const member of members) {
            if (requested.has(String(member))) found.add(String(member))
          }
        }
      } catch (error) {
        // NULL, not "everything exists". Fail-closed-as-full-set had the
        // right instinct (never re-upsert what the grouping pass curated)
        // but the wrong consequence: the deep scan would add nothing and
        // still advance its durable bookmark past the whole chunk,
        // permanently skipping those titles. Null says "I could not
        // answer" — the caller halts, and the next pass retries.
        logError('catalog:index:existing', error)
        return null
      }
      return found
    },

    indexQuery(query) {
      // Built and prepared per call rather than kept in `q`, because the
      // shape genuinely varies: eight optional filters is 256 combinations,
      // and precompiling them all to avoid one prepare on a keystroke-driven
      // path would be the wrong trade.
      try {
        const where = indexWhere(query, currentProfileId)
        const limit = Math.max(0, Math.min(query.limit ?? 60, 500))
        const offset = Math.max(0, query.offset ?? 0)
        const total = Number(
          (
            sql
              .prepare(`SELECT COUNT(*) AS n FROM catalog_index WHERE ${where.sql}`)
              .get(where.values) as Row | undefined
          )?.n ?? 0
        )
        const rows = sql
          .prepare(
            `SELECT id,kind,title,year,rating,runtime_min,status,poster,background,logo,description,
                    total_seasons,total_episodes,simkl_id,grouped_ids,
                    (SELECT group_concat(genre, char(31)) FROM catalog_index_genre g
                      WHERE g.id = catalog_index.id AND g.kind = catalog_index.kind) AS genres,
                    ${COMPLETED_SQL} AS completed
             FROM catalog_index WHERE ${where.sql} ${indexOrderBy(query.sort)}
             LIMIT @limit OFFSET @offset`
          )
          .all({ ...where.values, profile: currentProfileId, limit, offset }) as Row[]
        return {
          items: rows.map((row) => indexRowToItem(row, query.kind, splitGenres(row.genres))),
          total,
          completedIds: rows
            .filter((row) => Number(row.completed) === 1)
            .map((row) => String(row.id))
        }
      } catch (error) {
        // LOGGED, unlike every other catch in this file, and deliberately so.
        // The rest guard operations whose failure shows up another way — a
        // cache miss refetches, a failed write is retried. This one returns an
        // empty page, which the grid renders as "nothing matches your filter":
        // a broken query and a genuinely empty result look identical to the
        // person AND to the next developer. That is not hypothetical — a
        // parameter-binding bug during this work produced exactly that, an
        // empty grid with nothing anywhere saying why.
        //
        // Still returns rather than throws: an empty grid is survivable, a
        // blank window is not.
        logError('catalog:index:query', error)
        return { items: [], total: 0, completedIds: [] }
      }
    },

    indexFacets(kind) {
      // Ordering matches what the dropdowns already did over the loaded
      // array: genres and statuses by localeCompare, years newest first.
      // localeCompare is applied here in JS rather than by SQL for the same
      // reason indexOrderBy documents — SQLite has no locale-aware
      // collation — and it is affordable here because a facet list is
      // dozens of values, not tens of thousands of rows.
      try {
        const genres = (q.facetGenres.all(kind) as Row[]).map((row) => String(row.genre))
        const years = (q.facetYears.all(kind) as Row[]).map((row) => Number(row.year))
        const statuses = (q.facetStatuses.all(kind) as Row[]).map((row) => String(row.status))
        return {
          genres: genres.sort((a, b) => a.localeCompare(b)),
          years,
          statuses: statuses.sort((a, b) => a.localeCompare(b))
        }
      } catch (error) {
        // Same reasoning as indexQuery: empty facets read as "this library
        // has no genres", which is a claim, not an absence.
        logError('catalog:index:facets', error)
        return { genres: [], years: [], statuses: [] }
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
