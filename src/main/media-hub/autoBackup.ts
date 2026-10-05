// A backup written without asking, before the app rewrites history rows.
//
// A few steps change rows in watch_history that somebody did not just touch
// themselves: the anime regroup moving a merged show's seasons to where the
// catalog now has them (animeSyncRepair.ts), the Trakt import and its
// half-hourly incremental pull (traktClient.ts), and the MyAnimeList apply
// (malSync.ts). Each is careful, and each is tested, but a mistake in any of
// them lands in the one table nothing can rebuild — and until now the only
// backup was the one a person remembered to take from Settings.
//
// So each of those writes a backup first, through the same exportBackup the
// Settings button uses (backup.ts has what a backup carries), into a
// `backups` folder in userData, with no picker. The newest AUTO_BACKUP_KEEP
// are kept and older ones deleted, so the folder never grows. Every one
// written, skipped or failed is a line in the log. A backup that cannot be
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
import { logError } from './logger'
import { readSettings } from './settingsStore'

/** How many automatic backups are kept. */
export const AUTO_BACKUP_KEEP = 5

const AUTO_PREFIX = 'auto-'

/** What the step about to rewrite rows is called, in the file name and the
 *  log. Letters, digits and dashes only. */
export type RewriteReason =
  'anime-regroup' | 'anime-repair' | 'trakt-import' | 'trakt-pull' | 'mal-apply' | 'episode-sync'

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
 * Writes one backup into `dir` and deletes all but the newest `keep`.
 * Returns the file written. Throws if the backup itself could not be
 * written; a file that cannot be deleted in the rotation is left.
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
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-')
  const file = path.join(dir, `${AUTO_PREFIX}${stamp}-${options.reason}.json`)
  db.exportBackup(file, {
    appVersion: options.appVersion,
    profiles: options.profiles,
    activeProfileId: options.activeProfileId
  })
  const files = autoBackupFiles(dir)
  const keep = Math.max(1, options.keep ?? AUTO_BACKUP_KEEP)
  for (const old of files.slice(0, Math.max(0, files.length - keep))) {
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
 * half-hourly Trakt pull), so its backups do not push the ones taken
 * before a regroup out of the rotation.
 */
export function backupBeforeRewrite(
  reason: RewriteReason,
  options: { notWithinMs?: number } = {}
): void {
  try {
    // Lazily, so this module loads where the Electron binary is absent —
    // see logger.ts's logPath.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron')
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
