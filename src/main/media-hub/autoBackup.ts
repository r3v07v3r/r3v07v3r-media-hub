// A backup written without asking, before the app rewrites history rows.
//
// A few steps change rows in watch_history that somebody did not just touch
// themselves: the anime regroup moving a merged show's seasons to where the
// catalog now has them (animeSyncRepair.ts), the Trakt import and its
// half-hourly incremental pull (traktClient.ts), and the MyAnimeList apply
// (malSync.ts). Each is careful, and each is tested, but a mistake in any of
// them lands in the one table nothing can rebuild — and until now the only
// backup was the one a person remembered to take from Settings. A restore
// from Settings replaces the whole library with a file, so it takes one as
// well (backup.ts's restoreBackup): restoring the wrong file can be undone.
//
// So each of those writes a backup first, through the same exportBackup the
// Settings button uses (backup.ts has what a backup carries), into a
// `backups` folder in userData, with no picker. The newest AUTO_BACKUP_KEEP
// are kept, and the newest of each reason as well (writeRotatingBackup says
// why); older ones are deleted, so the folder never grows past that. Every
// one written, skipped or failed is a line in the log. A backup that cannot be
// written does not stop the step it was for: the step is the same one that
// ran before this existed, and refusing it would leave the library in
// whatever state it was waiting to be moved out of.
//
// The writing and the rotation take everything as arguments and are tested
// against a real database in tests/backup.test.ts. backupBeforeRewrite is
// the wiring, and reaches Electron (the userData path, the app version)
// only when it is called.

import fs from 'node:fs'
import path from 'node:path'

import type { MediaHubDatabase } from './database'
import { getDatabase } from './dbState'
import { electronModule } from './electronModule'
import { logError } from './logger'
import { readSettings } from './settingsStore'

/** How many automatic backups are kept whatever their reason. The newest of
 *  each reason is kept on top of these: see writeRotatingBackup. */
export const AUTO_BACKUP_KEEP = 5

const AUTO_PREFIX = 'auto-'

/** What the step about to rewrite rows is called, in the file name and the
 *  log. Letters, digits and dashes only. */
export type RewriteReason =
  | 'anime-regroup'
  | 'anime-repair'
  | 'trakt-import'
  | 'trakt-pull'
  | 'mal-apply'
  | 'episode-sync'
  | 'restore'

/** The reason in a name writeRotatingBackup wrote, or undefined for any
 *  other name. The stamp is an ISO time with its colons and dot as dashes. */
function reasonOf(name: string): string | undefined {
  return /^auto-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-([a-z0-9-]+)\.json$/.exec(name)?.[1]
}

/** How old a `.partial` left in the folder has to be before it is deleted:
 *  older than any write still going on could be. */
const STALE_PARTIAL_MS = 24 * 60 * 60 * 1000

/**
 * Deletes the `.partial` files a backup that never finished left behind.
 * exportBackup removes its own when the write fails, so these are from a
 * write the process did not live through. Each is as big as the backup got
 * before it stopped, and the name carries a time, so nothing else would
 * ever delete one.
 */
function removeStalePartials(dir: string, nowMs: number): void {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(AUTO_PREFIX) || !name.endsWith('.partial')) continue
    try {
      const file = path.join(dir, name)
      if (nowMs - fs.statSync(file).mtimeMs > STALE_PARTIAL_MS) fs.unlinkSync(file)
    } catch {
      // Left for the next rotation.
    }
  }
}

/** The automatic backups in `dir`, oldest first. The name starts with the
 *  time it was written, so name order is time order. */
export function autoBackupFiles(dir: string): string[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  return names.filter((name) => name.startsWith(AUTO_PREFIX) && name.endsWith('.json')).sort()
}

/**
 * Writes one backup into `dir`, then deletes every automatic backup but the
 * newest `keep` and the newest of each reason. Returns the file written.
 * Throws if the backup itself could not be written; a file that cannot be
 * deleted in the rotation is left.
 *
 * The newest of each reason, because the backup taken before a rare step
 * (a regroup, an import, a restore) is the only one holding the library as
 * it was before that step: every later one holds it after. The routine
 * ones, the Trakt pull and the episode comparison, come one a day at most
 * but every day for somebody who watches somewhere else as well, and
 * with the newest `keep` alone a few days of them rotated the rare one out.
 * This keeps at most one more file per reason.
 */
export function writeRotatingBackup(
  db: Pick<MediaHubDatabase, 'exportBackup'>,
  dir: string,
  options: {
    reason: RewriteReason
    appVersion: string
    profiles: Record<string, unknown>[]
    activeProfileId: string
    now?: Date
    keep?: number
  }
): string {
  fs.mkdirSync(dir, { recursive: true })
  // Before the write, not after: on a disk a stuck write filled, that space
  // is what this backup needs.
  removeStalePartials(dir, Date.now())
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-')
  const file = path.join(dir, `${AUTO_PREFIX}${stamp}-${options.reason}.json`)
  db.exportBackup(file, {
    appVersion: options.appVersion,
    profiles: options.profiles,
    activeProfileId: options.activeProfileId
  })
  const files = autoBackupFiles(dir)
  const keep = Math.max(1, options.keep ?? AUTO_BACKUP_KEEP)
  const kept = new Set(files.slice(-keep))
  // Oldest first, so the last of each reason seen is its newest.
  const newestOf = new Map<string, string>()
  for (const name of files) {
    const reason = reasonOf(name)
    if (reason) newestOf.set(reason, name)
  }
  for (const name of newestOf.values()) kept.add(name)
  for (const old of files) {
    if (kept.has(old)) continue
    try {
      fs.unlinkSync(path.join(dir, old))
    } catch {
      // Left for the next rotation.
    }
  }
  return file
}

/** Whether a backup for `reason` was written in the last `withinMs`. */
export function recentAutoBackup(
  dir: string,
  reason: RewriteReason,
  withinMs: number,
  nowMs: number
): boolean {
  for (const name of autoBackupFiles(dir)) {
    if (!name.endsWith(`-${reason}.json`)) continue
    try {
      if (nowMs - fs.statSync(path.join(dir, name)).mtimeMs < withinMs) return true
    } catch {
      // Gone since it was listed.
    }
  }
  return false
}

/**
 * The backup before a rewrite, against the real database and userData.
 * Never throws. `notWithinMs` spaces out a step that runs often (the
 * half-hourly Trakt pull) to one backup in that time rather than one a
 * pass. What keeps the backup taken before a regroup is the rotation, which
 * keeps the newest of every reason.
 */
export function backupBeforeRewrite(
  reason: RewriteReason,
  options: { notWithinMs?: number } = {}
): void {
  try {
    // Lazily, and through electronModule.ts, so this module loads where the
    // Electron binary is absent — see logger.ts's logPath.
    const { app } = electronModule()
    const dir = path.join(app.getPath('userData'), 'backups')
    if (options.notWithinMs && recentAutoBackup(dir, reason, options.notWithinMs, Date.now())) {
      return
    }
    const db = getDatabase()
    const file = writeRotatingBackup(db, dir, {
      reason,
      appVersion: app.getVersion(),
      profiles: (readSettings().profiles ?? []) as unknown as Record<string, unknown>[],
      activeProfileId: db.activeProfile()
    })
    logError('backup:auto', `wrote ${path.basename(file)} before ${reason}`)
  } catch (error) {
    logError(
      'backup:auto',
      `could not write a backup before ${reason}: ${(error as Error)?.message ?? error}`
    )
  }
}
