// Ported from r3v07v3r-media-hub's src/main.cjs (the small miscellaneous
// ipcMain.handle calls that didn't belong to any single backend domain:
// settings:get/set-theme/set-subtitle-language, account:logout,
// clipboard:write, open:external, window:toggle-fullscreen). Validation/
// fallback behavior (theme normalization, the subtitle-language regex,
// the external-URL allowlist check) is preserved exactly from the
// original — do not "improve" any of it without re-auditing against the
// source app.

import { app, BrowserWindow, clipboard, shell } from 'electron'
import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import type { MediaHubSettingsSnapshot } from '../../shared/media-hub/types'
import { handle } from './ipcGuard'
import { ffmpegPath, stopPlayback } from './playbackSession'
import { normalizeTheme, publicSettings, logoutSettings, THEMES } from './preferences'
import { normalizePlaybackBuffer } from '../../shared/media-hub/playbackBuffer'
import { isAllowedExternalUrl } from './security'
import {
  getTorBoxToken,
  osConnected,
  partySyncCredentials,
  readSettings,
  tmdbCredentials,
  writeSettings
} from './settingsStore'

/** Registers the miscellaneous settings/account/system IPC handlers. */
export function registerAppIpc(): void {
  handle<undefined, MediaHubSettingsSnapshot>(MEDIA_HUB_CHANNELS.settingsGet, () => ({
    ...publicSettings(readSettings()),
    appVersion: app.getVersion(),
    themes: THEMES,
    torboxConnected: Boolean(getTorBoxToken()),
    tmdbConnected: Boolean(tmdbCredentials().apiKey),
    osConnected: osConnected(),
    partySyncConnected: Boolean(partySyncCredentials().url && partySyncCredentials().inviteKey),
    ffmpegAvailable: Boolean(ffmpegPath)
  }))

  handle<unknown, { theme: string }>(MEDIA_HUB_CHANNELS.settingsSetTheme, (_event, value) => {
    const settings = readSettings()
    settings.theme = normalizeTheme(value)
    writeSettings(settings)
    return { theme: settings.theme }
  })

  handle<unknown, { subtitleLanguage: string }>(
    MEDIA_HUB_CHANNELS.settingsSetSubtitleLanguage,
    (_event, value) => {
      const settings = readSettings()
      settings.subtitleLanguage = (String(value || 'en')
        .trim()
        .toLowerCase()
        .match(/^[a-z-]{2,10}$/) || ['en'])[0]
      writeSettings(settings)
      return { subtitleLanguage: settings.subtitleLanguage }
    }
  )

  handle<unknown, { playbackBuffer: string }>(
    MEDIA_HUB_CHANNELS.settingsSetPlaybackBuffer,
    (_event, value) => {
      const settings = readSettings()
      settings.playbackBuffer = normalizePlaybackBuffer(value)
      writeSettings(settings)
      return { playbackBuffer: settings.playbackBuffer }
    }
  )

  handle<undefined, { ok: true }>(MEDIA_HUB_CHANNELS.logout, async () => {
    await stopPlayback()
    writeSettings(logoutSettings(readSettings()))
    return { ok: true }
  })

  handle<unknown, { ok: true }>(MEDIA_HUB_CHANNELS.clipboardWrite, (_event, value) => {
    clipboard.writeText(String(value || ''))
    return { ok: true }
  })

  handle<string | undefined, { ok: true }>(MEDIA_HUB_CHANNELS.openExternal, async (_event, url) => {
    if (!isAllowedExternalUrl(url)) throw new Error('This external link is not permitted.')
    await shell.openExternal(url as string)
    return { ok: true }
  })

  handle<undefined, { fullScreen: boolean }>(MEDIA_HUB_CHANNELS.windowToggleFullscreen, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) as BrowserWindow
    win.setFullScreen(!win.isFullScreen())
    return { fullScreen: win.isFullScreen() }
  })
}
