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
import type {
  CacheDiskDrive,
  CacheDiskProbeResult,
  CacheMode,
  ImportSummary,
  MediaHubPublicSettings,
  MediaHubSettingsSnapshot,
  SavedFilter,
  SourcePreference
} from '../../shared/media-hub/types'
import { parseImdbRatingsCsv } from '../../shared/media-hub/importCsv'
import { importLetterboxdLibrary } from './letterboxdImport'
import { readBackup } from './backup'
import { requestRecommendationsRebuild } from './recommendations'
import { watchRegion } from './watchProviders'
import { getDatabase } from './dbState'
import { handle } from './ipcGuard'
import { logError } from './logger'
import {
  mpvPath,
  hasActivePlayback,
  stopPlayback,
  applyStoragePolicyToPlayback
} from './playbackSession'
import { ollamaConfig, ollamaConnected } from './ollamaService'
import {
  normalizeCacheMode,
  effectiveCacheMode,
  normalizeMemoryCacheMb,
  normalizeSourcePreference,
  normalizeTheme,
  publicSettings,
  logoutSettings,
  THEMES
} from './preferences'
import { isMediaServerConnected } from './mediaSources'
import {
  mainWindowFullscreenTarget,
  setMainWindowFullscreen,
  toggleMainWindowFullscreen
} from './windowFullscreen'
/** What a completed restore reports back — a total worth showing, and when the
 *  backup was taken, so the confirmation can say which one landed. */
interface RestoreResult {
  restored: number
  createdAt: string
  /** Who the app switched back to — see backup.ts's activeProfileId. */
  activeProfileId: string
}

