// The database's schema, as an ordered list of versions.
//
// WHY THIS REPLACED WHAT WAS HERE. The schema used to be one
// `CREATE TABLE IF NOT EXISTS` block followed by a `PRAGMA table_info` probe
// per column added since — read the columns back, check whether the new one
// is among them, `ALTER TABLE` if not. That works for exactly as long as
// every change is an added column with a default. It has no answer for a
// changed primary key, a table that has to be rebuilt, or a backfill that
// must run once and never again, and each new column added another probe to
// a list nothing kept in order.
//
// `PRAGMA user_version` is SQLite's own answer: a plain integer stored in the
// file header, free to read, and written inside the same transaction as the
// migration that earned it. A database at version N has had migrations 0..N-1
// applied, in order, and no others.
//
// RULES FOR ADDING ONE. Append; never edit a released entry, and never
// renumber. A migration that has already run somewhere is history, and
// rewriting it only means two installs with the same version number and
// different schemas. Each entry must be safe on a database that has had every
// earlier entry applied and nothing more — which is the only state it can
// ever encounter, precisely because the version is written transactionally.

import type { DatabaseSync } from 'node:sqlite'
import { hasExpressibleSimklId } from '../../shared/media-hub/serviceIds'
import { logError } from './logger'

interface Migration {
  /** Human label, for the log line — the version number is the index. */
  readonly name: string
  /** `profileId` is the profile every pre-existing row is attributed to; see
   *  migration 1, the only one that has ever needed it. */
  apply(sql: DatabaseSync, profileId: string): void
}

/**
 * Migration 0 — the baseline, as the schema stood before versioning existed.
 *
 * Deliberately still written with `IF NOT EXISTS` and the original column
 * probes, because it has to be a no-op on the installs that already have this
 * schema and a `user_version` of 0. Those two cases — a database created
 * before versioning and a database created after it — must both come out of
 * this function identical, and the only way to guarantee that is to keep
 * doing exactly what the old code did.
 */
