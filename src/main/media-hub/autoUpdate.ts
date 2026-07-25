// Ported from r3v07v3r-media-hub's src/main.cjs (setupAutoUpdater and the
// update:check/update:install/update:set-channel ipcMain.handle calls).
// electron-updater wiring is preserved exactly, byte-for-byte in intent,
// from the original: background checks only run in a packaged build
// (`!app.isPackaged` early-outs setupAutoUpdater entirely), an initial
// check fires 10s after this is wired up, then every 6 hours thereafter,
// and the update-downloaded event flips the module-level `updateReady`
// flag that gates whether update:install is actually allowed to
// quit-and-install.

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

function updateStatus(
  win: BrowserWindow,
  state: UpdateState,
  extra: Partial<UpdateStatusPayload> = {}
): void {
  if (!win.isDestroyed()) win.webContents.send(MEDIA_HUB_CHANNELS.updateStatus, { state, ...extra })
}

/**
 * Wires electron-updater's events to push `update:status` events to `win`,
 * and schedules the recurring background update check. No-ops entirely in
 * unpackaged (dev) builds, matching the original.
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

  const check = (): void => {
    autoUpdater.allowPrerelease = normalizeUpdateChannel(readSettings().updateChannel) === 'preview'
    autoUpdater.checkForUpdates().catch((error) => logError('update:background-check', error))
  }
  setTimeout(check, 10000)
  setInterval(check, 6 * 60 * 60 * 1000)
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
