// Taking your library with you.
//
// Until this existed there was exactly one copy of everything anybody had
// ever watched, tracked, disliked or left half-finished: a SQLite file in
// this app's own userData folder. No account behind it, no sync, and no way
// to get it out — a reinstall on a new machine started from nothing, and a
// corrupted file was the end of it.
//
// WHAT IS AND IS NOT IN A BACKUP.
//
// In: the profile-scoped tables — the library, the history, the plays, the
// dislikes, the resume points, the ratings and the lists. Those are somebody's
// own record of their own watching, and they are the only rows in the database
// that cannot be rebuilt from anywhere.
//
// Out, deliberately:
//
//   - catalog_cache. Every row of it is refetchable, and it is by far the
//     largest thing in the file — a single catalog row runs to megabytes. A
//     backup that is mostly cache is a backup people stop taking.
//
//   - credentials. API tokens are stored through Electron's safeStorage,
//     which is bound to the OS keychain of the machine that wrote them. They
//     would not decrypt on another machine even if they were exported, so
//     including them would trade a real secret-handling risk for nothing at
//     all. A restored install asks for its tokens again, once.
//
//   - device preferences (cache size and location, the performance panel,
//     window state). They describe the machine, not the person, and carrying
//     a 50GB cache setting onto a laptop is not a favour.

import fs from 'node:fs'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'

import { SCHEMA_VERSION } from './migrations'

/** Tables a backup carries, each keyed by profile. Order matters on restore:
 *  `list_items` has a foreign key into `lists`, so lists are written first. */
const BACKUP_TABLES = [
  'tracked',
  'watch_history',
  'plays',
  'disliked',
  'playback_positions',
  'ratings',
  'lists',
  'list_items'
] as const

type Row = Record<string, SQLOutputValue>

export interface BackupFile {
  /** Format marker, so a restore can refuse a file that is not one of these
   *  rather than failing halfway through with a SQL error. */
  readonly format: 'r3-media-hub-backup'
  /** The format's own version, NOT the schema's — bumped only if the shape of
   *  this file changes. */
  readonly version: 1
  /** The schema the rows came out of. A backup taken from a NEWER schema than
   *  the running app is refused: its rows may have columns this build has
   *  never heard of, and silently dropping them is how a restore quietly loses
   *  data. An older one restores fine — the columns it lacks take their
   *  defaults. */
  readonly schemaVersion: number
  readonly createdAt: string
  readonly appVersion: string
  /** Profiles as they were, so a restored install has somewhere to put the
   *  rows. Never carries a PIN hash or salt — see writeBackup. */
  readonly profiles: unknown[]
  readonly tables: Record<string, Row[]>
}

export interface RestoreSummary {
  /** Rows written, per table. */
  readonly restored: Record<string, number>
  readonly profiles: number
  readonly createdAt: string
}

/**
 * Reads every backed-up table out of `sql` and writes one JSON file.
 *
 * Whole-table reads, not streamed: the tables here are somebody's viewing
 * history, which is thousands of rows rather than millions, and the largest
 * thing in the database is deliberately excluded. Simplicity is worth more
 * than the memory.
 */
export function writeBackup(
  sql: DatabaseSync,
  filePath: string,
  options: { appVersion: string; profiles: Record<string, unknown>[] }
): void {
  const tables: Record<string, Row[]> = {}
  for (const table of BACKUP_TABLES) {
    tables[table] = sql.prepare(`SELECT * FROM ${table}`).all() as Row[]
  }

  // A PIN exists to keep somebody out of a profile on this machine. A backup
  // is a plain file the person can open, so carrying the hash and its salt
  // into one would put an offline-crackable 4-digit secret somewhere it was
  // never meant to be — for a lock that is a "confirm it's really you" check,
  // not a security boundary. A restored profile comes back unlocked, and the
  // person sets its PIN again if they want one.
  const profiles = options.profiles.map((profile) => {
    const rest = { ...profile }
    delete rest.pinHash
    delete rest.pinSalt
    return rest
  })

  const backup: BackupFile = {
    format: 'r3-media-hub-backup',
    version: 1,
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    appVersion: options.appVersion,
    profiles,
    tables
  }

  // Written to a neighbouring temp file and renamed into place, so a failure
  // partway through (a full disk, most likely — this is the one write in the
  // app the person chose the location of) leaves whatever was already there
  // intact instead of truncating it to a half-written backup.
  const temp = `${filePath}.partial`
  fs.writeFileSync(temp, JSON.stringify(backup), 'utf8')
  fs.renameSync(temp, filePath)
}

/** Reads and validates a backup file, throwing a message worth showing. */
export function readBackup(filePath: string): BackupFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    throw new Error('That file could not be read as a backup.')
  }
  const backup = parsed as Partial<BackupFile>
  if (backup?.format !== 'r3-media-hub-backup') {
    throw new Error('That is not an R3 Media Hub backup.')
  }
  if (backup.version !== 1) {
    throw new Error(`This build cannot read a version ${String(backup.version)} backup.`)
  }
  if (Number(backup.schemaVersion) > SCHEMA_VERSION) {
    throw new Error('That backup was taken by a newer version of the app. Update, then restore it.')
  }
  if (!backup.tables || typeof backup.tables !== 'object') {
    throw new Error('That backup is missing its contents.')
  }
  return backup as BackupFile
}

/**
 * Replaces every backed-up table with the file's contents, in one transaction.
 *
 * REPLACE, not merge. "Restore" means putting the library back the way it was,
 * and a merge would have to invent an answer for every row that exists on both
 * sides with different values — a resume point in two places, a rating changed
 * since the backup. Silently picking one is worse than the honest behaviour,
 * which is that restoring is a deliberate act that overwrites.
 *
 * catalog_cache is untouched: it is not in the file, and wiping it would make
 * the first launch after a restore crawl every catalog again for rows that are
 * still perfectly good.
 */
export function restoreBackup(sql: DatabaseSync, backup: BackupFile): RestoreSummary {
  const restored: Record<string, number> = {}

  sql.exec('BEGIN')
  try {
    // Children before parents on the way out, parents before children on the
    // way in — list_items references lists, and foreign keys are on.
    for (const table of [...BACKUP_TABLES].reverse()) {
      sql.exec(`DELETE FROM ${table}`)
    }

    for (const table of BACKUP_TABLES) {
      const rows = backup.tables[table]
      restored[table] = 0
      if (!Array.isArray(rows) || rows.length === 0) continue
      // Columns come from the LIVE table, not from the file, and every row is
      // written through that same list. A backup from an older schema simply
      // has no value for a newer column, which then takes its default; a
      // stray key in the file that this build has no column for is dropped
      // rather than crashing the restore. Both are the behaviour that keeps a
      // restore working across versions.
      const columns = (
        sql.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[]
      ).map((column) => String(column.name))
      const present = columns.filter((column) =>
        Object.prototype.hasOwnProperty.call(rows[0], column)
      )
      if (present.length === 0) continue
      const statement = sql.prepare(
        `INSERT INTO ${table}(${present.join(',')}) VALUES(${present.map(() => '?').join(',')})`
      )
      for (const row of rows) {
        statement.run(...present.map((column) => (row as Row)[column] ?? null))
        restored[table]++
      }
    }
    sql.exec('COMMIT')
  } catch (error) {
    sql.exec('ROLLBACK')
    throw new Error(
      `Restoring the backup failed, and nothing was changed: ${(error as Error).message}`
    )
  }

  return {
    restored,
    profiles: Array.isArray(backup.profiles) ? backup.profiles.length : 0,
    createdAt: String(backup.createdAt ?? '')
  }
}

export { BACKUP_TABLES }
