// Ported from r3v07v3r-media-hub's src/main.cjs (the small miscellaneous
// ipcMain.handle calls that didn't belong to any single backend domain:
// settings:get/set-theme/set-subtitle-language, account:logout,
// clipboard:write, open:external, window:toggle-fullscreen). Validation/
// fallback behavior (theme normalization, the subtitle-language regex,
// the external-URL allowlist check) is preserved exactly from the
// original — do not "improve" any of it without re-auditing against the
// source app.

import { app, BrowserWindow, clipboard, dialog, shell } from 'electron'
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import type { MediaHubPublicSettings, MediaHubSettingsSnapshot } from '../../shared/media-hub/types'
import { handle } from './ipcGuard'
import { logError } from './logger'
import { mpvPath, hasActivePlayback, stopPlayback } from './playbackSession'
import { normalizeTheme, publicSettings, logoutSettings, THEMES } from './preferences'
import { normalizePlaybackBuffer } from '../../shared/media-hub/playbackBuffer'
import { isAllowedExternalUrl } from './security'
import { clearAllSessions, MIN_CACHE_BYTES } from './streamCache'
import {
  getTorBoxToken,
  omdbCredentials,
  osConnected,
  partySyncCredentials,
  readSettings,
  subdlConnected,
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
    omdbConnected: Boolean(omdbCredentials().apiKey),
    osConnected: osConnected(),
    subdlConnected: subdlConnected(),
    partySyncConnected: Boolean(partySyncCredentials().url && partySyncCredentials().inviteKey),
    playerAvailable: Boolean(mpvPath)
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

  handle<unknown, { audioLanguage: string }>(
    MEDIA_HUB_CHANNELS.settingsSetAudioLanguage,
    (_event, value) => {
      const settings = readSettings()
      // Same validation shape as subtitleLanguage above — a bare language
      // tag, nothing that could reach a URL or a filesystem path.
      settings.audioLanguage = (String(value || 'en')
        .trim()
        .toLowerCase()
        .match(/^[a-z-]{2,10}$/) || ['en'])[0]
      writeSettings(settings)
      return { audioLanguage: settings.audioLanguage }
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

  handle<unknown, { autoSubtitlesEnabled: boolean }>(
    MEDIA_HUB_CHANNELS.settingsSetAutoSubtitles,
    (_event, value) => {
      const settings = readSettings()
      settings.autoSubtitlesEnabled = value !== false
      writeSettings(settings)
      return { autoSubtitlesEnabled: settings.autoSubtitlesEnabled }
    }
  )

  handle<unknown, { uiAnimationsEnabled: boolean }>(
    MEDIA_HUB_CHANNELS.settingsSetUiAnimations,
    (_event, value) => {
      const settings = readSettings()
      settings.uiAnimationsEnabled = value !== false
      writeSettings(settings)
      return { uiAnimationsEnabled: settings.uiAnimationsEnabled }
    }
  )

  handle<unknown, { performancePanelVisible: boolean }>(
    MEDIA_HUB_CHANNELS.settingsSetPerformancePanelVisible,
    (_event, value) => {
      const settings = readSettings()
      settings.performancePanelVisible = value !== false
      writeSettings(settings)
      return { performancePanelVisible: settings.performancePanelVisible }
    }
  )

  handle<
    { maxStreamResolution?: number; maxStreamSizeGb?: number; connectionSpeedMbps?: number },
    { maxStreamResolution: number; maxStreamSizeGb: number; connectionSpeedMbps?: number }
  >(MEDIA_HUB_CHANNELS.settingsSetStreamLimits, (_event, value) => {
    const settings = readSettings()
    const resolutions = new Set([0, 480, 720, 1080, 1440, 2160])
    const resolution = Number(value?.maxStreamResolution)
    const size = Number(value?.maxStreamSizeGb)
    if (resolutions.has(resolution)) settings.maxStreamResolution = resolution
    if (Number.isFinite(size) && size >= 0 && size <= 1000) settings.maxStreamSizeGb = size
    const speed = Number(value?.connectionSpeedMbps)
    if (Number.isFinite(speed) && speed > 0) settings.connectionSpeedMbps = speed
    writeSettings(settings)
    return {
      maxStreamResolution: Number(settings.maxStreamResolution) || 0,
      maxStreamSizeGb: Number(settings.maxStreamSizeGb) || 0,
      connectionSpeedMbps: Number(settings.connectionSpeedMbps) || undefined
    }
  })

  // Accepts any non-negative value, not just SettingsPage's quick-pick
  // presets — the person can type their own (3, 12, 15, whatever). 0 is
  // "unbounded/drive-limited" (still subject to streamCache.ts's own
  // free-space safety margin), not "off" — the feature always runs, this
  // only bounds it, and is left exactly as requested rather than clamped.
  // Anything else is clamped into [MIN_CACHE_GB, 2000]: the floor mirrors
  // streamCache.ts's own MIN_CACHE_BYTES exactly (re-clamped there
  // regardless of what's saved here, so this is just for a sane UI value,
  // not the actual enforcement point); 2000 is a sanity ceiling against a
  // mistyped value (e.g. an extra zero), not a real limit.
  const MIN_CACHE_GB = Math.ceil(MIN_CACHE_BYTES / (1024 * 1024 * 1024))
  handle<{ streamCacheMaxGb?: number }, { streamCacheMaxGb: number }>(
    MEDIA_HUB_CHANNELS.settingsSetStreamCacheSize,
    (_event, value) => {
      const settings = readSettings()
      const requested = Number(value?.streamCacheMaxGb)
      if (Number.isFinite(requested) && requested >= 0) {
        settings.streamCacheMaxGb =
          requested === 0 ? 0 : Math.min(2000, Math.max(MIN_CACHE_GB, Math.round(requested)))
      }
      writeSettings(settings)
      return { streamCacheMaxGb: Number(settings.streamCacheMaxGb) || 0 }
    }
  )

  // Opens a native folder picker and, if the person actually chose a
  // folder (not cancelled), validates it's genuinely writable — probing
  // with a real write+delete inside the actual 'stream-cache' subfolder
  // streamCache.ts will use, not just the chosen folder itself — before
  // saving it. Does NOT move any already-cached data from the old
  // location; that's surfaced in the settings description, not handled
  // here, since silently relocating a possibly-large amount of data on a
  // settings change would be a surprising, slow side effect of what looks
  // like a simple picker.
  handle<undefined, { streamCacheDir?: string; cancelled?: boolean; error?: string }>(
    MEDIA_HUB_CHANNELS.settingsChooseStreamCacheDir,
    async (event) => {
      // A live StreamCache instance keeps writing to whichever root it
      // captured at start() regardless of a later setting change — and
      // every list/prune/clear call only ever resolves the CURRENT
      // setting, so an active session's directory left behind at the old
      // location would never be reachable again once this changes.
      // Refusing the change outright (rather than trying to relocate an
      // in-flight download's directory out from under its own writer, or
      // silently stranding it) is the safe option; the person just needs
      // to stop playback first. Checked before even opening the picker so
      // choosing a folder is never wasted effort.
      if (hasActivePlayback()) {
        return {
          streamCacheDir: readSettings().streamCacheDir,
          error: 'Stop playback before changing the cache location.'
        }
      }
      const win = BrowserWindow.fromWebContents(event.sender)
      const result = win
        ? await dialog.showOpenDialog(win, {
            properties: ['openDirectory', 'createDirectory'],
            title: 'Choose a folder for the stream cache'
          })
        : await dialog.showOpenDialog({
            properties: ['openDirectory', 'createDirectory'],
            title: 'Choose a folder for the stream cache'
          })
      const chosen = result.canceled ? undefined : result.filePaths[0]
      if (!chosen) {
        return { streamCacheDir: readSettings().streamCacheDir, cancelled: true }
      }
      const probeDir = path.join(chosen, 'stream-cache')
      try {
        await fsp.mkdir(probeDir, { recursive: true })
        const probeFile = path.join(
          probeDir,
          `.write-test-${crypto.randomBytes(8).toString('hex')}`
        )
        await fsp.writeFile(probeFile, 'ok')
        await fsp.unlink(probeFile)
      } catch (error) {
        logError('settings:choose-stream-cache-dir', error)
        return {
          streamCacheDir: readSettings().streamCacheDir,
          error: 'That folder is not writable.'
        }
      }
      // Reads cacheRootDir() fresh, which still resolves to whatever
      // streamCacheDir WAS (settings haven't been overwritten yet below) —
      // without this, idle sessions cached under the old location become
      // unreachable the instant the setting changes: listCacheSessions/
      // pruneIdleSessions/clearAllSessions only ever look at the CURRENT
      // setting, so they'd sit there indefinitely, potentially many
      // gigabytes, with no path back to them. The hasActivePlayback()
      // guard above means there's no active session to worry about
      // preserving here — every directory clearAllSessions finds at this
      // point is genuinely idle.
      await clearAllSessions()
      const settings = readSettings()
      settings.streamCacheDir = chosen
      writeSettings(settings)
      return { streamCacheDir: chosen }
    }
  )

  handle<undefined, { streamCacheDir?: string }>(
    MEDIA_HUB_CHANNELS.settingsResetStreamCacheDir,
    async () => {
      // Same reasoning as settingsChooseStreamCacheDir above — refuse
      // while a session is actively writing to the current root, rather
      // than stranding its directory once this reverts to the default.
      if (hasActivePlayback()) {
        throw new Error('Stop playback before changing the cache location.')
      }
      // Clears the (still-current-until-the-write-below) custom location
      // before reverting to the default userData path, so it isn't
      // stranded — see settingsChooseStreamCacheDir's own comment.
      await clearAllSessions()
      const settings = readSettings()
      delete settings.streamCacheDir
      writeSettings(settings)
      return { streamCacheDir: undefined }
    }
  )

  handle<unknown, { partyDisplayName: string }>(
    MEDIA_HUB_CHANNELS.settingsSetPartyDisplayName,
    (_event, value) => {
      const settings = readSettings()
      settings.partyDisplayName = String(value || '')
        .trim()
        .slice(0, 40)
      writeSettings(settings)
      return { partyDisplayName: settings.partyDisplayName }
    }
  )

  handle<
    Partial<
      Pick<
        MediaHubPublicSettings,
        'hideWatchedDefault' | 'hideCompletedDefault' | 'hideDislikedDefault'
      >
    >,
    Pick<
      MediaHubPublicSettings,
      'hideWatchedDefault' | 'hideCompletedDefault' | 'hideDislikedDefault'
    >
  >(MEDIA_HUB_CHANNELS.settingsSetHideDefaults, (_event, value) => {
    const settings = readSettings()
    const partial = value || {}
    if ('hideWatchedDefault' in partial)
      settings.hideWatchedDefault = partial.hideWatchedDefault === true
    if ('hideCompletedDefault' in partial)
      settings.hideCompletedDefault = partial.hideCompletedDefault === true
    if ('hideDislikedDefault' in partial)
      settings.hideDislikedDefault = partial.hideDislikedDefault === true
    writeSettings(settings)
    return {
      hideWatchedDefault: settings.hideWatchedDefault === true,
      hideCompletedDefault: settings.hideCompletedDefault === true,
      hideDislikedDefault: settings.hideDislikedDefault === true
    }
  })

  handle<undefined, { ok: true }>(MEDIA_HUB_CHANNELS.logout, async () => {
    // deleteCache=true: whatever was playing belonged to the account
    // that's about to be logged out of, same reasoning as before-quit in
    // main/index.ts — no session left to resume the cache into.
    await stopPlayback(true)
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
