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
//     backup that is mostly cache is a backup people stop taking. The one
//     exception is the Collections page's record (which lists were added from
//     Trakt, which collections were removed): it is kept there, but it is a
//     choice somebody made, and it travels as BackupFile.collections.
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

import { COLLECTIONS_KEY_PREFIX, COLLECTIONS_STATE_TTL_MS } from '../../shared/media-hub/universes'
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
  /**
   * Who was watching when the backup was taken.
   *
   * Restoring switches back to them, which is the only reading of "restore"
   * that matches what people expect: put it back the way it was. Without it,
   * taking a backup as one profile and restoring it while another is active
   * replaced the data and left you looking at somebody else's library —
   * technically correct and thoroughly confusing.
   *
   * Optional because backups written before this existed have no answer; the
   * restore falls back to the first declared profile rather than staying put.
   */
  readonly activeProfileId?: string
  /**
   * The grouping the anime rows were filed under when the backup was taken
   * (the ledger — see animeRegroup.ts).
   *
   * A merged anime's history is addressed by the id fronting the show and
   * the season's position in it, and both can have changed by the time the
   * file is restored. Restoring puts this back as the ledger, so the next
   * comparison against the catalog moves the restored rows to where the
   * grouping in force now has them. Without it they would be read by today's
   * grouping at yesterday's addresses.
   *
   * Optional: an install that never grouped has none, and neither does a
   * backup from before the ledger. Such a file's rows are taken to be filed
   * the way this install's are, which is the only thing that can be assumed.
   */
  readonly animeGroups?: unknown[]
  /**
   * Each profile's Collections record — added Trakt lists and removed
   * collections — keyed by profile id (main/media-hub/collections.ts).
   *
   * Optional: a backup from before Collections had one. Restoring a file
   * without it leaves this install's records as they are, as the ledger does.
   */
  readonly collections?: Record<string, unknown>
  readonly tables: Record<string, Row[]>
}