import { normalizePlaybackBuffer } from '../../shared/media-hub/playbackBuffer'
import { normalizeVideoScaling } from '../../shared/media-hub/videoScaling'
import { isAllowedExternalUrl } from './security'
import { cacheRootDir, clearAllSessions, MIN_CACHE_BYTES } from './streamCache'
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
  // One-time grandfathering for installs that predate the welcome flow: an
  // answered storage question proves the install was in use (that prompt
  // blocked the whole app), so it is marked set-up once, here at startup.
  // A live computed clause instead of this write would break the flow
  // itself — the wizard now asks the storage question mid-flow, and the
  // moment storeMedia landed the wizard would count as "complete" and
  // vanish before its tuning step.
  {
    const settings = readSettings()
    if (settings.storeMedia !== undefined && settings.setupComplete === undefined) {
      settings.setupComplete = true
      writeSettings(settings)
    }
  }
  handle<undefined, MediaHubSettingsSnapshot>(MEDIA_HUB_CHANNELS.settingsGet, () => {
    // Not what publicSettings read off disk: an Ollama running at the
    // default address is used without ever being saved (see ollamaService's
    // detectOllama), and the Settings pane renders these two fields, so it
    // has to be told which server is actually being asked.
    const ollama = ollamaConfig()
    const stored = readSettings()
    return {
      ...publicSettings(stored),
      ollamaBaseUrl: ollama.baseUrl,
      ollamaModel: ollama.model,
      appVersion: app.getVersion(),
      themes: THEMES,
      torboxConnected: Boolean(getTorBoxToken()),
      mediaServerConnected: isMediaServerConnected(),
      tmdbConnected: Boolean(tmdbCredentials().apiKey),
      omdbConnected: Boolean(omdbCredentials().apiKey),
      osConnected: osConnected(),
      subdlConnected: subdlConnected(),
      partySyncConnected: Boolean(partySyncCredentials().url && partySyncCredentials().inviteKey),
      playerAvailable: Boolean(mpvPath),
      ollamaConnected: ollamaConnected(),
      // Whether the question has been PUT, which the stored flag alone
      // cannot say: absent and false both read as false once it is a
      // boolean, and only one of them should raise the first-run prompt.
      storagePolicyChosen: stored.storeMedia !== undefined,
      // Only the explicit flag — pre-flow installs get it written once at
      // startup (see the migration at the top of registerAppIpc), so this
      // must NOT infer completeness from storeMedia: the wizard writes
      // storeMedia mid-flow, before its tuning step.
      setupComplete: stored.setupComplete === true
    }
  })

  handle<undefined, { setupComplete: boolean }>(MEDIA_HUB_CHANNELS.settingsCompleteSetup, () => {
    const settings = readSettings()
    settings.setupComplete = true
    writeSettings(settings)
    return { setupComplete: true }
  })

  // What the welcome flow's tuning step sizes the cache from. Reports free
  // space rather than choosing anything: the recommendation logic lives in
  // the renderer, and the cache LOCATION can still only change through the
  // native picker (settingsChooseStreamCacheDir) — this hands back drive
  // roots for display, never accepts one.
  handle<undefined, CacheDiskProbeResult>(MEDIA_HUB_CHANNELS.settingsCacheDiskProbe, async () => {
    const cacheDir = cacheRootDir()
    const toGb = (bytes: number): number => Math.round((bytes / 1024 ** 3) * 10) / 10
    const probeRoot = async (root: string, isCacheDrive: boolean): Promise<CacheDiskDrive> => {
      // statfs can stall on a disconnected network drive; a probe that
      // slow is not a drive worth recommending anyway.
      const stats = await Promise.race([
        fsp.statfs(root),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('probe timeout')), 1500)
        )
      ])
      return {
        root,
        freeGb: toGb(Number(stats.bavail) * Number(stats.bsize)),
        totalGb: toGb(Number(stats.blocks) * Number(stats.bsize)),
        isCacheDrive
      }
    }
    if (process.platform !== 'win32') {
      // No drive-letter concept — the filesystem holding the cache dir is
      // the only mount this can name without guessing at mount tables.
      const drive = await probeRoot(cacheDir, true).catch(() => null)
      return { cacheDir, drives: drive ? [{ ...drive, root: '/' }] : [] }
    }
    const cacheRoot = path.parse(cacheDir).root.toUpperCase()
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'
    const probes = await Promise.allSettled(
      [...letters].map((letter) => probeRoot(`${letter}:\\`, `${letter}:\\` === cacheRoot))
    )
    const drives = probes
      .filter((p): p is PromiseFulfilledResult<CacheDiskDrive> => p.status === 'fulfilled')
      .map((p) => p.value)
      .filter((d) => d.totalGb > 0)
    return { cacheDir, drives }
  })

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

  handle<unknown, { videoScaling: string }>(
    MEDIA_HUB_CHANNELS.settingsSetVideoScaling,
    (_event, value) => {
      const settings = readSettings()
      settings.videoScaling = normalizeVideoScaling(value)
      writeSettings(settings)
      return { videoScaling: settings.videoScaling }
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

  // Backup and restore. Both open a native picker rather than taking a path
  // from the renderer: the renderer must never be able to name a file for main
  // to read or write, which is the same rule settingsChooseStreamCacheDir
  // follows and the reason httpProxy exists in the shape it does.
  handle<undefined, { filePath: string | null }>(MEDIA_HUB_CHANNELS.backupExport, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const defaultName = `r3-media-hub-${new Date().toISOString().slice(0, 10)}.json`
    const options = {
      title: 'Save a backup of your library',
      defaultPath: defaultName,
      filters: [{ name: 'R3 Media Hub backup', extensions: ['json'] }]
    }
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { filePath: null }
    getDatabase().exportBackup(result.filePath, {
      appVersion: app.getVersion(),
      profiles: (readSettings().profiles ?? []) as unknown as Record<string, unknown>[],
      activeProfileId: getDatabase().activeProfile()
    })
    return { filePath: result.filePath }
  })

  handle<undefined, RestoreResult | null>(MEDIA_HUB_CHANNELS.backupImport, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Restore a backup',
      properties: ['openFile' as const],
      filters: [{ name: 'R3 Media Hub backup', extensions: ['json'] }]
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    const filePath = result.filePaths?.[0]
    if (result.canceled || !filePath) return null

    const backup = readBackup(filePath)
    const summary = getDatabase().importBackup(filePath)

    // The rows are keyed by profile id, so the profiles have to come back too
    // or a restored library would belong to nobody. Merged by id rather than
    // replacing the list: a profile that exists on this install and in the
    // backup is the same profile, and overwriting it would drop the PIN it has
    // here (a backup deliberately carries no PIN — see backup.ts).
    const settings = readSettings()
    const existing = settings.profiles ?? []
    const byId = new Map(existing.map((profile) => [profile.id, profile]))
    // Guaranteed an array by readBackup, which refuses a file without one
    // BEFORE the restore runs — this read happens after the transaction has
    // committed, so a throw here would mean a replaced library with no
    // profiles to own it.
    for (const incoming of backup.profiles as { id?: unknown }[]) {
      const id = String(incoming?.id ?? '')
      if (!id || byId.has(id)) continue
      byId.set(id, incoming as (typeof existing)[number])
    }
    settings.profiles = [...byId.values()]
    // Back to whoever was watching when the backup was taken. Restoring the
    // rows and leaving somebody else active is the shape that made this
    // confusing: the data was correct, and the library on screen belonged to a
    // different person.
    settings.activeProfileId = summary.activeProfileId
    writeSettings(settings)
    getDatabase().setActiveProfile(summary.activeProfileId)

    return {
      restored: Object.values(summary.restored).reduce((total, n) => total + n, 0),
      createdAt: summary.createdAt,
      activeProfileId: summary.activeProfileId
    }
  })

  handle<undefined, ImportSummary | null>(MEDIA_HUB_CHANNELS.importImdbRatings, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Import ratings from IMDb',
      properties: ['openFile' as const],
      // IMDb's own export is unambiguously named ratings.csv — the filter is
      // by extension rather than by that exact name, since somebody may well
      // have renamed the download.
      filters: [{ name: 'IMDb ratings export', extensions: ['csv'] }]
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    const filePath = result.filePaths?.[0]
    if (result.canceled || !filePath) return null

    // utf-8 rather than the file's own declared encoding: IMDb's export has
    // been UTF-8 (with a BOM some tools add and Node's utf-8 decoder already
    // strips) for as long as this format has existed.
    const text = await fsp.readFile(filePath, 'utf-8')
    const parsed = parseImdbRatingsCsv(text)
    const ratings = getDatabase().importRatings(parsed.rows)
    // What was just written changes what the ranking should suggest — see
    // recommendations.ts's own comment on this after a Trakt import, which
    // this mirrors exactly.
    requestRecommendationsRebuild()
    // No `plays` from this source at all: IMDb's ratings export is opinions,
    // not a watch history — it has no equivalent to Trakt's /sync/history.
    return { plays: 0, ratings, skipped: parsed.skipped }
  })

  handle<undefined, ImportSummary | null>(MEDIA_HUB_CHANNELS.importLetterboxd, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Import from Letterboxd',
      properties: ['openFile' as const],
      // Letterboxd's "Export Your Data" is always a zip — there is no loose
      // CSV to pick instead, since diary.csv and ratings.csv both live
      // inside it.
      filters: [{ name: 'Letterboxd export', extensions: ['zip'] }]
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    const filePath = result.filePaths?.[0]
    if (result.canceled || !filePath) return null

    const archive = await fsp.readFile(filePath)
    return importLetterboxdLibrary(archive)
  })

  handle<unknown, { watchRegion: string }>(
    MEDIA_HUB_CHANNELS.settingsSetWatchRegion,
    (_event, value) => {
      const settings = readSettings()
      const next = String(value ?? '')
        .trim()
        .toUpperCase()
      // An empty or malformed value CLEARS the setting rather than storing
      // nonsense, which puts the region back on the machine's locale — the
      // same thing a fresh install does, and the honest reading of "I do not
      // want to pick one".
      settings.watchRegion = /^[A-Z]{2}$/.test(next) ? next : undefined
      writeSettings(settings)
      return { watchRegion: watchRegion() }
    }
  )

  handle<{ name: string; kind: string; query: string }, { savedFilters: SavedFilter[] }>(
    MEDIA_HUB_CHANNELS.settingsSaveFilter,
    (_event, payload) => {
      const settings = readSettings()
      const name = String(payload?.name ?? '')
        .trim()
        .slice(0, 60)
      const kind = String(payload?.kind ?? '')
      if (!name || !['movie', 'series', 'anime'].includes(kind)) {
        return { savedFilters: publicSettings(settings).savedFilters }
      }
      // The id is minted here rather than in the renderer, so a saved view
      // cannot collide with one made in another window.
      const entry = {
        id: crypto.randomUUID(),
        name,
        kind,
        query: String(payload?.query ?? '')
      }
      settings.savedFilters = [...(settings.savedFilters ?? []), entry]
      writeSettings(settings)
      return { savedFilters: publicSettings(settings).savedFilters }
    }
  )

  handle<{ id: string }, { savedFilters: SavedFilter[] }>(
    MEDIA_HUB_CHANNELS.settingsDeleteFilter,
    (_event, payload) => {
      const settings = readSettings()
      const id = String(payload?.id ?? '')
      settings.savedFilters = (settings.savedFilters ?? []).filter((entry) => entry.id !== id)
      writeSettings(settings)
      return { savedFilters: publicSettings(settings).savedFilters }
    }
  )

  handle<unknown, { notificationsEnabled: boolean }>(
    MEDIA_HUB_CHANNELS.settingsSetNotifications,
    (_event, value) => {
      const settings = readSettings()
      settings.notificationsEnabled = value === true
      writeSettings(settings)
      return { notificationsEnabled: settings.notificationsEnabled }
    }
  )

  handle<unknown, { autoplayNextEnabled: boolean }>(
    MEDIA_HUB_CHANNELS.settingsSetAutoplayNext,
    (_event, value) => {
      const settings = readSettings()
      settings.autoplayNextEnabled = value !== false
      writeSettings(settings)
      return { autoplayNextEnabled: settings.autoplayNextEnabled }
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
    { cacheMode?: unknown; memoryCacheMaxMb?: unknown },
    { cacheMode: CacheMode; memoryCacheMaxMb: number }
  >(MEDIA_HUB_CHANNELS.settingsSetCacheMode, (_event, value) => {
    const settings = readSettings()
    settings.cacheMode = normalizeCacheMode(value?.cacheMode)
    // Only written when actually supplied, so flipping the mode back and
    // forth doesn't quietly reset a size the person chose.
    if (value?.memoryCacheMaxMb !== undefined) {
      settings.memoryCacheMaxMb = normalizeMemoryCacheMb(value.memoryCacheMaxMb)
    }
    writeSettings(settings)
    return {
      cacheMode: normalizeCacheMode(settings.cacheMode),
      memoryCacheMaxMb: normalizeMemoryCacheMb(settings.memoryCacheMaxMb)
    }
  })

  handle<{ storeMedia?: boolean }, { storeMedia: boolean; cacheMode: CacheMode }>(
    MEDIA_HUB_CHANNELS.settingsSetStoreMedia,
    (_event, value) => {
      const settings = readSettings()
      const storeMedia = value?.storeMedia !== false
      settings.storeMedia = storeMedia
      writeSettings(settings)
      // The session already playing is switched over too, not just the next
      // one. Persisting the answer alone left the active stream cache
      // writing to disk until playback stopped, which is the one moment the
      // promise most needed keeping. Not awaited: the answer is saved and
      // the caller can be told so immediately, and the swap is ordered
      // internally against the fill loop rather than against this reply.
      void applyStoragePolicyToPlayback().catch((error) =>
        logError('settings:setStoreMedia', error)
      )
      return {
        storeMedia,
        // The mode the app will ACTUALLY use, which is what the caller has
        // to render — saying "disk" back to somebody who just chose stream
        // only would be the exact contradiction this setting exists to
        // prevent. The saved mode underneath is left as it was, so turning
        // storage back on restores their earlier choice.
        cacheMode: effectiveCacheMode(settings)
      }
    }
  )

  handle<{ sourcePreference?: unknown }, { sourcePreference: SourcePreference }>(
    MEDIA_HUB_CHANNELS.settingsSetSourcePreference,
    (_event, value) => {
      const settings = readSettings()
      // normalizeSourcePreference is the allowlist — anything unrecognised
      // becomes 'balanced' rather than being written through, so the stored
      // value is always one this app understands.
      settings.sourcePreference = normalizeSourcePreference(value?.sourcePreference)
      writeSettings(settings)
      return { sourcePreference: normalizeSourcePreference(settings.sourcePreference) }
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

  // Always the MAIN window, never the calling window — see windowFullscreen.ts,
  // which owns that rule and the in-flight-transition tracking these three
  // handlers used to keep for themselves.
  //
  // This used to resolve the window from event.sender, which was right when the
  // app's own UI was the only caller. The player's controls are a second,
  // transparent BrowserWindow now (see playerWindow.ts), so from there
  // event.sender resolved to the overlay — created `fullscreenable: false`, so
  // Electron dropped the call and the fullscreen button did nothing at all.
  handle<undefined, { fullScreen: boolean }>(MEDIA_HUB_CHANNELS.windowToggleFullscreen, () => {
    const fullScreen = toggleMainWindowFullscreen()
    if (fullScreen === null) throw new Error('No application window is available.')
    return { fullScreen }
  })

  // Leaves fullscreen and reports whether there was any to leave.
  //
  // Separate from the toggle above because Escape needs to know the difference:
  // it exits fullscreen if there is one and closes the title otherwise, and
  // asking a toggle to do that would mean deciding from the renderer's cached
  // idea of the current state. Escape is the key people press when something
  // has already gone wrong, so it must not be able to *enter* fullscreen
  // because that cache was a frame stale.
  handle<undefined, { wasFullScreen: boolean }>(MEDIA_HUB_CHANNELS.windowExitFullscreen, () => {
    if (!mainWindowFullscreenTarget()) return { wasFullScreen: false }
    setMainWindowFullscreen(false)
    return { wasFullScreen: true }
  })

  // The player overlay is created mid-session and can therefore open into an
  // already-fullscreen window, so it reads the state once on mount rather than
  // assuming windowed and waiting for a change event that may never come.
  handle<undefined, { fullScreen: boolean }>(MEDIA_HUB_CHANNELS.windowIsFullscreen, () => {
    return { fullScreen: mainWindowFullscreenTarget() }
  })
}
