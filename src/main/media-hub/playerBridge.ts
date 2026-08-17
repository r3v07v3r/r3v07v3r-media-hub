// Owns the single mpv instance and everything that crosses between it, the
// player-overlay window, and the main window.
//
// The session shape here is deliberately the same one playbackSession.ts
// already had: one global player, not one per component. That is not an
// accident of porting — the renderer's player UI unmounts and remounts per
// title (GlobalOverlays keys it on the media id), and an mpv handle tied to
// that lifecycle would be destroyed and rebuilt on every title change. It also
// reproduces a bug the old code hit and documented: tearing the backend session
// down from a component unmount broke the *next* title in a watch party.

import { BrowserWindow } from 'electron'
import path from 'node:path'

import type {
  PlayerCommand,
  PlayerSessionSnapshot,
  PlayerStatePatch,
  PlayerUiEvent
} from '../../shared/media-hub/player'
import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import { handle } from './ipcGuard'
import { logError } from './logger'
import {
  MpvPlayer,
  findMpv,
  mpvTrackIdForOrdinal,
  ordinalForMpvTrackId,
  tracksFromMpvTrackList,
  type MpvTrackListEntry
} from './mpv'
import {
  closePlayerOverlay,
  openPlayerOverlay,
  raisePlayerOverlay,
  sendToPlayerOverlay,
  setOverlayInteractive
} from './playerWindow'
import { getActiveWindow, sendToRenderer } from './rendererBridge'

const player = new MpvPlayer()
let sessionSnapshot: PlayerSessionSnapshot | null = null

export function getPlayer(): MpvPlayer {
  return player
}

// ---------------------------------------------------------------------------
// State push
// ---------------------------------------------------------------------------

// mpv emits time-pos far more often than any UI needs (and far more often than
// the old `timeupdate` event did, which fired ~4Hz). Flooding IPC with that
// would cost more than the information is worth, so patches accumulate and
// flush on a timer. Anything the user is waiting to *see* the result of —
// pause, an error, a track change — flushes immediately instead, because a
// 120ms lag on a play/pause click is perceptible where the same lag on a clock
// readout is not.
const STATE_FLUSH_MS = 120
let pendingPatch: PlayerStatePatch = {}
let flushTimer: NodeJS.Timeout | null = null

function flushPatch(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (Object.keys(pendingPatch).length === 0) return
  const patch = pendingPatch
  pendingPatch = {}
  sendToPlayerOverlay(MEDIA_HUB_CHANNELS.playerState, patch)
}

function queuePatch(patch: PlayerStatePatch, immediate = false): void {
  Object.assign(pendingPatch, patch)
  if (immediate) {
    flushPatch()
    return
  }
  if (!flushTimer) flushTimer = setTimeout(flushPatch, STATE_FLUSH_MS)
}

export function pushSessionSnapshot(snapshot: PlayerSessionSnapshot): void {
  sessionSnapshot = snapshot
  sendToPlayerOverlay(MEDIA_HUB_CHANNELS.playerSession, snapshot)
}

export function getSessionSnapshot(): PlayerSessionSnapshot | null {
  return sessionSnapshot
}

async function readTracks(): Promise<ReturnType<typeof tracksFromMpvTrackList>> {
  const [list, duration] = await Promise.all([
    player.get<MpvTrackListEntry[]>('track-list').catch(() => [] as MpvTrackListEntry[]),
    player.get<number>('duration').catch(() => undefined)
  ])
  return tracksFromMpvTrackList(list, duration)
}

/** Wires every property the UI needs. Called once per mpv process, not per
 *  title — observers survive `loadfile`. */
