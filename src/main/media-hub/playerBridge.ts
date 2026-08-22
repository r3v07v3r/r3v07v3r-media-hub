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

import { BrowserWindow, screen } from 'electron'
import path from 'node:path'

import type {
  PlayerCommand,
  PlayerInputEvent,
  PlayerSessionSnapshot,
  PlayerStatePatch,
  PlayerUiEvent
} from '../../shared/media-hub/player'
import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import {
  DEFAULT_VIDEO_FIT,
  mpvPropertiesForFit,
  normalizeVideoFit,
  type VideoFitMode
} from '../../shared/media-hub/videoFit'
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
  isOverlayInputReady,
  openPlayerOverlay,
  raisePlayerOverlay,
  sendToPlayerOverlay,
  setOverlayInputReady,
  setOverlayInteractive,
  setPlayerOverlayTopmost
} from './playerWindow'
import { getActiveWindow, sendToRenderer } from './rendererBridge'

const player = new MpvPlayer()
let sessionSnapshot: PlayerSessionSnapshot | null = null

// The fit mode is held here rather than in the overlay because the overlay is
// rebuilt per playback session and mpv is not: a mode chosen on one title has
// to still be the mode — and still be the one the button shows — on the next.
let fitMode: VideoFitMode = DEFAULT_VIDEO_FIT

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

