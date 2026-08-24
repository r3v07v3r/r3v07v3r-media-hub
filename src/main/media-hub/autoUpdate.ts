// Ported from r3v07v3r-media-hub's src/main.cjs (setupAutoUpdater and the
// update:check/update:install/update:set-channel ipcMain.handle calls).
// The electron-updater wiring is preserved from the original: background
// checks only run in a packaged build (`!app.isPackaged` early-outs
// setupAutoUpdater entirely), and the update-downloaded event flips the
// module-level `updateReady` flag that gates whether update:install is
// actually allowed to quit-and-install.
//
// One thing is deliberately no longer a 1:1 port: the schedule. The
// original fired its first check 10 seconds after this was wired up and
// then every 6 hours on its own setInterval. Ten seconds in is the middle
// of a cold start — the catalogs are being crawled, the renderer is
// mounting — and with autoDownload on, "check" can immediately become
// "download an installer". Nothing about an update is urgent enough to be
// the second thing the app does. The 6-hour cadence is unchanged, but it
// now belongs to backgroundJobs.ts along with every other recurring job,
// so it can be held off while the app is busy instead of arriving
// whenever its own clock said so.

import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import type {
  UpdateCheckResult,
  UpdateState,
  UpdateStatusPayload
} from '../../shared/media-hub/types'
import { handle } from './ipcGuard'
import { logError } from './logger'
import { normalizeUpdateChannel } from './preferences'
import { readSettings, writeSettings } from './settingsStore'

// Shared between the update-downloaded event and update:install — only
// once electron-updater has actually finished downloading an update is
// quitAndInstall ever allowed to run.
let updateReady = false

// Whether setupAutoUpdater has wired the event handlers yet. checkForUpdates
// refuses to run before it has — see its own comment.
let updaterReady = false

function updateStatus(
  win: BrowserWindow,
  state: UpdateState,
  extra: Partial<UpdateStatusPayload> = {}
): void {
  if (!win.isDestroyed()) win.webContents.send(MEDIA_HUB_CHANNELS.updateStatus, { state, ...extra })
}

/**
 * Wires electron-updater's events to push `update:status` events to `win`.
 * No-ops entirely in unpackaged (dev) builds, matching the original. The
 * recurring check itself is registered in backgroundJobs.ts — see
 * checkForUpdates below.
 */
export function setupAutoUpdater(win: BrowserWindow): void {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => updateStatus(win, 'checking'))
  autoUpdater.on('update-available', (info) => {
    updateReady = false
    updateStatus(win, 'available', { version: info.version })
  })
  autoUpdater.on('update-not-available', () =>
    updateStatus(win, 'current', { version: app.getVersion() })
  )
  autoUpdater.on('download-progress', (p) =>
    updateStatus(win, 'downloading', { percent: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = true
    updateStatus(win, 'ready', { version: info.version })
  })
  autoUpdater.on('error', (error) => {
    logError('autoUpdater', error)
    updateStatus(win, 'error', { message: error.message })
  })

  updaterReady = true
}

/**
 * One background update check. Called by the recurring job registry, not
 * by a timer of its own.
 *
 * Silent in an unpackaged build, and silent before setupAutoUpdater has
 * run: without the event wiring above, a check would fire electron-updater
 * events nothing is listening for and, with autoDownload on, could start
 * a download whose progress the renderer would never be told about.
 */
export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged || !updaterReady) return
  autoUpdater.allowPrerelease = normalizeUpdateChannel(readSettings().updateChannel) === 'preview'
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    logError('update:background-check', error)
  }
}

/** Registers the update:check/update:install/update:set-channel IPC handlers. */
export function registerAutoUpdateIpc(): void {
  handle<undefined, UpdateCheckResult>(MEDIA_HUB_CHANNELS.updateCheck, async () => {
    if (!app.isPackaged) return { state: 'development', version: app.getVersion() }
    autoUpdater.allowPrerelease = normalizeUpdateChannel(readSettings().updateChannel) === 'preview'
    const result = await autoUpdater.checkForUpdates()
    const version = result?.updateInfo?.version || app.getVersion()
    return { state: version === app.getVersion() ? 'current' : 'available', version }
  })

  handle<undefined, { ok: boolean }>(MEDIA_HUB_CHANNELS.updateInstall, () => {
    if (app.isPackaged && updateReady) autoUpdater.quitAndInstall(false, true)
    return { ok: app.isPackaged && updateReady }
  })

  handle<string | undefined, { ok: true; channel: ReturnType<typeof normalizeUpdateChannel> }>(
    MEDIA_HUB_CHANNELS.updateSetChannel,
    (_event, channel) => {
      const value = normalizeUpdateChannel(channel)
      const settings = readSettings()
      settings.updateChannel = value
      writeSettings(settings)
      autoUpdater.allowPrerelease = value === 'preview'
      return { ok: true, channel: value }
    }
  )
}