async function attachObservers(): Promise<void> {
  await player.observe('time-pos', (value) => {
    if (typeof value === 'number') queuePatch({ timePos: value })
  })
  await player.observe('duration', (value) => {
    if (typeof value === 'number') queuePatch({ duration: value })
  })
  await player.observe('pause', (value) => {
    if (typeof value === 'boolean') queuePatch({ paused: value }, true)
  })
  await player.observe('volume', (value) => {
    if (typeof value === 'number') queuePatch({ volume: value / 100 })
  })
  await player.observe('speed', (value) => {
    if (typeof value === 'number') queuePatch({ speed: value })
  })
  await player.observe('aid', (value) => {
    queuePatch({ audioOrdinal: ordinalForMpvTrackId(value) }, true)
  })
  await player.observe('sid', (value) => {
    queuePatch({ subtitleOrdinal: ordinalForMpvTrackId(value) }, true)
  })
  // The buffering gate's input. `demuxer-cache-duration` is how far past the
  // playhead the demuxer has read — the honest equivalent of
  // `video.buffered.end(last) - video.currentTime`, and unlike that one it
  // never describes a stale pre-seek segment.
  await player.observe('demuxer-cache-duration', (value) => {
    if (typeof value === 'number') queuePatch({ cacheAheadSeconds: value })
  })
  await player.observe('paused-for-cache', (value) => {
    if (typeof value === 'boolean') queuePatch({ bufferingForCache: value }, true)
  })
  // The moment mpv's video window genuinely exists. This is what the controls
  // have to be raised against — `file-loaded` is too early, since the window is
  // created a little after the file is.
  await player.observe('vo-configured', (value) => {
    if (value === true) raiseOverlaySoon()
  })
  await player.observe('eof-reached', (value) => {
    if (value === true) queuePatch({ eofReached: true }, true)
  })
  // A track list can change mid-playback (sub-add), so it is observed rather
  // than only read once at load.
  await player.observe('track-list', () => {
    void readTracks()
      .then((tracks) => queuePatch({ tracks }, true))
      .catch(() => {})
  })

  // The keyboard backstop (see MpvPlayer.bindSafetyKeys). These arrive when
  // mpv's own window has focus rather than the controls overlay, and route to
  // exactly the same actions the overlay's buttons do.
  player.on('client-message', (msg) => {
    const args = Array.isArray(msg.args) ? (msg.args as unknown[]) : []
    switch (String(args[0] ?? '')) {
      case 'r3-stop':
        // Same path the overlay's close button takes.
        sendToRenderer(MEDIA_HUB_CHANNELS.playerUiEvent, { type: 'stop-playback', watched: false })
        return
      case 'r3-toggle-pause':
        void runCommand({ type: 'toggle-pause' }).catch(() => {})
        return
      case 'r3-seek-back':
        void player.command('seek', -15, 'relative').catch(() => {})
        return
      case 'r3-seek-forward':
        void player.command('seek', 15, 'relative').catch(() => {})
        return
      default:
        return
    }
  })

  // mpv's failure model is end-file with a reason, not anything resembling
  // MediaError.code. Only a genuine error is surfaced: a normal stop or an EOF
  // arrives on the same event and must not be reported as a failure.
  player.on('end-file', (msg) => {
    const reason = String(msg.reason ?? '')
    if (reason !== 'error') return
    const detail = String(msg.file_error ?? 'playback failed')
    logError('media-hub:player', new Error(`mpv end-file: ${detail}`))
    queuePatch({ error: detail }, true)
  })
}

/**
 * Raises the controls above the video, several times over a short window.
 *
 * Deliberately repeated rather than done once. mpv creates, and can re-create,
 * its always-on-top video window asynchronously — on load, and again on things
 * like a resolution change — and whichever always-on-top window was raised last
 * wins on Windows. A single raise is a race this side loses often enough to
 * leave someone staring at a video with no controls and no obvious way out.
 * Re-raising a window that is already on top costs nothing.
 */
const RAISE_RETRIES_MS = [0, 150, 400, 900, 1800]
let raiseTimers: NodeJS.Timeout[] = []

function raiseOverlaySoon(): void {
  clearRaiseTimers()
  raiseTimers = RAISE_RETRIES_MS.map((delay) => setTimeout(() => raisePlayerOverlay(), delay))
}

