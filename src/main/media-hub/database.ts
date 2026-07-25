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

function episodePosition(v: EpisodeLike): EpisodePosition {
  return { season: Number(v.season) || 1, episode: Number(v.episode ?? v.number) || 0 }
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
  preferredGenres(limit?: number): string[]
  putCache<T>(key: string, payload: T, ttlMs: number): void
  getCache<T>(key: string, opts?: { allowExpired?: boolean }): T | null
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
  putCache: StatementSync
  getCache: StatementSync
  lastEpisode: StatementSync
}

export function createDatabase(filename: string): MediaHubDatabase {
  const sql = new DatabaseSync(filename)
  sql.exec('PRAGMA journal_mode = WAL')
  sql.exec('PRAGMA foreign_keys = ON')

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
    putCache: sql.prepare(
      `INSERT INTO catalog_cache(cache_key,payload_json,expires_at,updated_at) VALUES(?,?,?,?)
       ON CONFLICT(cache_key) DO UPDATE SET payload_json=excluded.payload_json,expires_at=excluded.expires_at,updated_at=excluded.updated_at`
    ),
    getCache: sql.prepare('SELECT payload_json,expires_at FROM catalog_cache WHERE cache_key=?'),
    lastEpisode: sql.prepare(
      'SELECT season,episode FROM watch_history WHERE content_id=? AND season IS NOT NULL ORDER BY season DESC,episode DESC LIMIT 1'
    )
  }

  const db: MediaHubDatabase = {
    track(item, now = new Date()) {
      try {
        const value = normalizeTitle(item)
        const baseline = latestReleased(item.videos as EpisodeLike[] | undefined, now)
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
        return value
      } catch (error) {
        return fail(error as Error)
      }
    },

    untrack(id) {
      try {
        return q.untrack.run(String(id)).changes > 0
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
        return value
      } catch (error) {
        return fail(error as Error)
      }
    },

    unmarkWatched(id, season, episode) {
      try {
        const key = `${String(id)}:${Number.isFinite(season) ? season : 'movie'}:${Number.isFinite(episode) ? episode : 'movie'}`
        return q.unwatch.run(key).changes > 0
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
