// The safety backup a restore takes first (appIpc.ts's backup:import handler,
// which calls autoBackup.ts's backupBeforeRewrite('restore') between reading
// the chosen file and handing it to database.importBackup).
//
// A restore replaces the whole library with the chosen file. Before it, the
// library being replaced goes into the automatic backups, so restoring the
// wrong file can itself be undone. A file the restore refuses replaces
// nothing, and takes no backup.
//
// The backup is taken by the handler, not by importBackup, so the test goes
// through the handler: 'electron' is pointed at the headless stand-in, as
// accountMarks.test.ts does, the stand-in's open dialog is made to answer
// with the file being restored, and the library is set as the app's.
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
  const { registerAppIpc } = await import('../src/main/media-hub/appIpc')
  const { BrowserWindow, dialog, ipcMain } = await import('../src/headless/electronShim')
  const { MEDIA_HUB_CHANNELS } = await import('../src/shared/media-hub/ipc-channels')

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

  // Restore, as the renderer asks for it: the open dialog answers with `file`.
  registerAppIpc()
  const window = new BrowserWindow()
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const restore = (file: string): Promise<unknown> => {
    const picked = dialog as unknown as { showOpenDialog: () => Promise<unknown> }
    picked.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    return ipcMain.dispatchInvoke(event, MEDIA_HUB_CHANNELS.backupImport, [undefined])
  }

  // A file the restore refuses replaces nothing and takes no backup.
  const notABackup = path.join(dir, 'not-a-backup.json')
  fs.writeFileSync(notABackup, '{"hello":"world"}')
  await assert.rejects(restore(notABackup))
  assert.deepEqual(autoBackupFiles(backups), [], 'a refused file takes no backup')
  assert.equal(app.isTracked('tt-mine'), true)

  // The restore replaces the library, and the one it replaced is kept.
  assert.ok(await restore(chosen), 'the restore reports what it did')
  assert.equal(app.isTracked('tt-from-file'), true, 'the chosen file is what is here now')
  assert.equal(app.isTracked('tt-mine'), false)
  const written = autoBackupFiles(backups)
  assert.equal(written.length, 1, 'one backup, taken by the restore')
  assert.match(written[0], /-restore\.json$/)
  const saved = readBackup(path.join(backups, written[0]))
  const ids = saved.tables.tracked.map((row) => String(row.content_id))
  assert.deepEqual(ids, ['tt-mine'], 'it holds the library as it was before the restore')

  // And restoring that backup undoes the restore (taking one more backup,
  // of the restored library, on the way).
  await restore(path.join(backups, written[0]))
  assert.equal(app.isTracked('tt-mine'), true)
  assert.equal(app.isTracked('tt-from-file'), false)

  app.close()
  console.log('restore backup tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