function clearRaiseTimers(): void {
  for (const timer of raiseTimers) clearTimeout(timer)
  raiseTimers = []
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export interface StartPlayerSessionOptions {
  startSeconds?: number
  audioLanguage?: string
  subtitleLanguage?: string
  videoScaling?: import('../../shared/media-hub/videoScaling').VideoScalingPreset
  /** The playback-buffer preset in seconds (3 | 8 | 15). Chooses how far ahead
   *  mpv keeps reading — see mpv.ts's BUFFERING note. Only applied when the
   *  process is started, since these are launch options. */
  bufferSeconds?: number
}

/**
 * Ensures mpv is running and embedded, opens the control overlay, and loads
 * `url`. `url` is validated inside MpvPlayer.loadFile — see assertPlayableUrl,
 * which is the guard that used to sit immediately before every ffmpeg spawn.
 */
export async function startPlayerSession(
  url: string,
  options: StartPlayerSessionOptions = {}
): Promise<{ tracks: ReturnType<typeof tracksFromMpvTrackList> }> {
  const mainWindow = getActiveWindow()
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('No application window is available for playback.')
  }

  if (!player.running) {
    const mpvPath = findMpv()
    if (!mpvPath) {
      throw new Error(
        'The bundled player is missing. Reinstall the app, or run the postinstall step ' +
          '(scripts/fetch-mpv.ts) if this is a development build.'
      )
    }
    await player.start(mpvPath, {
      bounds: mainWindow.getContentBounds(),
      bufferSeconds: options.bufferSeconds,
      onLog: (chunk) => {
        const line = chunk.trim()
        if (line) logError('mpv:stderr', line)
      }
    })
    await attachObservers()
    await player.bindSafetyKeys()
  }
  trackWindow(mainWindow)

  openPlayerOverlay(mainWindow)
  await player.loadFile(url, {
    startSeconds: options.startSeconds,
    audioLanguage: options.audioLanguage,
    subtitleLanguage: options.subtitleLanguage,
    videoScaling: options.videoScaling
  })

  // Raising once here is NOT enough, and that is the whole subtlety: the
  // `file-loaded` this just awaited fires before mpv's video window actually
  // exists, so a single raise at this point loses the race and the controls end
  // up buried again — reported live as "I still can't see the bottom nav bar".
  // The `vo-configured` observer below is the real trigger; these are belt and
  // braces for the case where it has already fired.
  raiseOverlaySoon()

  const tracks = await readTracks()
  queuePatch({ tracks }, true)
  return { tracks }
}

/** Unloads the title and closes the overlay, leaving the mpv process running
 *  and idle so the next title is a `loadfile` rather than a respawn. Unloading
 *  is also what destroys mpv's embedded video window, which is what makes the
 *  app UI behind it visible again. */
export async function stopPlayerSession(): Promise<void> {
  clearRaiseTimers()
  untrackWindow?.()
  pendingPatch = {}
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  sessionSnapshot = null
  closePlayerOverlay()
  await player.stopFile()
}

/** Full teardown, for app quit. */
export async function shutdownPlayer(): Promise<void> {
  await stopPlayerSession().catch(() => {})
  await player.quit().catch(() => {})
}

/**
 * Loads an external subtitle file and selects it. Used by the subtitles:apply
 * flow once it has written the .srt to disk.
 *
 * mpv parses SRT directly, so nothing converts it first — the srtToVtt step the
 * old `<track>` element required is gone, and with it the class of silent
 * failure where an .ass or frame-based .sub came back from a provider, had
 * `WEBVTT` stapled to the front, and produced a track with zero parseable cues
 * that the app reported as a complete success.
 */
export async function addSubtitleFileToPlayer(filePath: string): Promise<number> {
  if (!player.running) throw new Error('No title is currently playing.')
  await player.command('sub-add', filePath, 'select')
  // Report which ordinal it landed on so the menu can mark it active
  // immediately, rather than waiting for the observed track-list push.
  const sid = await player.get('sid').catch(() => undefined)
  return ordinalForMpvTrackId(sid)
}

/**
 * Keeps mpv's window glued to the app's content area.
 *
 * mpv is not embedded — it owns a borderless always-on-top window (see mpv.ts's
 * WINDOWING note on why embedding does not work), which means nothing moves it
 * for us. Every way the app window can change shape has to be mirrored, and it
 * has to be hidden when the app is not on screen, or an always-on-top video
 * window would sit over whatever the person switched to.
 */
let untrackWindow: (() => void) | null = null

