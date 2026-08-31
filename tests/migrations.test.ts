// Migrating a real pre-versioning database, not a fresh one.
//
// A fresh database proves almost nothing here: every migration runs against an
// empty schema and any backfill copies zero rows. What has to be proven is the
// upgrade — an install that has been in use, at `user_version` 0, with the
// exact schema the app shipped before versioning existed, coming out the other
// side with its library intact and attributed to a profile.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { migrate, SCHEMA_VERSION } from '../src/main/media-hub/migrations'

const PROFILE = 'profile-under-test'

function tempFile(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'r3-migrations-')), `${name}.sqlite`)
}

/** The schema exactly as it stood before `user_version` was introduced. */
function createLegacyDatabase(file: string): DatabaseSync {
  const sql = new DatabaseSync(file)
  sql.exec(`
    CREATE TABLE tracked(
      content_id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, poster TEXT,
      metadata_json TEXT NOT NULL, tracked_at TEXT NOT NULL,
      baseline_season INTEGER NOT NULL DEFAULT 0, baseline_episode INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE watch_history(
      watch_key TEXT PRIMARY KEY, content_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
      season INTEGER, episode INTEGER, watched_at TEXT NOT NULL, metadata_json TEXT NOT NULL);
    CREATE TABLE catalog_cache(
      cache_key TEXT PRIMARY KEY, payload_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE disliked(
      content_id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, poster TEXT,
      metadata_json TEXT NOT NULL, disliked_at TEXT NOT NULL);
    CREATE TABLE playback_positions(
      position_key TEXT PRIMARY KEY, content_id TEXT NOT NULL, season INTEGER, episode INTEGER,
      position_seconds REAL NOT NULL, duration_seconds REAL, volume REAL, updated_at TEXT NOT NULL);
    CREATE INDEX idx_history_content ON watch_history(content_id, watched_at DESC);
  `)
  sql.exec(`
    INSERT INTO tracked VALUES('tt1','movie','Dune','p','{"id":"tt1"}','2024-01-01T00:00:00Z',0,0);
    INSERT INTO tracked VALUES('tt2','series','Severance','p','{"id":"tt2"}','2024-01-02T00:00:00Z',1,9);
    INSERT INTO watch_history VALUES('tt1:movie:movie','tt1','movie','Dune',NULL,NULL,'2024-02-01T00:00:00Z','{"id":"tt1"}');
    INSERT INTO watch_history VALUES('tt2:1:1','tt2','series','Severance',1,1,'2024-02-02T00:00:00Z','{"id":"tt2"}');
    INSERT INTO watch_history VALUES('tt2:1:2','tt2','series','Severance',1,2,'2024-02-03T00:00:00Z','{"id":"tt2"}');
    INSERT INTO disliked VALUES('tt3','movie','Cats','p','{"id":"tt3"}','2024-03-01T00:00:00Z');
    INSERT INTO playback_positions VALUES('tt2:1:3','tt2',1,3,610.5,2400,1.4,'2024-02-04T00:00:00Z');
    INSERT INTO catalog_cache VALUES('meta:tt1','{"cached":true}',9999999999999,1);
  `)
  return sql
}

function count(sql: DatabaseSync, table: string): number {
  const row = sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Record<string, unknown>
  return Number(row.n)
}

function userVersion(sql: DatabaseSync): number {
  const row = sql.prepare('PRAGMA user_version').get() as Record<string, unknown>
  return Number(row.user_version)
}