export interface RestoreSummary {
  /** Rows written, per table. */
  readonly restored: Record<string, number>
  readonly profiles: number
  readonly createdAt: string
  /** Who to switch back to — the profile that was active when the backup was
   *  taken, or the first one it declares when it predates that field. Always a
   *  real id, because a file with no usable profile is refused outright. */
  readonly activeProfileId: string
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
  options: { appVersion: string; profiles: Record<string, unknown>[]; activeProfileId: string }
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
    activeProfileId: options.activeProfileId,
    ...animeGroupsOf(sql),
    ...collectionsOf(
      sql,
      profiles.map((profile) => String(profile.id ?? ''))
    ),
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

/** The ledger as the file carries it, or nothing when none is recorded. */
function animeGroupsOf(sql: DatabaseSync): { animeGroups?: unknown[] } {
  const row = sql.prepare('SELECT groups_json FROM anime_group_ledger WHERE id=1').get() as
    Row | undefined
  if (!row) return {}
  try {
    const groups: unknown = JSON.parse(String(row.groups_json))
    return Array.isArray(groups) ? { animeGroups: groups } : {}
  } catch {
    return {}
  }
}

/**
 * The declared profiles' Collections records. Always present, even empty: an
 * empty snapshot restores as "nothing added, nothing removed", while a file
 * with no field at all is one from before Collections and is left alone.
 */
function collectionsOf(
  sql: DatabaseSync,
  profileIds: string[]
): { collections: Record<string, unknown> } {
  const collections: Record<string, unknown> = {}
  for (const profileId of profileIds.filter(Boolean)) {
    const row = sql
      .prepare('SELECT payload_json FROM catalog_cache WHERE cache_key=?')
      .get(`${COLLECTIONS_KEY_PREFIX}${profileId}`) as Row | undefined
    if (!row) continue
    try {
      const record: unknown = JSON.parse(String(row.payload_json))
      if (record && typeof record === 'object') collections[profileId] = record
    } catch {
      // An unreadable record is left out rather than failing the backup.
    }
  }
  return { collections }
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
  if (!backup.tables || typeof backup.tables !== 'object' || Array.isArray(backup.tables)) {
    throw new Error('That backup is missing its contents.')
  }

  // EVERY table has to be present, and every one an array.
  //
  // Not pedantry — this is what stands between a damaged file and an erased
  // library. restoreBackup deletes all of these before it writes any of them,
  // and a missing table reads as "restore zero rows", so a file carrying the
  // right marker and `tables: {}` would empty the library and commit it as a
  // success. An empty ARRAY is different and legitimate: somebody who has
  // rated nothing has an empty `ratings`.
  const missing = BACKUP_TABLES.filter((table) => !Array.isArray(backup.tables?.[table]))
  if (missing.length > 0) {
    throw new Error(
      `That backup is incomplete and was not restored (missing: ${missing.join(', ')}).`
    )
  }

  // Checked here rather than where it is read, because it is read AFTER the
  // restore has committed — see appIpc's backup:import. A file that got that
  // far and then threw would have replaced the library and skipped putting the
  // profiles back, leaving every restored row owned by a profile that does not
  // exist.
  // At least one profile with a real id — not merely an array.
  //
  // Every row in every table above is owned by a profile id, so a file with
  // `profiles: []` or `[{}]` describes a library nobody can reach. Restoring
  // it would delete the existing rows, write orphans in their place, and
  // report success. An array was the check after the last round of review;
  // it was not enough.
  const usableProfiles = Array.isArray(backup.profiles)
    ? backup.profiles.filter(
        (profile) =>
          typeof (profile as { id?: unknown })?.id === 'string' &&
          String((profile as { id: string }).id).trim().length > 0
      )
    : []
  if (usableProfiles.length === 0) {
    throw new Error('That backup has no profiles in it and was not restored.')
  }

  // And every row has to belong to one of them.
  //
  // A file can carry one superficially valid profile while every row names a
  // different owner — the shape a partial or hand-edited export takes. Nothing
  // above catches that: the tables are present and non-empty, the profile
  // array has an entry. Restoring it would delete the existing library, write
  // rows no profile can reach, and report success.
  //
  // list_items is checked through its parent list rather than directly: it has
  // no profile column, deliberately, because a list_id already names one.
  const declared = new Set(usableProfiles.map((profile) => String((profile as { id: string }).id)))
  const listOwners = new Map<string, string>()
  for (const row of backup.tables.lists as Row[]) {
    listOwners.set(String(row.list_id), String(row.profile_id))
  }
  for (const table of BACKUP_TABLES) {
    for (const row of backup.tables[table] as Row[]) {
      const owner =
        table === 'list_items' ? listOwners.get(String(row.list_id)) : String(row.profile_id)
      if (owner === undefined || !declared.has(owner)) {
        throw new Error(
          `That backup contains ${table} belonging to a profile it does not include, and was not restored.`
        )
      }
    }
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
    // The grouping those rows are filed under, in the same transaction as
    // the rows: see BackupFile.animeGroups. A file without one leaves the
    // ledger here as it is.
    if (Array.isArray(backup.animeGroups)) {
      sql
        .prepare(
          `INSERT INTO anime_group_ledger(id,groups_json,recorded_at) VALUES(1,?,?)
           ON CONFLICT(id) DO UPDATE SET groups_json=excluded.groups_json,recorded_at=excluded.recorded_at`
        )
        .run(JSON.stringify(backup.animeGroups), new Date().toISOString())
    }
    // The Collections records replace this install's, like the tables do —
    // but only when the file carries them (see BackupFile.collections), and
    // only for profiles the file declares.
    if (backup.collections && typeof backup.collections === 'object') {
      sql
        .prepare('DELETE FROM catalog_cache WHERE cache_key LIKE ?')
        .run(`${COLLECTIONS_KEY_PREFIX}%`)
      const declaredIds = new Set(
        (backup.profiles as { id?: unknown }[]).map((profile) => String(profile?.id ?? ''))
      )
      const write = sql.prepare(
        `INSERT INTO catalog_cache(cache_key,payload_json,expires_at,updated_at) VALUES(?,?,?,?)
         ON CONFLICT(cache_key) DO UPDATE SET payload_json=excluded.payload_json,expires_at=excluded.expires_at,updated_at=excluded.updated_at`
      )
      const now = Date.now()
      for (const [profileId, record] of Object.entries(backup.collections)) {
        if (!profileId || !declaredIds.has(profileId) || !record || typeof record !== 'object') {
          continue
        }
        write.run(
          `${COLLECTIONS_KEY_PREFIX}${profileId}`,
          JSON.stringify(record),
          now + COLLECTIONS_STATE_TTL_MS,
          now
        )
      }
    }
    sql.exec('COMMIT')
  } catch (error) {
    sql.exec('ROLLBACK')
    throw new Error(
      `Restoring the backup failed, and nothing was changed: ${(error as Error).message}`
    )
  }

  const declared = (backup.profiles as { id?: unknown }[])
    .map((profile) => String(profile?.id ?? ''))
    .filter(Boolean)
  const wanted = String(backup.activeProfileId ?? '')
  return {
    restored,
    profiles: declared.length,
    createdAt: String(backup.createdAt ?? ''),
    // Only honoured when the file actually declares that profile — an
    // activeProfileId naming somebody the backup does not contain would switch
    // into a library that is not there.
    activeProfileId: declared.includes(wanted) ? wanted : declared[0]
  }
}