function trackWindow(mainWindow: BrowserWindow): void {
  if (untrackWindow) return
  const sync = (): void => {
    if (mainWindow.isDestroyed()) return
    void player.setBounds(mainWindow.getContentBounds())
  }
  // Fullscreen transitions report their final bounds a frame or two late on
  // Windows, so re-sync once they have settled rather than trying to predict.
  const syncSettled = (): void => {
    setTimeout(sync, 120)
  }
  const hide = (): void => void player.setWindowVisible(false)
  const show = (): void => {
    void player.setWindowVisible(true)
    sync()
  }

  mainWindow.on('resize', sync)
  mainWindow.on('move', sync)
  mainWindow.on('enter-full-screen', syncSettled)
  mainWindow.on('leave-full-screen', syncSettled)
  mainWindow.on('minimize', hide)
  mainWindow.on('restore', show)
  mainWindow.on('hide', hide)
  mainWindow.on('show', show)

  untrackWindow = () => {
    mainWindow.off('resize', sync)
    mainWindow.off('move', sync)
    mainWindow.off('enter-full-screen', syncSettled)
    mainWindow.off('leave-full-screen', syncSettled)
    mainWindow.off('minimize', hide)
    mainWindow.off('restore', show)
    mainWindow.off('hide', hide)
    mainWindow.off('show', show)
    untrackWindow = null
  }
}

// ---------------------------------------------------------------------------
// Command handling
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Every value below is renderer-supplied and therefore untrusted, even though
 *  the renderer is our own — the IPC surface is the boundary, not the intent of
 *  the code on the other side of it. */
async function runCommand(command: PlayerCommand): Promise<void> {
  switch (command.type) {
    case 'play':
      await player.set('pause', false)
      return
    case 'pause':
      await player.set('pause', true)
      return
    case 'toggle-pause': {
      const paused = await player.get<boolean>('pause').catch(() => false)
      await player.set('pause', !paused)
      return
    }
    case 'seek': {
      const seconds = Number(command.seconds)
      if (!Number.isFinite(seconds)) throw new Error('Invalid seek position.')
      await player.command('seek', clamp(seconds, 0, 86400), 'absolute')
      return
    }
    case 'set-audio-track':
      await player.set('aid', mpvTrackIdForOrdinal(Number(command.ordinal)))
      return
    case 'set-subtitle-track':
      await player.set('sid', mpvTrackIdForOrdinal(Number(command.ordinal)))
      return
    case 'set-volume': {
      const volume = Number(command.volume)
      if (!Number.isFinite(volume)) throw new Error('Invalid volume.')
      // The UI speaks 0-1 (what video.volume used to be); mpv speaks 0-100.
      await player.set('volume', clamp(volume, 0, 1) * 100)
      return
    }
    case 'set-speed': {
      const speed = Number(command.speed)
      if (!Number.isFinite(speed)) throw new Error('Invalid speed.')
      // Bounded well inside anything partySync's drift correction asks for
      // (±8%), so a bad value cannot run a title at 100x.
      await player.set('speed', clamp(speed, 0.25, 4))
      return
    }
    case 'add-subtitle-file': {
      // mpv will happily open any path it is given. The renderer only ever has
      // a legitimate reason to name a file the subtitles:apply flow just wrote,
      // so anything outside that directory is refused rather than trusted.
      const resolved = path.resolve(String(command.path))
      const root = path.resolve(subtitleCacheRoot())
      const withinRoot = resolved === root || resolved.startsWith(root + path.sep)
      if (!withinRoot) throw new Error('Refusing to load a subtitle from outside the cache.')
      await player.command('sub-add', resolved, 'select')
      return
    }
    case 'set-subtitle-delay': {
      const seconds = Number(command.seconds)
      if (!Number.isFinite(seconds)) throw new Error('Invalid subtitle delay.')
      await player.set('sub-delay', clamp(seconds, -60, 60))
      return
    }
    case 'set-fit-mode': {
      // The old UI did this with CSS object-fit on the <video> element. There
      // is no CSS box around a native surface, so it maps onto mpv's own
      // scaling: 'contain' letterboxes, 'cover' crops to fill (panscan 1),
      // 'fill' stretches by ignoring the aspect ratio.
      if (command.mode === 'contain') {
        await player.set('keepaspect', true)
        await player.set('panscan', 0)
      } else if (command.mode === 'cover') {
        await player.set('keepaspect', true)
        await player.set('panscan', 1)
      } else {
        await player.set('keepaspect', false)
        await player.set('panscan', 0)
      }
      return
    }
    default: {
      // Exhaustiveness: a new PlayerCommand variant must be handled here.
      const unhandled: never = command
      throw new Error(`Unsupported player command: ${JSON.stringify(unhandled)}`)
    }
  }
}

/** Indirection so this module does not import playbackSession.ts, which
 *  imports this one — see registerPlayerIpc's options. */
