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

/** Ordered, and the order IS the version. Append only. */
const MIGRATIONS: readonly Migration[] = [baseline, profilesAndPlays]

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