function toggleMainWindowFullscreen(): void {
  const win = getActiveWindow()
  if (!win || win.isDestroyed()) return
  win.setFullScreen(!win.isFullScreen())
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
    if (value !== true) return
    // The whole stack, not just the controls. That window has just been created
    // without being activated and is no longer topmost, so it cannot be assumed
    // to have arrived over the app that spawned it — and a film hidden behind
    // the app's own UI is a worse failure than controls hidden behind the film.
    //
    // Only while the app is the one being used, though: this also fires on a
    // mid-playback re-configure, and a windowed film must not pull itself over
    // whatever the person has moved on to. The raise train applies the same
    // rule, but per retry rather than once here — see raiseOverlaySoon.
    if (appHasFocus()) restackPlayer()
    raiseOverlaySoon()
  })
  // mpv's window being activated raises it over the controls, and the controls
  // are what the person needs the moment they have gone back to the film. The
  // click case also arrives as a client-message below; this covers the rest of
  // them, alt-tabbing straight to the video most of all.
  //
  // Best effort on purpose: an mpv without this property simply never reports,
  // and the client-message path still catches every click on the picture.
  await player
    .observe('focused', (value) => {
      if (value === true && !mainWindowUiOpen) raisePlayerOverlay({ focus: false })
    })
    // A build that does not know the property must not take the rest of the
    // observers down with it — every one of those the UI genuinely needs.
    .catch(() => {})
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
    // Reaching here at all means mpv's window took the input, which means it
    // was activated and is now over the controls. Clicking the picture is how
    // someone comes back to a film they left running behind another window, so
    // this is exactly when the controls have to be pulled back over it —
    // keyboard included, since from here on the keys are the player's.
    if (!mainWindowUiOpen) raisePlayerOverlay()
    switch (String(args[0] ?? '')) {
      case 'r3-stop': {
        // Escape leaves fullscreen before it closes anything, so one press is
        // never both. The overlay's own Escape follows the same rule via
        // window:exit-fullscreen — this is the copy for when mpv's window has
        // the focus instead, and the two must not disagree or Escape would mean
        // different things depending on which window happened to be focused.
        const mainWindow = getActiveWindow()
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen()) {
          mainWindow.setFullScreen(false)
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
        if (!forwardInput('toggle-fullscreen')) toggleMainWindowFullscreen()
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
 * its video window asynchronously — on load, and again on things like a
 * resolution change — and a window that has just been created arrives in front
 * of everything else. A single raise is a race this side loses often enough to
 * leave someone staring at a video with no controls and no obvious way out.
 * Re-raising a window that is already on top costs nothing.
 *
 * Each retry decides for itself whether to fire, at the moment it fires rather
 * than when it was scheduled — 1.8 seconds is long enough for someone to start
 * a title and switch to another application before the train has finished, and
 * a train that had made its mind up at t=0 would spend the rest of its run
 * pulling a window that spans the whole content area back over whatever they
 * moved on to, keyboard and all. Skipping costs nothing either: the stack is
 * re-established the moment the app or the video is next activated.
 */
const RAISE_RETRIES_MS = [0, 150, 400, 900, 1800]
let raiseTimers: NodeJS.Timeout[] = []

function raiseOverlaySoon(): void {
  clearRaiseTimers()
  raiseTimers = RAISE_RETRIES_MS.map((delay) =>
    setTimeout(() => {
      if (!appHasFocus() || mainWindowUiOpen) return
      raisePlayerOverlay()
    }, delay)
  )
}

function clearRaiseTimers(): void {
  for (const timer of raiseTimers) clearTimeout(timer)
  raiseTimers = []
}

// ---------------------------------------------------------------------------
// Window stacking
// ---------------------------------------------------------------------------
//
// Three unrelated top-level windows have to end up in one order — main window,
// then mpv's video window, then the controls — and only the last two are the
// player's. Neither of them is always-on-top while the film is windowed, so
// that order is not held by the OS: it is re-established here, at each of the
// moments that can disturb it.
//
// The alternative, and what this replaced, was --ontop plus a topmost overlay.
// That never needed re-stacking, and never allowed another application to be
// put over a playing video either.

/**
 * Whether main-window UI has deliberately been brought to the front over the
 * video (the watch-party panel). While it is, nothing here may put the video
 * back on top — that is the one state where the app is meant to win.
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

/**
 * The rectangle to hand mpv, in the units mpv actually reads.
 *
 * Electron speaks DIPs — density-independent pixels, which are physical pixels
 * divided by the display's scale factor — and every bounds API on this side,
 * getContentBounds included, returns them. mpv's `geometry` is raw physical
 * pixels: it measures against GetMonitorInfo and hands the result straight to
 * SetWindowPos, and an explicit WxH is taken literally with no DPI factor
 * applied to it (the scale factor in mpv's win_state.c only ever touches the
 * size mpv derives from the video itself, which an explicit geometry replaces).
 *
 * So on any display not at 100% the two disagree, and the window comes out
 * short by exactly the scale factor — a quarter of the width missing at 125%,
 * a third at 150% — with the app showing through the strip left over. At 100%
 * they happen to agree, which is what makes this the kind of bug that ships.
 *
 * dipToScreenRect converts against the display nearest the window, so a desk
 * with different scaling on each monitor gets the right factor rather than the
 * primary's.
 */
function playerBoundsFor(mainWindow: BrowserWindow): Electron.Rectangle {
  const bounds = mainWindow.getContentBounds()
  return process.platform === 'win32' ? screen.dipToScreenRect(mainWindow, bounds) : bounds
}

function mainWindowIsFullScreen(): boolean {
  const win = getActiveWindow()
  return Boolean(win && !win.isDestroyed() && win.isFullScreen())
}

/** Whether one of the app's own windows currently has focus. False while
 *  another application has it, and also while mpv's window does — mpv is a
 *  separate process, so it is not one of ours. */
function appHasFocus(): boolean {
  return BrowserWindow.getFocusedWindow() !== null
}

/**
 * Bumped by every decision about which band the player's windows belong in.
 *
 * The half of such a decision that has to wait for mpv finishes asynchronously,
 * and by then the answer can be out of date — entering fullscreen and opening
 * the party panel a moment later, or stopping playback mid-transition. A
 * completion that is no longer the current generation has been overtaken and
 * must apply nothing: without this, the fullscreen transition's tail re-raises
 * the controls over the panel that deliberately displaced them, and a stopped
 * session leaves `topmost` set for the NEXT one to open into — a transparent
 * window over every other application until its own policy lands.
 *
 * Cheaper than serializing the transitions, and better behaved: the newest
 * decision applies immediately rather than queueing behind a stale one.
 */
let topmostGeneration = 0

/**
 * Puts both player windows in or out of the always-on-top band.
 *
 * Fullscreen is the only caller that passes true: a fullscreen film should have
 * nothing at all over it, including the taskbar, which an ordinary window does
 * not reliably clear. Windowed playback stays out of the band so other
 * applications can be put over the picture.
 *
 * The two calls are ordered, not fired together. Both entering and leaving the
 * band move a window to the front of the one it lands in, so whichever is
 * applied last ends up over the other — and that has to be the controls, or
 * they are buried under the video the moment fullscreen changes.
 */
function setPlayerTopmost(on: boolean): void {
  const generation = ++topmostGeneration
  void player
    .setOntop(on)
    .catch(() => {})
    .finally(() => {
      if (generation !== topmostGeneration) return
      setPlayerOverlayTopmost(on)
      raiseOverlaySoon()
    })
}

/**
 * Hands mpv's own fullscreen mode the job of covering the screen.
 *
 * Separate from setPlayerTopmost, which decides a BAND, and separate from the
 * geometry tracking, which decides a RECTANGLE. This decides neither: it tells
 * mpv that the film is fullscreen and lets mpv work the rectangle out, which is
 * the only way to get the whole monitor rather than a fitted approximation of
 * it (see MpvPlayer.setFullscreen for what mpv does to a rectangle it is
 * merely asked for).
 *
 * Driven by the main window's fullscreen state and nothing else — in
 * particular NOT by an open panel. A panel displaces the player within the
 * z-order; it does not stop the film being fullscreen, and dropping mpv out of
 * fullscreen to show one would resize the video underneath it for no reason
 * the person could see.
 */
function setPlayerFullscreen(on: boolean): void {
  void player
    .setFullscreen(on)
    .catch(() => {})
    .finally(() => {
      // Entering and leaving move mpv's window, and a moved window arrives in
      // front of the controls that are supposed to be over it.
      if (!mainWindowUiOpen) raiseOverlaySoon()
    })
}

/**
 * Puts the video back over the app, and the controls back over the video.
 *
 * Called when the app is activated. Activating any of the app's windows raises
 * it — and, for the controls, the main window that owns them — above mpv's
 * window, which would leave the film hidden behind the UI it is playing in.
 *
 * Deliberately does not take focus. The main window is activated by clicking
 * its title bar as often as by anything else, and stealing the keyboard
 * mid-drag is a worse bug than the one this fixes; the controls take focus when
 * the person actually reaches for them (set-interactive, below).
 */
function restackPlayer(): void {
  if (!player.running) return
  // An open panel inverts the order this restores, so it gets the inverted one
  // applied rather than nothing at all. Bailing out — which is what this did —
  // left the front to whichever window happened to arrive last, and mpv's video
  // window arrives after the raise that was supposed to beat it:
  // startPlayerSession raises the main window when `file-loaded` resolves, and
  // that window does not exist until `vo-configured`. Every route into here is
  // one of the moments that disturbs the stack — the window being created, the
  // app being activated, a restore from minimised — which makes this the place
  // the panel gets its front back too, and the reason the panel could otherwise
  // end up under a film it started with no way back to it.
  if (mainWindowUiOpen) {
    raiseMainWindowOverPlayer({ focus: false })
    return
  }
  void player
    .raiseWindow()
    .catch(() => {})
    // Re-checked rather than assumed: the panel can be opened while this is
    // still waiting on mpv, and the tail of a restack must not walk over a
    // decision made after it started.
    .finally(() => {
      if (mainWindowUiOpen) return
      raisePlayerOverlay({ focus: false })
    })
}

/**
 * The opposite of restackPlayer: hands the front to the main window, so
 * main-window UI reached from the player can actually be seen and clicked.
 *
 * Both player windows leave the always-on-top band first, and the main window
 * is raised only once mpv confirms it has — a fullscreen film's window is
 * topmost, which no amount of raising an ordinary window can get past, and
 * leaving the band puts it at the front of the ordinary one, so raising the
 * main window before that lands just buries the panel again.
 *
 * The caller owns mainWindowUiOpen; this only moves windows.
 *
 * `focus: false` for the calls that merely re-establish the order rather than
 * decide it — restackPlayer's, which is reached from the app being activated
 * and from mpv re-creating its window. That path is deliberately focus-free
 * (see its own comment) and must stay so; taking the keyboard there would
 * steal it mid-drag, or off the controls on a mid-playback re-configure.
 */
function raiseMainWindowOverPlayer({ focus = true }: { focus?: boolean } = {}): void {
  // A band decision like any other, so it takes a generation — both to overtake
  // a fullscreen transition still waiting on mpv, and so its own tail is
  // dropped if something newer (the panel closing again) has since decided
  // otherwise. Raising the main window after that would bury the film the
  // person has just gone back to.
  const generation = ++topmostGeneration
  setPlayerOverlayTopmost(false)
  void player
    .setOntop(false)
    .catch(() => {})
    .finally(() => {
      if (generation !== topmostGeneration) return
      const mainWindow = getActiveWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.moveTop()
        if (focus) mainWindow.focus()
      }
    })
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
      bounds: playerBoundsFor(mainWindow),
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

  openPlayerOverlay(mainWindow, { onFocus: () => restackPlayer() })

  // Where mpv's window goes, and whether it is fullscreen, settled BEFORE the
  // file loads — because `loadfile` is what CREATES that window, and a window
  // created in the wrong state is on screen in the wrong state for as long as
  // the load takes, which on a cold stream is seconds rather than frames.
  //
  // Needed at all because the mpv PROCESS outlives a session and keeps its
  // properties, while the window tracking that would correct them is detached
  // between sessions. Stopping a fullscreen title and leaving fullscreen before
  // starting the next one is the case that bites: nothing has told mpv, so the
  // next title opens screen-sized over a windowed app for the whole load.
  //
  // Ordered against the rectangle rather than fired alongside it, because
  // geometry writes are dropped while mpv is fullscreen (see setBounds):
  // leaving has to come before the rectangle and entering after it, or the
  // window is placed from the last session's bounds. Both are no-ops when the
  // state already agrees, which is what a mid-session title change gets — so
  // swapping films inside a fullscreen party does not flash out and back.
  const fullScreen = mainWindow.isFullScreen()
  if (!fullScreen) await player.setFullscreen(false)
  await player.setBounds(playerBoundsFor(mainWindow))
  if (fullScreen) await player.setFullscreen(true)

  await player.loadFile(url, {
    startSeconds: options.startSeconds,
    audioLanguage: options.audioLanguage,
    subtitleLanguage: options.subtitleLanguage,
    videoScaling: options.videoScaling
  })

  // Re-asserted per title rather than set once. mpv keeps these properties
  // across `loadfile`, so this is usually a no-op — but the process can be
  // respawned mid-run (a crash, or playback stopped and restarted after a
  // shutdown), and a respawned mpv is back at its defaults while the overlay
  // would still be showing the mode that was chosen before.
  await applyFitMode(fitMode).catch(() => {})

  // Re-asserted per title for the same reason as the fit mode, and read from
  // the window because a session can start into an already-fullscreen app —
  // "playback is starting" says nothing about which band these two windows
  // belong in, only the main window's state does.
  //
  // Except when main-window UI is up, which a title change does NOT close: a
  // host playing something from the watch-party queue goes through here with
  // the panel still open and still rendering (PartyPanel's Play button ->
  // requestPartyPlay, which starts the title and leaves the panel alone). The
  // new film taking the front there would make the panel vanish mid-party, for
  // no reason the person could see. It gets the front back the moment the panel
  // is closed — see party-panel-closed.
  if (mainWindowUiOpen) raiseMainWindowOverPlayer()
  else setPlayerTopmost(mainWindow.isFullScreen())

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
  // mainWindowUiOpen is deliberately NOT cleared here: a stop is not a close.
  // See its own comment — the main window reports the panel itself now.
  //
  // Closing is the newest word on which band anything belongs in.
  // closePlayerOverlay clears the policy, and this stops a transition still in
  // flight from writing it back — which would hand the NEXT session an overlay
  // that opens topmost, over every other application, until its own policy
  // lands after loadFile.
  topmostGeneration++
  pendingPatch = {}
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  sessionSnapshot = null
  closePlayerOverlay()
  await player.stopFile()
  // The film is gone, so nothing is fullscreen. Cleared here as well as applied
  // at the next session's start, because between the two there is no window
  // tracking at all: leaving fullscreen while stopped goes unheard, and the flag
  // would still be set when the next title's window is created. Written after
  // stopFile rather than before it so mpv drops the state on a window that has
  // already gone, instead of animating out of fullscreen on the way out.
  await player.setFullscreen(false)
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
  const sync = (): void => {
    if (mainWindow.isDestroyed()) return
    void player.setBounds(playerBoundsFor(mainWindow))
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
    // A window that was minimised comes back wherever the OS puts it, which is
    // not necessarily over the app it belongs to.
    restackPlayer()
  }
  // Only fullscreen puts the player in the always-on-top band, so every
  // transition either way has to be told — and the state is read from the
  // window rather than inferred from which event fired, so the two can never
  // disagree.
  //
  // An open panel outranks fullscreen: going fullscreen while main-window UI is
  // up must not put the film in a band the panel cannot be seen from. Closing
  // the panel re-reads the window and lands in the right band then.
  //
  // Returning early rather than passing false is the point, not just tidier
  // phrasing. Both windows are already out of the band while the panel is up —
  // raiseMainWindowOverPlayer takes them out before it raises the main window,
  // and nothing puts them back while the flag is set — so the call would decide
  // nothing. It would still take a generation, though, and that raise is
  // typically still waiting on mpv's socket when a fullscreen transition fires.
  // The new generation drops its tail, and the tail is the half that raises the
  // main window. Nothing on this path replaces it: setPlayerTopmost's own tail
  // only sets the overlay band and calls raiseOverlaySoon, which bails while the
  // panel is up. The panel would just stay behind the video, with no further
  // event coming to correct it.
  //
  // A real decision still overtakes the raise, which is the behaviour this has
  // to keep: closing the panel clears the flag before re-reading the window, and
  // stopping the session bumps the generation itself.
  const applyTopmost = (): void => {
    if (mainWindowUiOpen) return
    setPlayerTopmost(mainWindow.isFullScreen())
  }
  // Unconditional, unlike applyTopmost: mpv's own fullscreen is a property of
  // the film, not of the z-order, so an open panel does not get a say.
  const applyFullscreen = (): void => {
    if (mainWindow.isDestroyed()) return
    setPlayerFullscreen(mainWindow.isFullScreen())
  }
  const restack = (): void => restackPlayer()

  mainWindow.on('resize', sync)
  mainWindow.on('move', sync)
  // Registered BEFORE the geometry re-syncs, and that order is load-bearing in
  // both directions. Entering, it means the geometry writes the transition
  // provokes are already being suppressed by the time they arrive, instead of
  // one of them landing as mpv's restore rectangle. Leaving, it means mpv is
  // out of fullscreen before the re-sync tries to place its window, so the
  // write is not dropped and the video does not stay screen-sized over a
  // windowed app.
  mainWindow.on('enter-full-screen', applyFullscreen)
  mainWindow.on('leave-full-screen', applyFullscreen)
  mainWindow.on('enter-full-screen', syncSettled)
  mainWindow.on('leave-full-screen', syncSettled)
  mainWindow.on('enter-full-screen', applyTopmost)
  mainWindow.on('leave-full-screen', applyTopmost)
  mainWindow.on('focus', restack)
  mainWindow.on('minimize', hide)
  mainWindow.on('restore', show)
  mainWindow.on('hide', hide)
  mainWindow.on('show', show)

  untrackWindow = () => {
    mainWindow.off('resize', sync)
    mainWindow.off('move', sync)
    mainWindow.off('enter-full-screen', applyFullscreen)
    mainWindow.off('leave-full-screen', applyFullscreen)
    mainWindow.off('enter-full-screen', syncSettled)
    mainWindow.off('leave-full-screen', syncSettled)
    mainWindow.off('enter-full-screen', applyTopmost)
    mainWindow.off('leave-full-screen', applyTopmost)
    mainWindow.off('focus', restack)
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
    case 'set-fit-mode':
      // Normalized rather than trusted: this is the IPC boundary, and an
      // unrecognized mode has an obvious safe reading (the default) instead of
      // being worth failing the call over.
      await applyFitMode(normalizeVideoFit(command.mode))
      return
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
    setOverlayInteractive(Boolean(event.interactive))
    // Showing the controls is the one moment it is definitely worth making sure
    // they are actually on top — mpv can re-create its video window (a
    // resolution change, for one) and silently win the z-order again.
    //
    // Only while the app is the window being used, though. The controls also
    // reveal on a mouse move across whatever part of the video another
    // application is not currently covering, and raising a window that spans
    // the whole content area over that application — never mind taking the
    // keyboard off it — would be the topmost behaviour this change exists to
    // remove. Left alone, the controls simply appear in the part of the picture
    // that is actually visible, which is the part being pointed at.
    if (event.interactive && appHasFocus() && !mainWindowUiOpen) raisePlayerOverlay()
    return
  }
  // The party panel renders in the MAIN window, which the video window covers:
  // mpv's window is sized over the app's content area and sits above it, so
  // anything the main window draws during playback is invisible and
  // unclickable. Opening the panel therefore has to hand the front to the app,
  // and closing it gives the front back. This applies to any main-window UI
  // reached from the player, not just this panel.
  //
  // mainWindowUiOpen holds that decision against everything else in this file
  // that raises the video: while the panel is up, the app is meant to win.
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
    clearRaiseTimers()
    raiseMainWindowOverPlayer()
    // The report stops here. The command falls through to the main window,
    // which still has to actually open the panel the overlay asked for.
    if (event.type === 'party-panel-open') return
  }
  if (event.type === 'party-panel-closed') {
    mainWindowUiOpen = false
    // Fullscreen gets the front back by returning to the topmost band. Windowed
    // playback has no band to return to, so the video has to be raised over the
    // main window explicitly — nothing else will move it now that the panel
    // deliberately put that window in front.
    const fullScreen = mainWindowIsFullScreen()
    setPlayerTopmost(fullScreen)
    if (!fullScreen) restackPlayer()
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
  // Read from this module, not from mpv: applyFitMode is the only writer of
  // either underlying property, so this value is the authority on which of the
  // three modes the pair currently represents.
  patch.fitMode = fitMode
  patch.tracks = await readTracks()
  return patch
}