let subtitleCacheRootFn: () => string = () => ''
function subtitleCacheRoot(): string {
  return subtitleCacheRootFn()
}

function forwardUiEvent(event: PlayerUiEvent): void {
  if (event.type === 'set-interactive') {
    setOverlayInteractive(Boolean(event.interactive))
    // Showing the controls is the one moment it is definitely worth making sure
    // they are actually on top — mpv can re-create its video window (a
    // resolution change, for one) and silently win the z-order again.
    if (event.interactive) raisePlayerOverlay()
    return
  }
  // The party panel renders in the MAIN window, which the video window covers:
  // mpv is always-on-top and sized over the app's content area, so anything the
  // main window draws during playback is invisible and unclickable. Opening the
  // panel therefore has to hand the front to the app, and closing it gives the
  // front back. This applies to any main-window UI reached from the player, not
  // just this panel.
  if (event.type === 'set-party-panel-open' && event.open) {
    void player.set('ontop', false).catch(() => {})
    const mainWindow = getActiveWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.moveTop()
      mainWindow.focus()
    }
  }
  if (event.type === 'party-panel-closed') {
    void player.set('ontop', true).catch(() => {})
    raiseOverlaySoon()
    return
  }

  // Everything else belongs to the main window's own React state, which this
  // process cannot touch — hand it over verbatim.
  sendToRenderer(MEDIA_HUB_CHANNELS.playerUiEvent, event)
}

export interface RegisterPlayerIpcOptions {
  /** Directory external subtitle files are written to; the only place
   *  add-subtitle-file is permitted to read from. */
  subtitleCacheDir: () => string
}

export function registerPlayerIpc(options: RegisterPlayerIpcOptions): void {
  subtitleCacheRootFn = options.subtitleCacheDir

  handle<PlayerCommand, { ok: true }>(MEDIA_HUB_CHANNELS.playerCommand, async (_event, command) => {
    if (!command || typeof command !== 'object' || typeof command.type !== 'string') {
      throw new Error('Invalid player command.')
    }
    if (!player.running) throw new Error('No title is currently playing.')
    await runCommand(command)
    return { ok: true }
  })

  handle<PlayerUiEvent, { ok: true }>(MEDIA_HUB_CHANNELS.playerUiEvent, async (_event, uiEvent) => {
    if (!uiEvent || typeof uiEvent !== 'object' || typeof uiEvent.type !== 'string') {
      throw new Error('Invalid player UI event.')
    }
    forwardUiEvent(uiEvent)
    return { ok: true }
  })

  // The overlay mounts after the session has already been established, so it
  // asks for the current state rather than waiting for the next change.
  handle<undefined, { session: PlayerSessionSnapshot | null; state: PlayerStatePatch }>(
    MEDIA_HUB_CHANNELS.playerSnapshot,
    async () => ({ session: sessionSnapshot, state: await currentState() })
  )
}

/** A full state read, for an overlay that has just mounted and has no patches
 *  yet. Everything is best-effort: a property that cannot be read right now is
 *  simply absent from the patch, which the overlay already treats as
 *  "unchanged". */
async function currentState(): Promise<PlayerStatePatch> {
  if (!player.running) return {}
  const [timePos, duration, paused, volume, speed, aid, sid, cache] = await Promise.all([
    player.get<number>('time-pos').catch(() => undefined),
    player.get<number>('duration').catch(() => undefined),
    player.get<boolean>('pause').catch(() => undefined),
    player.get<number>('volume').catch(() => undefined),
    player.get<number>('speed').catch(() => undefined),
    player.get('aid').catch(() => undefined),
    player.get('sid').catch(() => undefined),
    player.get<number>('demuxer-cache-duration').catch(() => undefined)
  ])
  const patch: PlayerStatePatch = {}
  if (typeof timePos === 'number') patch.timePos = timePos
  if (typeof duration === 'number') patch.duration = duration
  if (typeof paused === 'boolean') patch.paused = paused
  if (typeof volume === 'number') patch.volume = volume / 100
  if (typeof speed === 'number') patch.speed = speed
  if (aid !== undefined) patch.audioOrdinal = ordinalForMpvTrackId(aid)
  if (sid !== undefined) patch.subtitleOrdinal = ordinalForMpvTrackId(sid)
  if (typeof cache === 'number') patch.cacheAheadSeconds = cache
  patch.tracks = await readTracks()
  return patch
}
