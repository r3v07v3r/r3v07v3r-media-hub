// Local SQLite persistence for the media-hub integration — ported from
// r3v07v3r-media-hub's `src/database.cjs`, logic preserved 1:1 (same table
// schema, same migration guard, same upsert clauses, same sort orders).
// Only the typing is new: node:sqlite's `DatabaseSync`/`StatementSync` come
// from this project's bundled @types/node (see node_modules/@types/node/
// sqlite.d.ts) which already ships the v22 `node:sqlite` surface, so no
// ambient declarations were needed here.
import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite'
import type {
  CatalogItem,
  Episode,
  HistoryEntry,
  MediaKind,
  TrackedItem,
  TrackedUpdate
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
}

export interface EpisodePlaybackPosition extends PlaybackPositionResult {
  season: number | null
  episode: number | null
}

export interface MediaHubDatabase {
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
    durationSeconds?: number
  ): void
  getPlaybackPosition(
    contentId: string | number,
    playback?: { season?: number; episode?: number }
  ): PlaybackPositionResult | null
  /** Every stored bookmark for one title at once — see
   *  EpisodePlaybackPosition (shared/media-hub/types.ts) for why the
   *  episode grid needs the whole set rather than one lookup per row. */
  listPlaybackPositions(contentId: string | number): EpisodePlaybackPosition[]
  putCache<T>(key: string, payload: T, ttlMs: number): void
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
  listPositions: StatementSync
}