// ---------------------------------------------------------------------
// Upgrading a database that has been in use.
// ---------------------------------------------------------------------
{
  const file = tempFile('legacy')
  const sql = createLegacyDatabase(file)
  assert.equal(userVersion(sql), 0, 'a pre-versioning database starts at 0')

  migrate(sql, PROFILE)

  assert.equal(userVersion(sql), SCHEMA_VERSION, 'ends fully migrated')

  // Nothing was lost.
  assert.equal(count(sql, 'tracked'), 2)
  assert.equal(count(sql, 'watch_history'), 3)
  assert.equal(count(sql, 'disliked'), 1)
  assert.equal(count(sql, 'playback_positions'), 1)
  assert.equal(count(sql, 'catalog_cache'), 1, 'the cache is not profile-scoped and is untouched')

  // Every row belongs to the profile that was active when the upgrade ran.
  for (const table of ['tracked', 'watch_history', 'disliked', 'playback_positions']) {
    const row = sql
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE profile_id = ?`)
      .get(PROFILE) as Record<string, unknown>
    assert.equal(Number(row.n), count(sql, table), `${table} rows are attributed to the profile`)
  }

  // Column values survived the rebuild, not just the row count.
  const tracked = sql.prepare('SELECT * FROM tracked WHERE content_id = ?').get('tt2') as Record<
    string,
    unknown
  >
  assert.equal(tracked.title, 'Severance')
  assert.equal(Number(tracked.baseline_season), 1)
  assert.equal(Number(tracked.baseline_episode), 9)

  const position = sql
    .prepare('SELECT * FROM playback_positions WHERE content_id = ?')
    .get('tt2') as Record<string, unknown>
  assert.equal(Number(position.position_seconds), 610.5)
  assert.equal(Number(position.volume), 1.4, 'the volume column added by the old ALTER survives')

  // Every history row became exactly one play — the most that can honestly be
  // reconstructed, since the overwrites this table used to do are unrecoverable.
  assert.equal(count(sql, 'plays'), 3)
  const play = sql
    .prepare('SELECT * FROM plays WHERE content_id = ? AND episode = ?')
    .get('tt2', 2) as Record<string, unknown>
  assert.equal(play.watched_at, '2024-02-03T00:00:00Z', 'the original timestamp carries over')
  assert.equal(play.profile_id, PROFILE)

  // The new tables exist and are empty.
  assert.equal(count(sql, 'ratings'), 0)
  assert.equal(count(sql, 'lists'), 0)
  assert.equal(count(sql, 'list_items'), 0)

  // A second profile's rows coexist rather than colliding — the whole point of
  // the composite key. Under the old single-column key this INSERT failed.
  sql.exec(
    `INSERT INTO tracked VALUES('other','tt1','movie','Dune','p','{"id":"tt1"}','2024-04-01T00:00:00Z',0,0)`
  )
  assert.equal(count(sql, 'tracked'), 3)

  // Re-running is a no-op, not a second backfill.
  migrate(sql, PROFILE)
  assert.equal(count(sql, 'plays'), 3, 'migrate is idempotent once current')
  assert.equal(userVersion(sql), SCHEMA_VERSION)
  sql.close()
}

// ---------------------------------------------------------------------
// A first launch reaches the same schema by a different road.
// ---------------------------------------------------------------------
{
  const file = tempFile('fresh')
  const sql = new DatabaseSync(file)
  migrate(sql, PROFILE)

  assert.equal(userVersion(sql), SCHEMA_VERSION)
  for (const table of [
    'tracked',
    'watch_history',
    'catalog_cache',
    'disliked',
    'playback_positions',
    'plays',
    'ratings',
    'lists',
    'list_items'
  ]) {
    assert.equal(count(sql, table), 0, `${table} exists and is empty`)
  }

  // The columns the pre-versioning ALTERs used to add are present on a
  // database that never ran them — the case that would break if the baseline
  // migration and those guards had drifted apart.
  const columns = new Set(
    sql
      .prepare('PRAGMA table_info(playback_positions)')
      .all()
      .map((row) => (row as Record<string, unknown>).name as string)
  )
  assert.ok(columns.has('volume'))
  assert.ok(columns.has('profile_id'))
  sql.close()
}

// ---------------------------------------------------------------------
// A failing migration must leave the version where it was, so the next
// launch retries from a state it understands.
// ---------------------------------------------------------------------
{
  const file = tempFile('conflict')
  const sql = new DatabaseSync(file)
  // A table the profile-scoping migration will collide with when it tries to
  // create its own, standing in for any mid-migration failure.
  sql.exec('CREATE TABLE plays(nonsense TEXT)')

  assert.throws(() => migrate(sql, PROFILE), /migration 1/i, 'names the migration that failed')
  assert.equal(userVersion(sql), 1, 'the baseline that DID succeed is recorded')

  // And the rollback left no half-built tables from the failed step.
  const tables = new Set(
    sql
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => (row as Record<string, unknown>).name as string)
  )
  assert.ok(!tables.has('tracked_new'), 'the rebuild table was rolled back')
  assert.ok(!tables.has('ratings'), 'nothing from the failed migration persisted')
  sql.close()
}

// ---------------------------------------------------------------------
// Migration 2 — the accumulating title index.
//
// The point of the table is that it OUTLIVES a crawl, so what has to be
// proven here is that it arrives on an install that has been in use without
// disturbing anything already there, and that the columns queries will sort
// and filter on actually exist with the types they need.
// ---------------------------------------------------------------------
{
  const file = tempFile('catalog-index')
  const sql = createLegacyDatabase(file)
  migrate(sql, PROFILE)

  const tables = new Set(
    sql
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => (row as Record<string, unknown>).name as string)
  )
  assert.ok(tables.has('catalog_index'), 'the index table exists')
  assert.ok(tables.has('catalog_index_genre'), 'the genre facet table exists')

  // It starts empty on an upgrade. The blob cache is NOT backfilled into it:
  // the next crawl fills it, and a half-populated index that looked complete
  // would be worse than an obviously empty one.
  assert.equal(count(sql, 'catalog_index'), 0, 'the index starts empty')
  assert.equal(count(sql, 'catalog_cache'), 1, 'the blob cache is left alone')

  // Nothing the earlier migrations built was disturbed.
  assert.equal(count(sql, 'tracked'), 2)
  assert.equal(count(sql, 'watch_history'), 3)

  // The columns every browse query depends on, with the types they need:
  // year/rating/runtime must be numeric or a range filter becomes a string
  // comparison, which is how "rating >= 9" starts matching "10".
  const columns = new Map(
    sql
      .prepare('PRAGMA table_info(catalog_index)')
      .all()
      .map((r) => {
        const row = r as Record<string, unknown>
        return [String(row.name), String(row.type)] as const
      })
  )
  assert.equal(columns.get('year'), 'INTEGER')
  assert.equal(columns.get('rating'), 'REAL')
  assert.equal(columns.get('runtime_min'), 'INTEGER')
  assert.equal(columns.get('first_seen'), 'INTEGER')
  assert.equal(columns.get('updated_at'), 'INTEGER')
  assert.ok(columns.has('title_sort'), 'the A-Z sort has a column to use')
  assert.ok(!columns.has('videos'), 'no per-episode data is stored here')

  // Migration 3. The Completed badge counts AIRED episodes, not all of them,
  // and the index stores the count rather than the episodes — so this column
  // is the badge's whole denominator.
  assert.equal(columns.get('aired_episodes'), 'INTEGER')
  // Nullable and not backfilled on purpose: a row written by migration 2's
  // crawl has no aired count, and "unknown" must read as not-complete. A
  // DEFAULT 0 here would be worse than useless — it would be a denominator
  // every series satisfies.
  const airedNotNull = sql
    .prepare('PRAGMA table_info(catalog_index)')
    .all()
    .filter((r) => String((r as Record<string, unknown>).name) === 'aired_episodes')
    .map((r) => Number((r as Record<string, unknown>).notnull))
  assert.deepEqual(airedNotNull, [0], 'aired_episodes must be nullable')

  // A composite key on (id, kind), so the same imdb id can legitimately be
  // both a movie and a series without one evicting the other.
  const indexes = new Set(
    sql
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((row) => (row as Record<string, unknown>).name as string)
  )
  for (const name of [
    'idx_cindex_browse',
    'idx_cindex_year',
    'idx_cindex_rating',
    'idx_cindex_title',
    'idx_cindex_genre'
  ]) {
    assert.ok(indexes.has(name), `${name} exists — an unindexed browse query scans the library`)
  }
  sql.close()
}

console.log('migrations tests passed')
