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

import { BrowserWindow, app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

import {
  MAX_PLAYER_VOLUME,
  NIGHT_MODE_AUDIO_FILTER,
  PLAYER_VOLUME_STEP,
  screenshotFilename,
  type PlayerCommand,
  type PlayerCommandResult,
  type PlayerInputEvent,
  type PlayerSessionSnapshot,
  type PlayerStatePatch,
  type PlayerUiEvent
} from '../../shared/media-hub/player'
import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import {
  DEFAULT_VIDEO_FIT,
  mpvPropertiesForFit,
  normalizeVideoFit,
  type VideoFitMode
} from '../../shared/media-hub/videoFit'
import {
  DEFAULT_VIDEO_PICTURE,
  VIDEO_PICTURE_CONTROLS,
  VIDEO_PICTURE_MAX,
  VIDEO_PICTURE_MIN,
  isVideoPictureControl,
  type VideoPictureControl,
  type VideoPictureSettings
} from '../../shared/media-hub/videoPicture'
import {
  DEFAULT_SUBTITLE_STYLE,
  normalizeSubtitleStyle,
  subtitleStyleProperties,
  type SubtitleStyle
} from '../../shared/media-hub/subtitleStyle'
import { getDatabase } from './dbState'
import { handle } from './ipcGuard'
import { logError } from './logger'
import { readSettings, writeSettings } from './settingsStore'
import {
  MpvPlayer,
  mpvPath,
  mpvTrackIdForOrdinal,
  ordinalForMpvTrackId,
  tracksFromMpvTrackList,
  type LoadFileOptions,
  type MpvTrackListEntry
} from './mpv'
import {
  closePlayerOverlay,
  focusPlayerOverlay,
  hidePlayerOverlayForMainUi,
  isOverlayInputReady,
  openPlayerOverlay,
  revealPlayerOverlay,
  sendToPlayerOverlay,
  setOverlayInputReady,
  showPlayerOverlayAfterMainUi
} from './playerWindow'
import {
  attachEmbedTarget,
  detachEmbedTarget,
  embedTargetMatches,
  setEmbeddedPlayerPid,
  setEmbeddedVideoHidden,
  syncEmbeddedVideo
} from './mpvEmbed'
import { getActiveWindow, sendToRenderer } from './rendererBridge'
import {
  mainWindowFullscreenTarget,
  setMainWindowFullscreen,
  toggleMainWindowFullscreen
} from './windowFullscreen'

const player = new MpvPlayer()
let sessionSnapshot: PlayerSessionSnapshot | null = null
// The live playhead, straight from the time-pos observer. Kept here (not
// asked of the overlay) so main-process callers — the watch party seeding
// its nowPlaying from a film already in progress — can name the real
// position instead of 0. Reset with the session it describes.
let lastTimePos = 0
// The title's length, from the duration observer, for the one write main
// makes to the bookmark table itself — see flushPlaybackPosition.
let lastDuration = 0
// What the current title was loaded with, so an mpv error can be answered
// with one reload at the playhead before it closes the player.
let lastLoad: {
  url: string
  options: Pick<LoadFileOptions, 'audioLanguage' | 'subtitleLanguage' | 'videoScaling'>
  retried: boolean
} | null = null

/** A dropped-frame burst is logged once it has grown by this many frames... */
const FRAME_DROP_REPORT_MIN = 10
/** ...and at most this often, so a struggling machine does not flood the log. */
const FRAME_DROP_REPORT_GAP_MS = 15_000

/**
 * Writes the live playhead to the resume bookmark, from THIS process.
 *
 * Every other bookmark write comes from the overlay's usePlayerTracking —
 * on a timer every 20s, on pause, on close, on unmount. None of those runs
 * when the app quits: before-quit tears the windows down without giving a
 * renderer a turn, so up to 20 seconds of a film watched right up to
 * closing the app were lost, and it reopened that much earlier. Main has
 * the same two facts the overlay saves — the session's media and the
 * playhead it observes — so it saves them itself on the way out. The
 * database applies its own rules (under 20s is not stored, past 90% clears
 * the bookmark), which is why this passes the raw figures through.
 */
export function flushPlaybackPosition(): void {
  const media = sessionSnapshot?.media
  if (!media || !(lastTimePos > 0)) return
  try {
    getDatabase().savePlaybackPosition(
      media.id,
      { season: media.seasonNumber, episode: media.episodeNumber },
      lastTimePos,
      lastDuration > 0 ? lastDuration : undefined
    )
  } catch (error) {
    logError('media-hub:player:flush-position', error)
  }
}

/**
 * What this app is playing RIGHT NOW, for a watch party being created
 * around it: the session's media identity plus the live playhead. Null
 * when nothing is playing. See watchParty's host handler — a party started
 * mid-film must be born already knowing its film, or every joiner lands in
 * the chat with no picture.
 */
export function currentPlaybackForParty(): {
  media: NonNullable<PlayerSessionSnapshot['media']>
  positionSeconds: number
} | null {
  const media = sessionSnapshot?.media
  if (!media) return null
  return { media, positionSeconds: Math.max(0, lastTimePos) }
}

/**
 * Pushes one subtitle look at mpv.
 *
 * Best-effort per property rather than all-or-nothing: an mpv build that does
 * not know one of these must not cost the other three. Nothing here can fail
 * in a way worth reporting — the worst case is a subtitle that looks the way
 * it did before.
 */
async function applySubtitleStyle(style: SubtitleStyle): Promise<void> {
  for (const [property, value] of Object.entries(subtitleStyleProperties(style))) {
    await player.set(property, value).catch(() => {})
  }
}

/** The stored look, or the untouched default. Read on every session start,
 *  because mpv resets these along with everything else on `loadfile`. */
export function storedSubtitleStyle(): SubtitleStyle {
  const stored = readSettings().subtitleStyle
  return stored ? normalizeSubtitleStyle(stored) : DEFAULT_SUBTITLE_STYLE
}

/** Puts the stored look back on a freshly loaded file. */
export async function applyStoredSubtitleStyle(): Promise<void> {
  await applySubtitleStyle(storedSubtitleStyle())
}

export function nightModeEnabled(): boolean {
  return readSettings().nightModeEnabled === true
}

/**
 * Applies (or clears) the loudness filter.
 *
 * An empty chain is how mpv is told to have no filters, not a missing call —
 * setting `af` to '' is what removes a previously applied one, and skipping
 * the call would leave the last title's filter in place.
 *
 * Re-applied per session for the same reason the subtitle look is: nothing
 * here should be a setting that quietly stops applying after the first
 * episode.
 */
export async function applyStoredNightMode(): Promise<void> {
  await player.set('af', nightModeEnabled() ? NIGHT_MODE_AUDIO_FILTER : '').catch(() => {})
}

// The fit mode is held here rather than in the overlay because the overlay is
// rebuilt per playback session and mpv is not: a mode chosen on one title has
// to still be the mode — and still be the one the button shows — on the next.
let fitMode: VideoFitMode = DEFAULT_VIDEO_FIT

// Like fit mode, picture adjustments live alongside the long-lived MPV
// process rather than in the overlay React tree. That makes the values survive
// an overlay remount or a new title, and lets a restarted MPV be brought back
// to the controls the overlay is showing.
let pictureSettings: VideoPictureSettings = { ...DEFAULT_VIDEO_PICTURE }

/** Writes the mode to mpv and tells the overlay what it now is. Both
 *  properties are always written, never just the one that changed, so mpv
 *  cannot end up in a state no mode describes. */
async function applyFitMode(mode: VideoFitMode): Promise<void> {
  const { keepaspect, panscan } = mpvPropertiesForFit(mode)
  await player.set('keepaspect', keepaspect)
  await player.set('panscan', panscan)
  fitMode = mode
  queuePatch({ fitMode: mode }, true)
}

function picturePatch(settings: VideoPictureSettings): Pick<PlayerStatePatch, VideoPictureControl> {
  return { ...settings }
}

async function applyPictureControl(control: VideoPictureControl, value: number): Promise<void> {
  const next = Math.round(clamp(value, VIDEO_PICTURE_MIN, VIDEO_PICTURE_MAX))
  await player.set(control, next)
  pictureSettings = { ...pictureSettings, [control]: next }
  queuePatch(picturePatch(pictureSettings), true)
}

/** Writes all four values together. A fresh MPV process starts at defaults, so
 * the remembered controls are reapplied after every title load. */
async function applyPictureSettings(): Promise<void> {
  for (const { control } of VIDEO_PICTURE_CONTROLS) {
    await player.set(control, pictureSettings[control])
  }
  queuePatch(picturePatch(pictureSettings), true)
}

async function resetPictureSettings(): Promise<void> {
  const reset = { ...DEFAULT_VIDEO_PICTURE }
  for (const { control } of VIDEO_PICTURE_CONTROLS) {
    await player.set(control, reset[control])
  }
  pictureSettings = reset
  queuePatch(picturePatch(pictureSettings), true)
}

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

/**
 * Hands an input that landed on mpv's window to the overlay, which applies it
 * through the same handlers its own clicks and keys use. Reports whether the
 * overlay was in a state to take it.
 *
 * The check is on the overlay having *subscribed*, not on its window existing.
 * The window is created before its renderer has mounted anything, and a send
 * into a window with no listener is dropped silently — so trusting existence
 * would turn "the overlay is broken", which is the case these bindings are for,
 * into "the input disappears".
 *
 * A false return therefore means no overlay is listening, which also means no
 * party sync is running, since that lives in the same React tree. The caller's
 * fallback of acting on mpv directly is only ever reached when there is nothing
 * left for it to be inconsistent with.
 */
function forwardInput(action: PlayerInputEvent['action']): boolean {
  if (!isOverlayInputReady()) return false
  sendToPlayerOverlay(MEDIA_HUB_CHANNELS.playerInput, { action })
  return true
}

/** Wires every property the UI needs. Called once per mpv process, not per
 *  title — observers survive `loadfile`. */
async function attachObservers(): Promise<void> {
  await player.observe('time-pos', (value) => {
    if (typeof value === 'number') {
      lastTimePos = value
      queuePatch({ timePos: value })
    }
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
  // Dropped frames, so that motion which JUMPS leaves a trace. A person
  // described an eye "suddenly looking right with no motion to get there";
  // whether that was the VO discarding late frames (mpv's default framedrop)
  // or the decoder skipping to catch up after a cache underrun could not be
  // told from a log that recorded neither. Reported as bursts rather than
  // per frame: a counter that only ever climbs, written once per crossing
  // of a threshold and at most every few seconds, with the position and the
  // demuxer's lead so the two causes can be told apart after the fact.
  const dropReport = { vo: 0, decoder: 0, at: 0, timePos: 0, cacheAhead: 0 }
  await player.observe('time-pos', (value) => {
    if (typeof value === 'number') dropReport.timePos = value
  })
  await player.observe('duration', (value) => {
    if (typeof value === 'number') lastDuration = value
  })
  await player.observe('demuxer-cache-duration', (value) => {
    if (typeof value === 'number') dropReport.cacheAhead = value
  })
  const reportDrops = (kind: 'vo' | 'decoder', count: number): void => {
    const since = count - dropReport[kind]
    if (since < FRAME_DROP_REPORT_MIN || Date.now() - dropReport.at < FRAME_DROP_REPORT_GAP_MS)
      return
    dropReport[kind] = count
    dropReport.at = Date.now()
    logError(
      'media-hub:player:frames',
      new Error(
        `${since} ${kind === 'vo' ? 'late frames dropped by the video output' : 'frames dropped by the decoder'} ` +
          `(${count} total) at ${dropReport.timePos.toFixed(1)}s with ${dropReport.cacheAhead.toFixed(1)}s buffered ahead`
      )
    )
  }
  await player
    .observe('frame-drop-count', (value) => {
      if (typeof value === 'number') reportDrops('vo', value)
    })
    .catch(() => {})
  await player
    .observe('decoder-frame-drop-count', (value) => {
      if (typeof value === 'number') reportDrops('decoder', value)
    })
    .catch(() => {})
  // The moment mpv's video child genuinely exists — created per loadfile, and
  // re-created on things like a mid-playback resolution change. `file-loaded`
  // is too early, since the window is created a little after the file is.
  // Every (re)creation lands the child at some size and z-position of mpv's
  // choosing, so it is sized to the client area and raised above Chromium's
  // compositor sibling here, each time.
  await player.observe('vo-configured', (value) => {
    if (value !== true) return
    syncEmbeddedVideo()
  })
  // Reported in BOTH directions, unlike every other observer here that filters
  // for the value it cares about.
  //
  // State patches merge (see PlayerWindowContext's applyPatch), so a key that
  // is only ever sent as `true` can never go back — and this one has to. mpv
  // clears eof-reached when the next `loadfile` opens, but dropping that edge
  // left the overlay believing the file had ended for the whole rest of the
  // session. The overlay's end-of-file effect re-runs whenever the playing
  // title changes, so with a stuck `true` the SECOND title played in one
  // session was marked watched the instant it started, at position zero.
  // Autoplay makes that path the normal one rather than the rare one.
  await player.observe('eof-reached', (value) => {
    queuePatch({ eofReached: value === true }, true)
  })
  // A track list can change mid-playback (sub-add), so it is observed rather
  // than only read once at load.
  await player.observe('track-list', () => {
    void readTracks()
      .then((tracks) => queuePatch({ tracks }, true))
      .catch(() => {})
  })

  // Chapters. Observed rather than read once at load because the list arrives
  // slightly after the file opens — mpv reports an empty one first — and a
  // one-shot read would decide a chaptered file has none.
  await player
    .observe('chapter-list', (value) => {
      const list = Array.isArray(value) ? (value as { title?: unknown; time?: unknown }[]) : []
      const chapters = list
        .map((chapter) => ({
          title: String(chapter?.title ?? ''),
          time: Number(chapter?.time)
        }))
        .filter((chapter) => Number.isFinite(chapter.time))
      queuePatch({ chapters }, true)
    })
    .catch(() => {})
  await player
    .observe('chapter', (value) => {
      queuePatch({ chapter: typeof value === 'number' ? value : -1 }, true)
    })
    .catch(() => {})
  await player
    .observe('audio-delay', (value) => {
      if (typeof value === 'number') queuePatch({ audioDelay: value })
    })
    .catch(() => {})

  // The keyboard backstop (see MpvPlayer.bindSafetyKeys). These arrive when
  // mpv's own window has focus rather than the controls overlay, and route to
  // exactly the same actions the overlay's buttons do.
  player.on('client-message', (msg) => {
    const args = Array.isArray(msg.args) ? (msg.args as unknown[]) : []
    // Reaching here at all means mpv's window somehow took an input (which the
    // embedded child was measured never to do — see bindSafetyKeys). From here
    // on the keys are the player's, so hand the keyboard to the controls.
    if (!mainWindowUiOpen) focusPlayerOverlay()
    switch (String(args[0] ?? '')) {
      case 'r3-stop': {
        // Escape leaves fullscreen before it closes anything, so one press is
        // never both. The overlay's own Escape follows the same rule via
        // window:exit-fullscreen — this is the copy for when mpv's window has
        // the focus instead, and the two must not disagree or Escape would mean
        // different things depending on which window happened to be focused.
        //
        // Asked of the tracked target rather than isFullScreen(), which is what
        // window:exit-fullscreen asks and is the only reading that survives an
        // in-flight transition. F11 and a double-click both go fullscreen from
        // this very window, and on Windows isFullScreen() still answers false
        // for the length of the native animation — so Escape pressed in that
        // window read "not fullscreen" and killed the film instead of leaving
        // fullscreen, which is the one outcome this branch exists to prevent.
        if (mainWindowFullscreenTarget()) {
          setMainWindowFullscreen(false)
          return
        }
        // Same path the overlay's close button takes.
        sendToRenderer(MEDIA_HUB_CHANNELS.playerUiEvent, { type: 'stop-playback', watched: false })
        return
      }
      case 'r3-toggle-pause':
        // Handed to the overlay rather than applied to mpv here. This process
        // knows how to pause a file but not who is allowed to: the watch-party
        // rules and the broadcast that keeps everyone together live in the
        // overlay's usePartySync, so pausing from here would stop one person's
        // film and leave the rest of the party playing.
        if (!forwardInput('toggle-pause')) void runCommand({ type: 'toggle-pause' }).catch(() => {})
        return
      case 'r3-toggle-fullscreen':
        // Same shared toggle the overlay's button and F11 reach through IPC, so
        // a press that arrives here mid-transition reverses the one in flight
        // instead of reading a state Windows has not caught up to yet.
        if (!forwardInput('toggle-fullscreen')) toggleMainWindowFullscreen()
        return
      case 'r3-seek-back':
        void player.command('seek', -15, 'relative').catch(() => {})
        return
      case 'r3-seek-forward':
        void player.command('seek', 15, 'relative').catch(() => {})
        return
      // Applied here rather than handed to the overlay, unlike pause: volume
      // is nobody else's business in a watch party, so there is no rule about
      // who is allowed to change it and nothing to broadcast. `add` is mpv's
      // own relative write, which saves a read and — the part that matters —
      // clamps against --volume-max itself, so a held key stops at the
      // ceiling instead of piling up writes mpv rejects.
      case 'r3-volume-up':
        void player.command('add', 'volume', PLAYER_VOLUME_STEP * 100).catch(() => {})
        return
      case 'r3-volume-down':
        void player.command('add', 'volume', -PLAYER_VOLUME_STEP * 100).catch(() => {})
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
    // One more go before the film is declared over. The failure this now
    // sees most is the local stream server breaking a connection whose
    // region it could not fill in time (streamCache's abandon) after mpv's
    // own reconnects ran out — a condition the cache is usually past by the
    // time a fresh load asks again. Reloading at the last known position is
    // what a person would do themselves; it is done once, so a title that
    // is genuinely unplayable still ends in the error the overlay reports.
    const load = lastLoad
    if (load && !load.retried && lastTimePos > 0) {
      load.retried = true
      logError(
        'media-hub:player',
        new Error(`Reloading the title once at ${lastTimePos.toFixed(1)}s after that error`)
      )
      void player
        .loadFile(load.url, { ...load.options, startSeconds: lastTimePos })
        .catch((error) => {
          logError('media-hub:player', error)
          queuePatch({ error: detail }, true)
        })
      return
    }
    queuePatch({ error: detail }, true)
  })
}

// ---------------------------------------------------------------------------
// Window arrangement
// ---------------------------------------------------------------------------
//
// There is no z-order to manage any more. The video is a child INSIDE the
// main window (mpvEmbed.ts), and the controls overlay is an OWNED window of
// it (playerWindow.ts), which Win32 keeps above its owner unconditionally —
// so main < video < controls is the resting state of the window system, not
// something re-established after every event. What remains here is one
// visibility decision: while main-window UI (the watch-party hub) is in use,
// the video child and the overlay are hidden so the page under them can be
// seen and clicked — DOM can never be composited over a child window, and an
// owned window can never be dropped below its owner, so both "get out of the
// way" moves are hides.

/**
 * Whether main-window UI is deliberately in use over the player (the
 * watch-party panel). While it is, the video child and the overlay stay
 * hidden — that is the one state where the app is meant to win.
 *
 * Mirrors what the main window reports and infers nothing. It used to be
 * cleared when playback stopped, on the grounds that a stop was main's last
 * reliable word — the renderer only reported a close while something was
 * playing. It reports both edges now, whatever is playing, so the stop is no
 * longer needed and is wrong besides: the panel outlives the film. A host whose
 * title ends with the panel still up would have had the next thing they played
 * from the queue land on a cleared flag and cover the panel that started it.
 */
let mainWindowUiOpen = false

/** Whether one of the app's own windows currently has focus. False while
 *  another application has it. (mpv can no longer hold it: the embedded child
 *  never takes focus — measured in the Phase-0 spike.) */
function appHasFocus(): boolean {
  return BrowserWindow.getFocusedWindow() !== null
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

  // The player process outlives titles, but --wid is a spawn-time option: a
  // player embedded into a window that has since been recreated is attached to
  // a dead HWND and has to be respawned, not reused.
  if (player.running && !embedTargetMatches(mainWindow)) {
    await player.quit().catch(() => {})
    detachEmbedTarget()
  }

  if (!player.running) {
    if (!mpvPath) {
      throw new Error(
        'The bundled player is missing. Reinstall the app, or run the postinstall step ' +
          '(scripts/fetch-mpv.ts) if this is a development build.'
      )
    }
    // The HWND handed to --wid is what embeds the video: mpv creates its
    // window as a CHILD of the main window, so there is no rectangle, band or
    // fullscreen state to settle before the load — a child is born where its
    // parent is. mpvEmbed's sync (driven off vo-configured and resize) does
    // the rest.
    const wid = attachEmbedTarget(mainWindow)
    await player.start(mpvPath, {
      wid: wid.toString(),
      bufferSeconds: options.bufferSeconds,
      onLog: (chunk) => {
        const line = chunk.trim()
        if (line) logError('mpv:stderr', line)
      }
    })
    setEmbeddedPlayerPid(player.pid)
    await attachObservers()
    await player.bindSafetyKeys()
  }
  trackWindow(mainWindow)

  openPlayerOverlay(mainWindow)

  // HAND THE RETAINED PLAYER OVER before touching it. Everything below runs
  // inside a gap the overlay cannot see: it identifies whichever title it was
  // last told about, and it is not told about the next one until
  // pushSessionSnapshot, which this function's caller only reaches once the
  // load below has finished. An overlay still naming the OUTGOING title
  // attributes everything it observes to the outgoing bookmark — so its
  // 20-second save timer, firing anywhere in that gap, would write the reset
  // volume below into the last film's bookmark and quietly drop the boost
  // stored there. The same gap misfiles positions once `loadfile` swaps the
  // clock underneath it.
  //
  // Clearing the media closes that gap instead of narrowing it: the overlay's
  // per-title teardown save fires on the change, recording the outgoing title
  // with the position and volume it really had — both still untouched at this
  // point — and tracking then stays quiet until a snapshot names its next
  // subject. Ordering is what makes that airtight rather than lucky: session
  // snapshots are sent immediately while property observations are batched
  // behind STATE_FLUSH_MS, so the overlay cannot see the reset below while it
  // still believes the old title is the one playing.
  //
  // Tracks and settings are deliberately left standing: the outgoing film is
  // still on screen and still playing until `loadfile` replaces it, so its
  // track menus are still the truthful ones. A first title has no outgoing
  // snapshot at all, which makes this a no-op outside a real title change.
  // nextUp goes with the media, not with the tracks and settings kept above.
  // It names an episode of the OUTGOING title; leaving it standing would hang
  // the old show's next episode off the incoming one's post-play card until
  // resolveNextUp got around to replacing it.
  const outgoing = getSessionSnapshot()
  if (outgoing?.media) pushSessionSnapshot({ ...outgoing, media: null, nextUp: null })

  // EVERY title starts at its own level, because mpv keeps `volume` across
  // `loadfile` and a boost belongs to the film it was needed for — carrying
  // 180% from a quiet film into the next one is a shock, not a preference.
  //
  // BEFORE the load for the same reason the window state above is: `loadfile`
  // starts playing, and loadFile() does not return until mpv reports
  // `file-loaded`, by which time sound is already coming out. Reset it
  // afterwards and the opening seconds of the new title are the previous
  // title's amplification — the exact shock this exists to prevent, just
  // shorter.
  //
  // Restoring the boost is the overlay's job, out of the resume bookmark, and
  // the ordering that makes the two agree is not an accident: this runs inside
  // startPlayerSession, while the overlay cannot even know WHICH title it is
  // looking at until pushSessionSnapshot, which its caller only reaches after
  // this function resolves. The reset therefore always lands first, and the
  // restore — if there is one — always lands on top of it.
  await player.set('volume', 100).catch(() => {})

  // Same reasoning, same place: mpv keeps ab-loop-a/b across `loadfile` too,
  // so a loop set on the outgoing episode would otherwise keep silently
  // repeating a two-second window of whatever plays next. "no" is mpv's own
  // spelling of "not set" for these two properties, not the number 0.
  await player.set('ab-loop-a', 'no').catch(() => {})
  await player.set('ab-loop-b', 'no').catch(() => {})

  // The playhead belongs to the title about to load, not the outgoing one —
  // a party hosted in the gap must not seed the new film with the old
  // film's position. The observer refreshes it within the first second.
  lastTimePos = Number(options.startSeconds) || 0

  // Kept for the one reload the end-file handler is allowed — see there.
  lastLoad = {
    url,
    options: {
      audioLanguage: options.audioLanguage,
      subtitleLanguage: options.subtitleLanguage,
      videoScaling: options.videoScaling
    },
    retried: false
  }
  await player.loadFile(url, {
    startSeconds: options.startSeconds,
    ...lastLoad.options
  })

  // Only now do the controls go on screen. The overlay was created before the
  // load, because its renderer needs that time to boot, but a control bar over
  // the media detail page with no film behind it is not a loading state anyone
  // asked for — see revealPlayerOverlay.
  //
  // Unconditional, unlike the raises below: those skip when the app is not the
  // window being used, and a film that started while the person was in another
  // application must still have controls waiting when they come back to it.
  revealPlayerOverlay()

  // Re-asserted per title rather than set once. mpv keeps these properties
  // across `loadfile`, so this is usually a no-op — but the process can be
  // respawned mid-run (a crash, or playback stopped and restarted after a
  // shutdown), and a respawned mpv is back at its defaults while the overlay
  // would still be showing the mode that was chosen before.
  await applyFitMode(fitMode).catch(() => {})
  await applyPictureSettings().catch(() => {})

  // Re-asserted per title rather than assumed, because main-window UI being up
  // is a state a title change does NOT close: a host playing something from
  // the watch-party queue goes through here with the panel still open and
  // still rendering (PartyPanel's Play button -> requestPartyPlay, which
  // starts the title and leaves the panel alone). The new film's video child
  // appearing over the panel would make it vanish mid-party, for no reason the
  // person could see — so the child stays hidden until the panel closes (see
  // party-panel-closed). The false branch matters equally: it clears a hide
  // left over from a previous session's panel.
  setEmbeddedVideoHidden(mainWindowUiOpen)
  if (mainWindowUiOpen) hidePlayerOverlayForMainUi()

  const tracks = await readTracks()
  queuePatch({ tracks }, true)
  return { tracks }
}

/** Unloads the title and closes the overlay, leaving the mpv process running
 *  and idle so the next title is a `loadfile` rather than a respawn. Unloading
 *  is also what destroys mpv's embedded video window, which is what makes the
 *  app UI behind it visible again. */
export async function stopPlayerSession(): Promise<void> {
  untrackWindow?.()
  // mainWindowUiOpen is deliberately NOT cleared here: a stop is not a close.
  // See its own comment — the main window reports the panel itself now. The
  // video-hidden state rides with it: the next session's start re-asserts
  // both directions from the flag (see startPlayerSession's tail).
  pendingPatch = {}
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  sessionSnapshot = null
  lastTimePos = 0
  lastDuration = 0
  lastLoad = null
  closePlayerOverlay()
  // `stop` destroys mpv's embedded child window (verified in the spike), which
  // is what reveals the app UI again — no window state to unwind on this side.
  await player.stopFile()
}

/** Full teardown, for app quit. */
export async function shutdownPlayer(): Promise<void> {
  await stopPlayerSession().catch(() => {})
  await player.quit().catch(() => {})
  detachEmbedTarget()
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
 * Keeps mpv's window glued to the app's content area, and in the right place
 * in the z-order.
 *
 * mpv is not embedded — it owns a borderless window of its own (see mpv.ts's
 * WINDOWING note on why embedding does not work), which means nothing moves it
 * for us. Every way the app window can change shape has to be mirrored; it has
 * to be hidden when the app is not on screen, since a window nothing owns does
 * not minimise with the app that spawned it; and because it is not topmost
 * while windowed, it has to be raised again whenever activating the app has
 * put the app's own window in front of it.
 */
let untrackWindow: (() => void) | null = null

function trackWindow(mainWindow: BrowserWindow): void {
  if (untrackWindow) return
  // The whole burden of the floating-window era — move tracking, DIP
  // conversion, minimize mirroring, fullscreen handoff, band decisions — is
  // gone: a child window moves, minimises, hides and clips with its parent by
  // construction. What a child does NOT do is follow its parent's SIZE in
  // --wid mode, so resizes (fullscreen transitions included: Electron's
  // setFullScreen is a resize of this very window) refill the client rect.
  const sync = (): void => {
    if (mainWindow.isDestroyed()) return
    syncEmbeddedVideo()
  }
  // Fullscreen transitions report their final bounds a frame or two late on
  // Windows, so re-sync once they have settled rather than trying to predict.
  const syncSettled = (): void => {
    setTimeout(sync, 120)
  }

  mainWindow.on('resize', sync)
  mainWindow.on('enter-full-screen', syncSettled)
  mainWindow.on('leave-full-screen', syncSettled)

  untrackWindow = () => {
    mainWindow.off('resize', sync)
    mainWindow.off('enter-full-screen', syncSettled)
    mainWindow.off('leave-full-screen', syncSettled)
    untrackWindow = null
  }
}

// ---------------------------------------------------------------------------
// Command handling
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Where screenshots land — the OS's own Pictures folder, in a subfolder
 *  named for this app, exactly where somebody would look for a screenshot
 *  from any other program on their machine. Not userData: that directory is
 *  for the app's OWN files, and a person's captured frames are theirs, not
 *  this app's business to hide inside its settings folder. */
function screenshotDir(): string {
  return path.join(app.getPath('pictures'), 'R3 Media Hub')
}

/**
 * Captures the frame on screen right now to a file and returns where it
 * landed.
 *
 * `subtitles` rather than `video`: what somebody is asking to save is what
 * they are LOOKING AT, and that includes whatever subtitle line happens to
 * be on screen. OSD is irrelevant either way — this app launches mpv with
 * `--osd-level=0` (see mpv.ts), so there is never an on-screen display to
 * include or exclude.
 */
async function saveScreenshot(): Promise<string> {
  const dir = screenshotDir()
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(
    dir,
    screenshotFilename(getSessionSnapshot()?.media ?? null, new Date())
  )
  await player.command('screenshot-to-file', filePath, 'subtitles')
  return filePath
}

/** What a command handed back beyond the bare acknowledgement — currently
 *  only screenshot's saved path, which the overlay needs to build its own
 *  toast (see registerPlayerIpc). Every other case returns nothing. */
type PlayerCommandOutcome = { path?: string } | void

/** Every value below is renderer-supplied and therefore untrusted, even though
 *  the renderer is our own — the IPC surface is the boundary, not the intent of
 *  the code on the other side of it. */
async function runCommand(command: PlayerCommand): Promise<PlayerCommandOutcome> {
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
      // The UI speaks a multiplier of the source level (1 = untouched); mpv
      // speaks percent. Anything above 1 is software amplification, which mpv
      // only permits as far as the --volume-max it was launched with — hence
      // the shared ceiling on both sides.
      await player.set('volume', clamp(volume, 0, MAX_PLAYER_VOLUME) * 100)
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
    case 'set-audio-delay': {
      const seconds = Number(command.seconds)
      if (!Number.isFinite(seconds)) throw new Error('Invalid audio delay.')
      await player.set('audio-delay', clamp(seconds, -60, 60))
      return
    }
    case 'set-chapter': {
      const index = Number(command.index)
      if (!Number.isInteger(index) || index < 0) throw new Error('Invalid chapter.')
      // mpv clamps an out-of-range chapter to the last one rather than
      // erroring, which is the behaviour worth having: a chapter list that
      // changed under a click seeks to the end instead of failing.
      await player.set('chapter', index)
      return
    }
    case 'set-night-mode': {
      const enabled = command.enabled === true
      const settings = readSettings()
      settings.nightModeEnabled = enabled
      writeSettings(settings)
      await applyStoredNightMode()
      const snapshot = getSessionSnapshot()
      if (snapshot) {
        pushSessionSnapshot({
          ...snapshot,
          settings: { ...snapshot.settings, nightModeEnabled: enabled }
        })
      }
      return
    }
    case 'set-subtitle-style': {
      // Normalized rather than trusted — this is the IPC boundary, and every
      // field has an obvious safe reading. Stored as well as applied so the
      // next title opens looking the same; a look somebody set once and had to
      // set again every episode would not be worth having.
      const style = normalizeSubtitleStyle(command.style)
      await applySubtitleStyle(style)
      const settings = readSettings()
      settings.subtitleStyle = style
      writeSettings(settings)
      const current = getSessionSnapshot()
      if (current) {
        pushSessionSnapshot({ ...current, settings: { ...current.settings, subtitleStyle: style } })
      }
      return
    }
    case 'set-fit-mode':
      // Normalized rather than trusted: this is the IPC boundary, and an
      // unrecognized mode has an obvious safe reading (the default) instead of
      // being worth failing the call over.
      await applyFitMode(normalizeVideoFit(command.mode))
      return
    case 'set-picture-control': {
      if (!isVideoPictureControl(command.control)) throw new Error('Invalid picture control.')
      const value = Number(command.value)
      if (!Number.isFinite(value)) throw new Error('Invalid picture value.')
      await applyPictureControl(command.control, value)
      return
    }
    case 'reset-picture-controls':
      await resetPictureSettings()
      return
    case 'frame-step':
      await player.command('frame-step')
      return
    case 'frame-back-step':
      await player.command('frame-back-step')
      return
    case 'set-ab-loop': {
      // "no" is mpv's own way of writing "not set" for these two properties —
      // NOT the number 0, which is a real, useful loop start a track record
      // scratch would want. Sending the pair together, always, is what stops
      // a loop starting on whichever half a click happened to set second (see
      // the PlayerCommand doc comment).
      const a = Number.isFinite(command.a) ? clamp(Number(command.a), 0, 86400) : 'no'
      const b = Number.isFinite(command.b) ? clamp(Number(command.b), 0, 86400) : 'no'
      await player.set('ab-loop-a', a)
      await player.set('ab-loop-b', b)
      return
    }
    case 'screenshot': {
      const savedPath = await saveScreenshot()
      return { path: savedPath }
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
  // Both of these describe the overlay window itself, so they stop here rather
  // than going on to the main window, which has nothing to do with either.
  if (event.type === 'set-input-ready') {
    setOverlayInputReady(Boolean(event.ready))
    return
  }
  if (event.type === 'set-interactive') {
    // The window takes mouse input for the whole session (see playerWindow.ts's
    // INPUT note), so all that is decided here is the KEYBOARD: the controls
    // being revealed is the moment someone is reaching for the player, and the
    // keys should follow.
    //
    // Only while the app is the window being used, though. The controls also
    // reveal on a mouse move across whatever part of the video another
    // application is not currently covering, and taking the keyboard off that
    // application would be exactly the focus theft this design got rid of.
    // Left alone, the controls simply appear in the part of the picture that
    // is actually visible, which is the part being pointed at.
    if (event.interactive && appHasFocus() && !mainWindowUiOpen) focusPlayerOverlay()
    return
  }
  // The party panel renders in the MAIN window, whose web content the embedded
  // video child covers completely — DOM can never be composited over a child
  // window, so the panel is shown by REMOVING the video (hiding the child, and
  // the overlay's front with it) rather than by reordering windows. Audio
  // continues; the picture comes back when the panel closes. This applies to
  // any main-window UI reached from the player, not just this panel.
  //
  // mainWindowUiOpen holds that decision against everything else in this file
  // that shows the video: while the panel is up, the app is meant to win.
  //
  // Two events arrive here saying "the panel is open", and the difference
  // between them is the whole reason there are two. set-party-panel-open is the
  // overlay ASKING for a panel that is not open yet, so it goes on to the main
  // window to be acted on. party-panel-open is the main window REPORTING one
  // that already is, and it stops here — sending a report back to the window it
  // came from turns it into an instruction to re-open, and if the person closed
  // the panel while it was in flight that instruction arrives after they did
  // and re-opens it under them.
  if (event.type === 'party-panel-open' || (event.type === 'set-party-panel-open' && event.open)) {
    mainWindowUiOpen = true
    setEmbeddedVideoHidden(true)
    hidePlayerOverlayForMainUi()
    // The keyboard goes with the front: the person is about to use the panel.
    const mainWindow = getActiveWindow()
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus()
    // The report stops here. The command falls through to the main window,
    // which still has to actually open the panel the overlay asked for.
    if (event.type === 'party-panel-open') return
  }
  if (event.type === 'party-panel-closed') {
    mainWindowUiOpen = false
    setEmbeddedVideoHidden(false)
    showPlayerOverlayAfterMainUi()
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

  handle<PlayerCommand, PlayerCommandResult>(
    MEDIA_HUB_CHANNELS.playerCommand,
    async (_event, command) => {
      if (!command || typeof command !== 'object' || typeof command.type !== 'string') {
        throw new Error('Invalid player command.')
      }
      if (!player.running) throw new Error('No title is currently playing.')
      const outcome = await runCommand(command)
      return { ok: true, ...(outcome?.path ? { path: outcome.path } : {}) }
    }
  )

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
  Object.assign(patch, picturePatch(pictureSettings))
  // Read from this module, not from mpv: applyFitMode is the only writer of
  // either underlying property, so this value is the authority on which of the
  // three modes the pair currently represents.
  patch.fitMode = fitMode
  patch.tracks = await readTracks()
  return patch
}