export function createDatabase(filename: string): MediaHubDatabase {
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

  sql.exec(`CREATE TABLE IF NOT EXISTS tracked(
    content_id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    poster TEXT,
    metadata_json TEXT NOT NULL,
    tracked_at TEXT NOT NULL,
    baseline_season INTEGER NOT NULL DEFAULT 0,
    baseline_episode INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS watch_history(
    watch_key TEXT PRIMARY KEY,
    content_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    season INTEGER,
    episode INTEGER,
    watched_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS catalog_cache(
    cache_key TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS disliked(
    content_id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    poster TEXT,
    metadata_json TEXT NOT NULL,
    disliked_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS playback_positions(
    position_key TEXT PRIMARY KEY,
    content_id TEXT NOT NULL,
    season INTEGER,
    episode INTEGER,
    position_seconds REAL NOT NULL,
    duration_seconds REAL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_history_content ON watch_history(content_id, watched_at DESC);`)

  // Migration guard: only ALTER an existing database file that predates the
  // baseline_* columns. Re-running this against a fresh DB (columns already
  // present via CREATE TABLE above) must be a no-op.
  const columns = new Set(
    sql
      .prepare('PRAGMA table_info(tracked)')
      .all()
      .map((x) => (x as Row).name as string)
  )
  if (!columns.has('baseline_season')) {
    sql.exec('ALTER TABLE tracked ADD COLUMN baseline_season INTEGER NOT NULL DEFAULT 0')
  }
  if (!columns.has('baseline_episode')) {
    sql.exec('ALTER TABLE tracked ADD COLUMN baseline_episode INTEGER NOT NULL DEFAULT 0')
  }

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

  const q: PreparedQueries = {
    track: sql.prepare(
      `INSERT INTO tracked(content_id,type,title,poster,metadata_json,tracked_at,baseline_season,baseline_episode)
       VALUES(@id,@type,@title,@poster,@json,@now,@baselineSeason,@baselineEpisode)
       ON CONFLICT(content_id) DO UPDATE SET type=excluded.type,title=excluded.title,poster=excluded.poster,metadata_json=excluded.metadata_json`
    ),
    untrack: sql.prepare('DELETE FROM tracked WHERE content_id=?'),
    isTracked: sql.prepare('SELECT 1 FROM tracked WHERE content_id=?'),
    tracked: sql.prepare('SELECT metadata_json FROM tracked ORDER BY tracked_at DESC'),
    trackedRows: sql.prepare(
      'SELECT content_id,metadata_json,baseline_season,baseline_episode FROM tracked ORDER BY tracked_at DESC'
    ),
    watched: sql.prepare(
      `INSERT INTO watch_history(watch_key,content_id,type,title,season,episode,watched_at,metadata_json)
       VALUES(@key,@id,@type,@title,@season,@episode,@now,@json)
       ON CONFLICT(watch_key) DO UPDATE SET watched_at=excluded.watched_at,metadata_json=excluded.metadata_json`
    ),
    unwatch: sql.prepare('DELETE FROM watch_history WHERE watch_key=?'),
    history: sql.prepare(
      'SELECT metadata_json,season,episode,watched_at FROM watch_history ORDER BY watched_at DESC'
    ),
    dislike: sql.prepare(
      `INSERT INTO disliked(content_id,type,title,poster,metadata_json,disliked_at)
       VALUES(@id,@type,@title,@poster,@json,@now)
       ON CONFLICT(content_id) DO UPDATE SET type=excluded.type,title=excluded.title,poster=excluded.poster,metadata_json=excluded.metadata_json`
    ),
    undislike: sql.prepare('DELETE FROM disliked WHERE content_id=?'),
    isDisliked: sql.prepare('SELECT 1 FROM disliked WHERE content_id=?'),
    disliked: sql.prepare('SELECT metadata_json FROM disliked ORDER BY disliked_at DESC'),
    putCache: sql.prepare(
      `INSERT INTO catalog_cache(cache_key,payload_json,expires_at,updated_at) VALUES(?,?,?,?)
       ON CONFLICT(cache_key) DO UPDATE SET payload_json=excluded.payload_json,expires_at=excluded.expires_at,updated_at=excluded.updated_at`
    ),
    getCache: sql.prepare('SELECT payload_json,expires_at FROM catalog_cache WHERE cache_key=?'),
    deleteCache: sql.prepare('DELETE FROM catalog_cache WHERE cache_key=?'),
    lastEpisode: sql.prepare(
      'SELECT season,episode FROM watch_history WHERE content_id=? AND season IS NOT NULL ORDER BY season DESC,episode DESC LIMIT 1'
    ),
    savePosition: sql.prepare(
      `INSERT INTO playback_positions(position_key,content_id,season,episode,position_seconds,duration_seconds,updated_at)
       VALUES(@key,@id,@season,@episode,@position,@duration,@now)
       ON CONFLICT(position_key) DO UPDATE SET position_seconds=excluded.position_seconds,duration_seconds=excluded.duration_seconds,updated_at=excluded.updated_at`
    ),
    clearPosition: sql.prepare('DELETE FROM playback_positions WHERE position_key=?'),
    getPosition: sql.prepare(
      'SELECT position_seconds,duration_seconds FROM playback_positions WHERE position_key=?'
    ),
    listPositions: sql.prepare(
      'SELECT season,episode,position_seconds,duration_seconds FROM playback_positions WHERE content_id=?'
    )
  }

  const db: MediaHubDatabase = {
    track(item, now = new Date()) {
      try {
        const value = normalizeTitle(item)
        const baseline = latestReleased(item.videos as EpisodeLike[] | undefined, now)
        durable(() =>
          q.track.run({
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
        return durable(() => q.untrack.run(String(id)).changes > 0)
      } catch (error) {
        return fail(error as Error)
      }
    },

    isTracked(id) {
      try {
        return Boolean(q.isTracked.get(String(id)))
      } catch (error) {
        return fail(error as Error)
      }
    },

    tracked() {
      try {
        return q.tracked
          .all()
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
        durable(() =>
          q.watched.run({
            key,
            id: value.id,
            type: value.type,
            title: value.title,
            season,
            episode,
            now: new Date().toISOString(),
            json: JSON.stringify(value)
          })
        )
        return value
      } catch (error) {
        return fail(error as Error)
      }
    },

    unmarkWatched(id, season, episode) {
      try {
        const key = `${String(id)}:${Number.isFinite(season) ? season : 'movie'}:${Number.isFinite(episode) ? episode : 'movie'}`
        return durable(() => q.unwatch.run(key).changes > 0)
      } catch (error) {
        return fail(error as Error)
      }
    },

    history() {
      try {
        return q.history.all().map((r) => {
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
        return durable(() => q.undislike.run(String(id)).changes > 0)
      } catch (error) {
        return fail(error as Error)
      }
    },

    isDisliked(id) {
      try {
        return Boolean(q.isDisliked.get(String(id)))
      } catch (error) {
        return fail(error as Error)
      }
    },

    disliked() {
      try {
        return q.disliked
          .all()
          .map((r) => parse<TrackedItem>((r as Row).metadata_json as string, {} as TrackedItem))
      } catch (error) {
        return fail(error as Error)
      }
    },

    preferredGenres(limit = 3) {
      const counts = new Map<string, number>()
      for (const item of db.history()) {
        for (const genre of item.genres || []) {
          counts.set(genre, (counts.get(genre) || 0) + 1)
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
    savePlaybackPosition(contentId, playback, positionSeconds, durationSeconds) {
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
          durable(() => q.clearPosition.run(key))
          return
        }
        durable(() =>
          q.savePosition.run({
            key,
            id,
            season,
            episode,
            position: positionSeconds,
            duration:
              typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)
                ? durationSeconds
                : null,
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
        const row = q.getPosition.get(key) as Row | undefined
        if (!row) return null
        return {
          positionSeconds: row.position_seconds as number,
          durationSeconds: (row.duration_seconds as number | null) ?? null
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
        return (q.listPositions.all(String(contentId)) as Row[]).map((row) => ({
          season: (row.season as number | null) ?? null,
          episode: (row.episode as number | null) ?? null,
          positionSeconds: row.position_seconds as number,
          durationSeconds: (row.duration_seconds as number | null) ?? null
        }))
      } catch {
        return []
      }
    },

    putCache<T>(key: string, payload: T, ttlMs: number): void {
      try {
        const now = Date.now()
        q.putCache.run(key, JSON.stringify(payload), now + ttlMs, now)
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
        for (const r of q.trackedRows.all()) {
          const row = r as Row
          const tracked = parse<TrackedItem>(row.metadata_json as string, {} as TrackedItem)
          const detail = byId.get(String(row.content_id))
          if (!detail) continue

          const watchedRow = q.lastEpisode.get(row.content_id as string) as Row | undefined
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