const baseline: Migration = {
  name: 'baseline',
  apply(sql) {
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
      volume REAL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_history_content ON watch_history(content_id, watched_at DESC);`)

    // The pre-versioning column guards, preserved verbatim. A database
    // created by the block above already has all three, which is what makes
    // re-running this harmless.
    addColumnIfMissing(sql, 'tracked', 'baseline_season', 'INTEGER NOT NULL DEFAULT 0')
    addColumnIfMissing(sql, 'tracked', 'baseline_episode', 'INTEGER NOT NULL DEFAULT 0')
    addColumnIfMissing(sql, 'playback_positions', 'volume', 'REAL')
  }
}

/**
 * Migration 1 — a profile owns its library, and a play is a record rather
 * than a flag.
 *
 * Two changes that have to happen together, because both rebuild the same
 * tables and doing them in two passes would copy every row twice.
 *
 * PROFILE SCOPING. `tracked`, `watch_history`, `disliked` and
 * `playback_positions` were keyed by content alone, so every profile on the
 * install shared one library, one history and one set of resume points — a
 * Kids profile showed an adult's Continue Watching. SQLite cannot alter a
 * primary key, so each table is rebuilt with a composite one and its rows
 * copied across, attributed to `profileId`: before this migration there was
 * only one library, and it belonged to whoever was using the app.
 *
 * PLAYS. `watch_history` upserts on (content, season, episode), so watching
 * an episode a second time overwrote the record of the first — the row moved
 * its timestamp and the earlier viewing was gone. It stays as the "have I
 * seen this" index every grid and badge already reads, and `plays` becomes
 * the append-only record beside it. The backfill gives every existing history
 * row one play, which is the most that can honestly be reconstructed: the
 * rows that were overwritten cannot be recovered, and inventing a count would
 * be worse than starting an accurate one now.
 */
const profilesAndPlays: Migration = {
  name: 'profile-scoping-and-plays',
  apply(sql, profileId) {
    sql.exec(`
      CREATE TABLE tracked_new(
        profile_id TEXT NOT NULL,
        content_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        poster TEXT,
        metadata_json TEXT NOT NULL,
        tracked_at TEXT NOT NULL,
        baseline_season INTEGER NOT NULL DEFAULT 0,
        baseline_episode INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(profile_id, content_id)
      );
      INSERT INTO tracked_new(profile_id,content_id,type,title,poster,metadata_json,tracked_at,baseline_season,baseline_episode)
        SELECT '${escape(profileId)}',content_id,type,title,poster,metadata_json,tracked_at,baseline_season,baseline_episode FROM tracked;
      DROP TABLE tracked;
      ALTER TABLE tracked_new RENAME TO tracked;

      CREATE TABLE watch_history_new(
        profile_id TEXT NOT NULL,
        watch_key TEXT NOT NULL,
        content_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        season INTEGER,
        episode INTEGER,
        watched_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        PRIMARY KEY(profile_id, watch_key)
      );
      INSERT INTO watch_history_new(profile_id,watch_key,content_id,type,title,season,episode,watched_at,metadata_json)
        SELECT '${escape(profileId)}',watch_key,content_id,type,title,season,episode,watched_at,metadata_json FROM watch_history;
      DROP TABLE watch_history;
      ALTER TABLE watch_history_new RENAME TO watch_history;
      CREATE INDEX idx_history_content ON watch_history(profile_id, content_id, watched_at DESC);

      CREATE TABLE disliked_new(
        profile_id TEXT NOT NULL,
        content_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        poster TEXT,
        metadata_json TEXT NOT NULL,
        disliked_at TEXT NOT NULL,
        PRIMARY KEY(profile_id, content_id)
      );
      INSERT INTO disliked_new(profile_id,content_id,type,title,poster,metadata_json,disliked_at)
        SELECT '${escape(profileId)}',content_id,type,title,poster,metadata_json,disliked_at FROM disliked;
      DROP TABLE disliked;
      ALTER TABLE disliked_new RENAME TO disliked;

      CREATE TABLE playback_positions_new(
        profile_id TEXT NOT NULL,
        position_key TEXT NOT NULL,
        content_id TEXT NOT NULL,
        season INTEGER,
        episode INTEGER,
        position_seconds REAL NOT NULL,
        duration_seconds REAL,
        volume REAL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(profile_id, position_key)
      );
      INSERT INTO playback_positions_new(profile_id,position_key,content_id,season,episode,position_seconds,duration_seconds,volume,updated_at)
        SELECT '${escape(profileId)}',position_key,content_id,season,episode,position_seconds,duration_seconds,volume,updated_at FROM playback_positions;
      DROP TABLE playback_positions;
      ALTER TABLE playback_positions_new RENAME TO playback_positions;
      CREATE INDEX idx_positions_content ON playback_positions(profile_id, content_id);

      CREATE TABLE plays(
        play_id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id TEXT NOT NULL,
        content_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        season INTEGER,
        episode INTEGER,
        watched_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );
      CREATE INDEX idx_plays_content ON plays(profile_id, content_id, watched_at DESC);
      CREATE INDEX idx_plays_recent ON plays(profile_id, watched_at DESC);
      INSERT INTO plays(profile_id,content_id,type,title,season,episode,watched_at,metadata_json)
        SELECT profile_id,content_id,type,title,season,episode,watched_at,metadata_json FROM watch_history;

      CREATE TABLE ratings(
        profile_id TEXT NOT NULL,
        content_id TEXT NOT NULL,
        score INTEGER NOT NULL,
        rated_at TEXT NOT NULL,
        PRIMARY KEY(profile_id, content_id)
      );

      CREATE TABLE lists(
        list_id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_lists_profile ON lists(profile_id, sort_order);

      CREATE TABLE list_items(
        list_id TEXT NOT NULL,
        content_id TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        added_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        PRIMARY KEY(list_id, content_id),
        FOREIGN KEY(list_id) REFERENCES lists(list_id) ON DELETE CASCADE
      );
    `)
  }
}

/**
 * Migration 2 — the accumulating title index.
 *
 * The browse catalog used to live in `catalog_cache` as ONE row per kind: a
 * single JSON blob holding the whole crawl, rewritten wholesale every six
 * hours and read back in full on every `catalog:list`. That shape is what
 * capped the library — not the sources, which go far deeper (Cinemeta still
 * returns full pages past skip=20000 for movies, and Kitsu reports 22,317
 * anime). A blob has to be small enough to parse and ship on the launch path,
 * so the crawl had to stay shallow, and every refresh REPLACED it — a title
 * that fell out of Cinemeta's top window fell out of the library with it.
 *
 * Rows here accumulate instead. A crawl upserts what it saw and touches
 * nothing else, so the index only ever grows and `first_seen` survives every
 * later refresh of the same title.
 *
 * NOT profile-scoped, unlike migration 1's tables. This is shared cache data,
 * the same as `catalog_cache` (which migration 1 also left alone): what
 * Cinemeta lists is not a fact about who is signed in, and duplicating tens
 * of thousands of rows per profile would be pure waste.
 *
 * NO PER-EPISODE DATA, deliberately. Episode positions are what make a series
 * entry several times heavier than a movie one, and the only thing that reads
 * them off a catalog entry is the browse grid's "Completed" badge — which can
 * only ever be true for a title that has watch history (see isSeriesCompleted
 * in the renderer's adapters.ts). So the counts live here for the grid's
 * season/episode labels, and `completed` is computed against `watch_history`
 * at query time for the handful of ids that have any. Full episode lists stay
 * where they already are: metadata()'s own 24h per-title cache.
 *
 * Genres get their own table because they are a many-to-many filter facet. A
 * JSON column would force a scan of every row for every genre filter and for
 * every "which genres exist" query the filter bar asks.
 *
 * `title_sort` is the lowercased title and nothing more — NOT article-stripped.
 * The sort it has to reproduce is `title.localeCompare(title)`, which files
 * "The Matrix" under T; stripping articles here would change what the A-Z sort
 * means as a side effect of moving it into SQL. See catalogFields.ts.
 *
 * The typed columns (`year`, `rating`, `runtime_min`) are derived by the same
 * shared parsers the renderer uses to build a MediaItem, for the same reason:
 * a filter must not mean one thing in SQL and another in memory. Anything that
 * does not parse stays NULL rather than becoming 0, so "unknown year" and
 * "year 0" remain distinguishable to every query.
 */
const catalogIndex: Migration = {
  name: 'catalog-index',
  apply(sql) {
    sql.exec(`
      CREATE TABLE catalog_index(
        id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        title_sort TEXT NOT NULL,
        year INTEGER,
        rating REAL,
        runtime_min INTEGER,
        status TEXT,
        poster TEXT,
        background TEXT,
        logo TEXT,
        description TEXT,
        total_seasons INTEGER,
        total_episodes INTEGER,
        simkl_id TEXT,
        grouped_ids TEXT,
        rank INTEGER,
        source TEXT,
        first_seen INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(id, kind)
      );
      CREATE TABLE catalog_index_genre(
        id TEXT NOT NULL,
        kind TEXT NOT NULL,
        genre TEXT NOT NULL,
        PRIMARY KEY(id, kind, genre)
      );
      CREATE INDEX idx_cindex_browse ON catalog_index(kind, rank);
      CREATE INDEX idx_cindex_year ON catalog_index(kind, year DESC);
      CREATE INDEX idx_cindex_rating ON catalog_index(kind, rating DESC);
      CREATE INDEX idx_cindex_title ON catalog_index(kind, title_sort);
      CREATE INDEX idx_cindex_genre ON catalog_index_genre(kind, genre);
    `)
  }
}

/**
 * Migration 3 — how many of a series' episodes have actually aired.
 *
 * The browse grid's "Completed" badge is not "every episode watched", it is
 * "every episode that has AIRED watched" — a show someone is fully caught up
 * on counts, or a still-running series could never earn the badge (see
 * isSeriesCompleted and airedEpisodes in the renderer's adapters.ts). That
 * denominator used to come from the per-episode `videos` array on the catalog
 * blob, and migration 2 deliberately stopped storing per-episode data at all,
 * because it is what made a series row several times heavier than a movie one.
 *
 * So the COUNT is stored instead of the episodes. It is computed at crawl time
 * with exactly the rule airedEpisodes applies — not unplayable, and either no
 * release date or one already past — which matters for the two sources
 * behaving differently: Cinemeta ships a real date per episode, so this is a
 * genuine aired count, while Kitsu's synthesized episodes carry none, and
 * `!released` counts as aired there, so it equals the total. Both are what
 * the in-memory version already concluded from the same data.
 *
 * It goes stale between crawls, by at most the six-hour refresh interval, and
 * only ever in the direction of under-counting a just-aired episode. That is
 * the honest trade for not storing tens of thousands of episode rows: a badge
 * that appears a few hours late, rather than a denominator that is wrong in
 * both directions forever.
 *
 * Nullable, and NOT backfilled: rows written by migration 2's crawl have no
 * aired count and must read as "unknown" rather than as zero, or every series
 * already in the index would read as complete-with-nothing-aired until its
 * next refresh. The next crawl fills it.
 */
const airedEpisodes: Migration = {
  name: 'aired-episode-counts',
  apply(sql) {
    sql.exec('ALTER TABLE catalog_index ADD COLUMN aired_episodes INTEGER')
  }
}

/** The columns the ghost-row cleanup below reads for every history row. */
export interface HistoryRowForCleanup {
  profile_id: string
  watch_key: string
  content_id: string
  type: string
  title: string
  season: number | null
  episode: number | null
}

/** mockData.ts's id scheme, exactly: nextId('m'|'s'|'a') → "m-10". Anchored
 *  on both ends so nothing merely id-shaped (a hypothetical "m-10x" from a
 *  future source) is ever swept up with the demo pool. */
const MOCK_ID = /^[msa]-\d+$/

/**
 * Which history rows are demo-id GHOSTS: rows whose content_id is a
 * mockData demo id AND that duplicate a row the same profile already has
 * for the same title at the same (season, episode) coordinate under a
 * real, service-expressible id.
 *
 * Both halves of that condition are load-bearing. A demo-id row WITHOUT a
 * real twin is still the only record that the person marked that title
 * watched — deleting it would erase a watch rather than a duplicate, so it
 * stays (the sync review's "Use Simkl" offers to remove it, with a human
 * deciding — see PR #144). And a real-id row that happens to share a title
 * is never touched at all: only the mock-id side of a duplicate pair is
 * ever a candidate.
 *
 * Exported for the migration test — the migration itself is exercised
 * through migrate(), but the cross-profile and coordinate edge cases are
 * cheaper to pin down against this pure function directly.
 */
export function findDemoGhostHistoryRows(rows: HistoryRowForCleanup[]): HistoryRowForCleanup[] {
  // Title-matching is case-insensitive and whitespace-trimmed: the mock
  // row's title came from mockData.ts and the real row's from Cinemeta,
  // and "the same film entered twice" must not survive on a stray space.
  const coordKey = (row: HistoryRowForCleanup): string =>
    [
      row.profile_id,
      row.type,
      String(row.title).trim().toLowerCase(),
      row.season ?? '',
      row.episode ?? ''
    ].join(' ')
  const realKeys = new Set(
    rows.filter((row) => hasExpressibleSimklId(String(row.content_id))).map(coordKey)
  )
  return rows.filter((row) => MOCK_ID.test(String(row.content_id)) && realKeys.has(coordKey(row)))
}

/**
 * Migration 4 — remove the demo-id ghost duplicates from watch history.
 *
 * mockData's demo pool leaked into real user data: openDetail() on an AI
 * assistant fallback pick led to a detail page whose "mark watched" wrote
 * the mock id into watch_history. Diagnosed on the live install as three
 * rows (m-10/m-11/m-13 — Interstellar, The Martian, Ex Machina, all
 * stamped 2026-08-24 within ~15 seconds) duplicating films already tracked
 * under their real IMDb ids; they then sat in the Simkl sync review as
 * rows no resolution could ever clear (PR #144 has that post-mortem). The
 * write path is now refused at the IPC boundary (tracking.ts's
 * assertLibraryWritableId); this is the other half — the rows already
 * written come out, once, on the same one-shot transactional terms as
 * every other schema repair.
 *
 * Scope is deliberately findDemoGhostHistoryRows' (see its comment): only
 * mock-id rows that DUPLICATE a real-id row go, because for those the real
 * row still carries the watch and nothing is lost. Their `plays` rows go
 * with them — migration 1's backfill (and every markWatched since) gave
 * each ghost a play, and a viewing record for a mark-watched click on a
 * demo card double-counts the film in viewing stats. Matched by the same
 * (profile, content_id, season, episode) coordinate so a mock row that
 * SURVIVES (no real twin) keeps its plays.
 *
 * The deletion is logged — ids only, per the log's own discipline (see
 * PR #144's flush line) — rather than silently applied: a migration runs
 * before any renderer exists to show a notice, and a log line naming the
 * removed ids is what lets "where did that row go" be answered later.
 * Nothing here is unrecoverable in the way the log line implies urgency:
 * every deleted row's twin remains under its real id.
 */
const demoGhostHistoryCleanup: Migration = {
  name: 'demo-ghost-history-cleanup',
  apply(sql) {
    const rows = sql
      .prepare(
        'SELECT profile_id, watch_key, content_id, type, title, season, episode FROM watch_history'
      )
      .all() as unknown as HistoryRowForCleanup[]
    const ghosts = findDemoGhostHistoryRows(rows)
    if (!ghosts.length) return
    const deleteHistory = sql.prepare(
      'DELETE FROM watch_history WHERE profile_id = ? AND watch_key = ?'
    )
    // COALESCE against a sentinel no real coordinate uses, because
    // `season = NULL` matches nothing in SQL and a movie ghost's plays
    // (season/episode both NULL) would otherwise all survive.
    const deletePlays = sql.prepare(
      `DELETE FROM plays WHERE profile_id = ? AND content_id = ?
         AND COALESCE(season, -1) = COALESCE(?, -1) AND COALESCE(episode, -1) = COALESCE(?, -1)`
    )
    for (const ghost of ghosts) {
      deleteHistory.run(ghost.profile_id, ghost.watch_key)
      deletePlays.run(ghost.profile_id, ghost.content_id, ghost.season, ghost.episode)
    }
    logError(
      'migration:demo-ghost-history-cleanup',
      `removed ${ghosts.length} demo-id ghost row(s) duplicating real-id history: ` +
        ghosts.map((ghost) => ghost.watch_key).join(',')
    )
  }
}

/** Ordered, and the order IS the version. Append only. */
const MIGRATIONS: readonly Migration[] = [
  baseline,
  profilesAndPlays,
  catalogIndex,
  airedEpisodes,
  demoGhostHistoryCleanup
]

/** How many migrations exist — a database at this version is fully current. */
export const SCHEMA_VERSION = MIGRATIONS.length

/**
 * Single-quote escaping for a value interpolated into a migration's SQL.
 *
 * Migrations run `sql.exec`, which takes no bound parameters — it is the only
 * way to run several statements as one script, and rebuilding four tables in
 * one statement-at-a-time loop would be markedly worse to read. The only value
 * ever interpolated is a profile id this app generated with
 * `crypto.randomUUID`, so there is nothing here to inject; this exists so that
 * stays true if a later migration interpolates something less controlled.
 */
function escape(value: string): string {
  return value.replace(/'/g, "''")
}

function addColumnIfMissing(
  sql: DatabaseSync,
  table: string,
  column: string,
  declaration: string
): void {
  const columns = new Set(
    sql
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => (row as Record<string, unknown>).name as string)
  )
  if (!columns.has(column)) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`)
}

/**
 * Brings `sql` up to SCHEMA_VERSION, applying only what it has not had.
 *
 * Each migration and the version bump that records it share ONE transaction.
 * That is the whole point: a migration interrupted halfway — the process
 * killed, the disk full, a constraint violated — rolls back entirely and the
 * version stays where it was, so the next launch retries it from a known
 * state. The alternative, bumping the version separately, is how a database
 * ends up claiming a schema it only half has.
 *
 * Runs at FULL durability rather than the connection's usual NORMAL. A
 * migration is the one write in this app that genuinely cannot be redone from
 * anywhere else, and it happens once per install per version — the fsync it
 * costs is irrelevant against that.
 */
export function migrate(sql: DatabaseSync, profileId: string): void {
  const row = sql.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined
  const current = Number(row?.user_version ?? 0)
  if (current >= SCHEMA_VERSION) return

  sql.exec('PRAGMA synchronous = FULL')
  try {
    for (let version = current; version < SCHEMA_VERSION; version++) {
      const migration = MIGRATIONS[version]
      sql.exec('BEGIN')
      try {
        migration.apply(sql, profileId)
        // Not a bound parameter: PRAGMA does not accept one, and the value is
        // a loop counter over a fixed-length array rather than input.
        sql.exec(`PRAGMA user_version = ${version + 1}`)
        sql.exec('COMMIT')
      } catch (error) {
        sql.exec('ROLLBACK')
        throw new Error(
          `Database migration ${version} (${migration.name}) failed: ${(error as Error).message}`
        )
      }
    }
  } finally {
    sql.exec('PRAGMA synchronous = NORMAL')
  }
}
