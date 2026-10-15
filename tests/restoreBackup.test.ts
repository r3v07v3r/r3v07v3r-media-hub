// The safety backup a restore takes first (backup.ts's restoreBackup, under
// autoBackup.ts's 'restore' reason).
//
// A restore replaces the whole library with the chosen file. Before it, the
// library being replaced goes into the automatic backups, so restoring the
// wrong file can itself be undone. A file the restore refuses replaces
// nothing, and takes no backup.
//
// The automatic backup reads the app's own database and its userData folder,
// so 'electron' is pointed at the headless stand-in, as
// historyPendingSummary.test.ts does, and the library is set as the app's.
// Run with: npx tsx tests/restoreBackup.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-restore-backup-'))
process.env.R3_USER_DATA = userData
process.env.R3_ELECTRON_SHIM = '1'
const shim = pathToFileURL(
  path.join(__dirname, '..', 'src', 'headless', 'electronShim', 'index.ts')
)
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron') return { url: shim.href, shortCircuit: true }
    return next(specifier, context)
  }
})

async function main(): Promise<void> {
  const { createDatabase } = await import('../src/main/media-hub/database')
  const { setDatabase } = await import('../src/main/media-hub/dbState')
  const { autoBackupFiles } = await import('../src/main/media-hub/autoBackup')
  const { readBackup } = await import('../src/main/media-hub/backup')
  const { activeProfileId } = await import('../src/main/media-hub/profiles')

  // The profile the app seeds before its database opens, as main/index.ts
  // does: the automatic backup carries the profiles from the settings.
  const profile = activeProfileId()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-restore-file-'))
  const backups = path.join(userData, 'backups')
  const options = {
    appVersion: '1.2.3',
    profiles: [{ id: profile, name: 'Profile 1' }],
    activeProfileId: profile
  }

  // The file somebody picks: a library with one title in it.
  const other = createDatabase(path.join(dir, 'other.sqlite'), profile)
  other.track({ id: 'tt-from-file', type: 'movie', title: 'From the file' })
  const chosen = path.join(dir, 'chosen.json')
  other.exportBackup(chosen, options)
  other.close()

  // The app's own library, with a title of its own.
  const app = createDatabase(path.join(dir, 'app.sqlite'), profile)
  app.track({ id: 'tt-mine', type: 'movie', title: 'Mine' })
  setDatabase(app)

  // A file the restore refuses replaces nothing and takes no backup.
  const notABackup = path.join(dir, 'not-a-backup.json')
  fs.writeFileSync(notABackup, '{"hello":"world"}')
  assert.throws(() => app.importBackup(notABackup))
  assert.deepEqual(autoBackupFiles(backups), [], 'a refused file takes no backup')
  assert.equal(app.isTracked('tt-mine'), true)

  // The restore replaces the library, and the one it replaced is kept.
  app.importBackup(chosen)
  assert.equal(app.isTracked('tt-from-file'), true, 'the chosen file is what is here now')
  assert.equal(app.isTracked('tt-mine'), false)
  const written = autoBackupFiles(backups)
  assert.equal(written.length, 1, 'one backup, taken by the restore')
  assert.match(written[0], /-restore\.json$/)
  const saved = readBackup(path.join(backups, written[0]))
  const ids = saved.tables.tracked.map((row) => String(row.content_id))
  assert.deepEqual(ids, ['tt-mine'], 'it holds the library as it was before the restore')

  // And restoring that backup undoes the restore.
  app.importBackup(path.join(backups, written[0]))
  assert.equal(app.isTracked('tt-mine'), true)
  assert.equal(app.isTracked('tt-from-file'), false)

  app.close()
  console.log('restore backup tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
