// The transparent control surface layered over mpv's native video window.
//
// WHY A SECOND WINDOW. mpv draws into its own borderless window sitting over
// the app's content area (see mpv.ts's WINDOWING note on why it is not embedded
// with --wid). Nothing can be painted over that from inside the main window, so
// the controls live here: a frameless, transparent BrowserWindow whose bounds
// track the main window's, and which is re-raised over the video whenever
// anything could have reordered the two.
//
// ORDINARY WINDOWS, NOT TOPMOST. Neither this window nor mpv's is always-on-top
// while the film is windowed, so other applications can be put over the picture
// — with the flag on, nothing could ever cover a playing video. The z-order is
// held together instead by raising both windows when the app is activated
// (playerBridge's restackPlayer). Fullscreen is the exception and does set the
// flag on both, since a fullscreen film should have nothing over it, the
// taskbar included; setPlayerOverlayTopmost is how that arrives here.
//
// OWNERSHIP. This window is NOT created with `parent`, and that is load-bearing
// rather than an oversight. Win32 keeps an owner and its owned windows together
// as one block in the z-order: nothing belonging to another process can be
// placed between them. mpv's video window has to go exactly there — above the
// main window, below these controls — so ownership makes the required order
// unreachable. Measured on Windows 11 against the real mpv build: with this
// window owned, raising it carried the main window up with it and left the film
// underneath both (audio playing, app UI on screen, no picture); unowned, the
// same raise lands controls > video > app every time. What ownership was doing
// for us — going away when the app is minimised, dying with the main window —
// is done explicitly at the bottom of openPlayerOverlay instead.
//
// RAISING IS A BAND TOGGLE, NOT moveTop(). See raisePlayerOverlay.
//
// The obvious worry with that shape is cost: Electron transparent overlays on
// Windows have a reputation for flicker and for throttling whatever renders
// beneath them. Measured before committing to this design, against 4K60 at
// 40Mbps: 0 dropped and 0 delayed frames with the overlay present versus
// absent. Two rules keep it that way, and both matter:
//   1. The window is created once per playback session and never shown/hidden
//      to reveal or conceal controls — toggling visibility on a transparent
//      window is what actually produces the documented flicker. The controls
//      fade via CSS inside a window that stays up.
//   2. While the controls are hidden it is click-through
//      (setIgnoreMouseEvents with forward: true), so mouse events reach mpv
//      while this side still receives the mousemove that reveals them.

import { BrowserWindow, screen, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import path from 'node:path'

import { APP_SCHEME } from '../appProtocol'
import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import { PLAYER_OVERLAY_ROUTE } from '../../shared/media-hub/playerRoute'
import { isAllowedExternalUrl } from './security'

let overlayWindow: BrowserWindow | null = null
let parentWindow: BrowserWindow | null = null
let detachBoundsListeners: (() => void) | null = null
let inputReady = false
// The two halves of the first show. The renderer is ready well before the film
// is — see revealPlayerOverlay for why they are not the same moment.
let readyToShow = false
let revealRequested = false
// Whether the controls are currently meant to be in the always-on-top band.
// Only fullscreen turns this on — see this file's header.
let topmost = false

// The level asked for when this window enters the always-on-top band.
//
// It does NOT outrank mpv, whatever the name suggests: Win32 has one topmost
// band, and measured against the real player, raising mpv while both windows
// were in it put mpv in front regardless of this level. Within the band the
// most recently raised window wins, full stop — which is why every raise
// re-asserts rather than assuming (see raisePlayerOverlay), and why the caller
// owns the ordering of the two (see playerBridge's setPlayerTopmost).
const OVERLAY_TOPMOST_LEVEL = 'screen-saver' as const

export function getPlayerOverlay(): BrowserWindow | null {
  return overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow : null
}

/** Pushes an event to the overlay window. No-ops when no player session is
 *  open, which is the normal state — callers do not need to check first. */
export function sendToPlayerOverlay(channel: string, payload?: unknown): void {
  const win = getPlayerOverlay()
  if (win) win.webContents.send(channel, payload)
}

/**
 * Whether the overlay is actually listening for forwarded input.
 *
 * Deliberately not derived from the window existing. The window is created
 * before its renderer has loaded, let alone mounted its subscription, and
 * webContents.send into a window with no listener is dropped without a word —
 * so treating existence as readiness would silently swallow the very inputs
 * mpv's bindings exist to keep working when the overlay is in trouble.
 *
 * The renderer reports this itself (PlayerUiEvent's set-input-ready). What the
 * renderer cannot report is its own death, so this is also cleared when the
 * window goes or its process does.
 *
 * One case remains outside this: a renderer that is alive and subscribed but
 * wedged. The message is queued rather than dropped there, so it arrives late
 * instead of never, and no readiness flag can tell the difference in advance.
 */
export function isOverlayInputReady(): boolean {
  return inputReady && getPlayerOverlay() !== null
}

export function setOverlayInputReady(ready: boolean): void {
  inputReady = ready
}

/**
 * The overlay covers the main window's *content* area, not its outer frame —
 * the same rectangle mpv's window is positioned to, so the controls line up
 * with the picture they belong to. The two differ by the frame and menu-bar
 * allowance, which is exactly what getContentBounds accounts for and getBounds
 * does not.
 */
function contentBoundsOf(win: BrowserWindow): Electron.Rectangle {
  return win.getContentBounds()
}

/**
 * The main window's content rectangle is the right overlay rectangle while it
 * is windowed.  It is not a dependable source during a Windows fullscreen
 * transition, though: for a few frames Chromium can still report the old
 * content rect even after the window has entered fullscreen.  That left the
 * controls in the old, centred window while mpv had correctly filled the
 * monitor.
 *
 * In fullscreen the monitor is the contract, not a transient content rect.
 * Electron's display bounds are in the same DIP coordinate system that
 * BrowserWindow#setBounds accepts, including on mixed-DPI desks.
 */
function overlayBoundsFor(win: BrowserWindow): Electron.Rectangle {
  if (!win.isFullScreen()) return contentBoundsOf(win)
  return screen.getDisplayMatching(win.getBounds()).bounds
}

function mirrorBounds(): void {
  const win = getPlayerOverlay()
  if (!win || !parentWindow || parentWindow.isDestroyed()) return
  const bounds = overlayBoundsFor(parentWindow)
  const current = win.getBounds()
  // Cheap equality check first: these listeners fire continuously during a
  // drag or resize, and setBounds on a transparent window is not free.
  if (
    current.x === bounds.x &&
    current.y === bounds.y &&
    current.width === bounds.width &&
    current.height === bounds.height
  ) {
    return
  }
  win.setBounds(bounds)
}

export interface OpenPlayerOverlayOptions {
  /** Called when this window is activated. Clicking a control activates the
   *  main window with it — they are one owner group — which puts the app back
   *  over mpv's video window, so the caller has to put the video back on top.
   *  Wired at creation so a title change cannot stack up a second copy. */
  onFocus?: () => void
}

/**
 * Creates the overlay for a playback session. Idempotent — calling it while an
 * overlay is already open just re-mirrors the bounds, so a title change inside
 * an open player does not tear the window down and rebuild it.
 */
export function openPlayerOverlay(
  parent: BrowserWindow,
  options: OpenPlayerOverlayOptions = {}
): BrowserWindow {
  const existing = getPlayerOverlay()
  if (existing) {
    mirrorBounds()
    return existing
  }

  parentWindow = parent
  // Nothing in this window is listening yet, and will not be until its renderer
  // has mounted and said so.
  inputReady = false
  readyToShow = false
  revealRequested = false
  const win = new BrowserWindow({
    ...overlayBoundsFor(parent),
    // Deliberately NOT `parent` — see this file's OWNERSHIP note. An owned
    // window cannot have mpv's window placed between it and its owner, which
    // is the one arrangement this whole file exists to produce.
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    // Nothing should flash before React has painted the (fully transparent)
    // control layer.
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      // Identical posture to the main window (see src/main/index.ts) — a
      // second renderer is a second attack surface, not an exemption.
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // Chromium throttles background/occluded renderers. The overlay is by
      // definition never the focused window while someone is watching, and a
      // throttled control surface means a scrub bar that stops updating.
      backgroundThrottling: false
    }
  })
  overlayWindow = win
  // A session can open into an already-fullscreen window, so the band is
  // applied from the standing policy rather than assumed to be the default.
  if (topmost) win.setAlwaysOnTop(true, OVERLAY_TOPMOST_LEVEL)

  // The same navigation and permission guards the main window applies. Without
  // these, this window would be the weakest link of the two.
  win.webContents.setWindowOpenHandler((details) => {
    if (isAllowedExternalUrl(details.url)) shell.openExternal(details.url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const isOwnOrigin =
      is.dev && process.env['ELECTRON_RENDERER_URL']
        ? url.startsWith(process.env['ELECTRON_RENDERER_URL'])
        : url.startsWith(`${APP_SCHEME}://`)
    if (!isOwnOrigin) event.preventDefault()
  })
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  )

  // Starts click-through: on open the controls are visible, but the renderer
  // sets its real interactivity as soon as it mounts, and starting permissive
  // would swallow the first click over the video.
  win.setIgnoreMouseEvents(true, { forward: true })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/${PLAYER_OVERLAY_ROUTE}`)
  } else {
    win.loadURL(`${APP_SCHEME}://index.html/${PLAYER_OVERLAY_ROUTE}`)
  }

  win.once('ready-to-show', () => {
    readyToShow = true
    // Not shown here. The renderer is usually ready long before there is a film
    // to be shown over — see revealPlayerOverlay. This only picks up a reveal
    // that was asked for before the window could honour it.
    showOverlayWindow()
  })

  if (options.onFocus) win.on('focus', options.onFocus)

  const onBoundsChange = (): void => mirrorBounds()
  parent.on('resize', onBoundsChange)
  parent.on('move', onBoundsChange)
  // Fullscreen is real OS-level BrowserWindow fullscreen (see appIpc.ts).
  // Neither mpv's window nor this one is a child of the main window, so both
  // have to be told; playerBridge.ts's trackWindow does the same for mpv.
  parent.on('enter-full-screen', onBoundsChange)
  parent.on('leave-full-screen', onBoundsChange)
  // The bounds are wrong for a frame or two immediately after a fullscreen
  // transition on Windows; re-mirroring once the transition has settled is
  // cheaper than trying to predict the final rect.
  const onFullscreenSettled = (): void => {
    setTimeout(mirrorBounds, 120)
  }
  parent.on('enter-full-screen', onFullscreenSettled)
  parent.on('leave-full-screen', onFullscreenSettled)

  // Both of these came free with ownership and have to be done by hand now (see
  // this file's OWNERSHIP note). Neither is optional: a transparent window left
  // up after the app is minimised is an invisible sheet over whatever the
  // person went back to, and one that outlives its main window is a window with
  // no owner, no taskbar entry and no way to close it.
  const hideWithApp = (): void => {
    if (!win.isDestroyed() && win.isVisible()) win.hide()
  }
  // Also performs a reveal the load finished while the app was minimised — see
  // showOverlayWindow, which declines to show into an app nobody is looking at.
  const showWithApp = (): void => {
    if (win.isDestroyed()) return
    showOverlayWindow()
    mirrorBounds()
  }
  const closeWithApp = (): void => closePlayerOverlay()
  parent.on('minimize', hideWithApp)
  parent.on('restore', showWithApp)
  parent.on('hide', hideWithApp)
  parent.on('show', showWithApp)
  parent.on('closed', closeWithApp)

  detachBoundsListeners = () => {
    // The parent is already gone on the close path, and `off` on a destroyed
    // BrowserWindow throws.
    if (parent.isDestroyed()) return
    parent.off('resize', onBoundsChange)
    parent.off('move', onBoundsChange)
    parent.off('enter-full-screen', onBoundsChange)
    parent.off('leave-full-screen', onBoundsChange)
    parent.off('enter-full-screen', onFullscreenSettled)
    parent.off('leave-full-screen', onFullscreenSettled)
    parent.off('minimize', hideWithApp)
    parent.off('restore', showWithApp)
    parent.off('hide', hideWithApp)
    parent.off('show', showWithApp)
    parent.off('closed', closeWithApp)
  }

  // A dead renderer cannot retract its own readiness, so this is the one report
  // that has to come from outside it. Without it the flag would stay true after
  // a crash and forwarded input would go on being swallowed by a window that
  // can no longer act on anything.
  win.webContents.on('render-process-gone', () => {
    inputReady = false
  })

  win.on('closed', () => {
    detachBoundsListeners?.()
    detachBoundsListeners = null
    overlayWindow = null
    parentWindow = null
    inputReady = false
    readyToShow = false
    revealRequested = false
  })

  return win
}

/**
 * Puts the controls on screen for the first time this session.
 *
 * Separate from the window being ready, and that gap is the point. The overlay
 * is created before `loadfile` — it has to be, because its renderer needs the
 * load to boot in — and on a cold stream that load is seconds, not frames.
 * Showing on `ready-to-show` therefore parked a scrub bar and a play button
 * over the media detail page for the whole wait, with no film behind them:
 * reported as "the bar shows with the movie description page behind it".
 *
 * One caller, and deliberately so: startPlayerSession, once `loadfile` has
 * resolved. Nothing else knows there is a film to be shown over — a raise does
 * not, since the renderer provokes one the moment it mounts. Idempotent, and it
 * survives a window that is not ready yet (`ready-to-show` picks the request
 * up).
 *
 * NOT the toggle this file's header rules out: that rule is about revealing and
 * concealing the CONTROLS, which still fade with CSS inside a window that stays
 * up for the rest of the session.
 */
export function revealPlayerOverlay(): void {
  revealRequested = true
  showOverlayWindow()
}

/**
 * The single place this window is put on screen, so the two things that must
 * accompany every show cannot be forgotten at one of the call sites.
 *
 * NOT WHILE THE APP IS AWAY. The reveal is driven by the title finishing its
 * load, which says nothing about whether anyone is looking: minimise the app
 * during a cold stream and the load goes on finishing without it. Showing then
 * would put a transparent, mouse-capturing sheet over whatever the person
 * switched to, with no further minimise event coming to take it away again.
 * The pending request survives instead, and `showWithApp` performs it on
 * restore.
 *
 * showInactive, not show: the raise that follows decides the z-order, and
 * taking the foreground here would activate this window before the film it is
 * supposed to be sitting over has been put in front of the app.
 */
function showOverlayWindow(): void {
  const win = getPlayerOverlay()
  if (!win || !readyToShow || !revealRequested || win.isVisible()) return
  if (!parentWindow || parentWindow.isDestroyed()) return
  if (parentWindow.isMinimized() || !parentWindow.isVisible()) return
  win.showInactive()
  // The renderer cannot see this for itself — see playerControlsShown.
  sendToPlayerOverlay(MEDIA_HUB_CHANNELS.playerControlsShown)
}

/**
 * Moves the controls into or out of the always-on-top band, and remembers
 * which, so a window created later opens into the same policy.
 *
 * The caller owns the ordering against mpv: whichever of the two windows
 * changes band last ends up in front of the other, and that has to be the
 * controls (playerBridge's setPlayerTopmost does this).
 */
export function setPlayerOverlayTopmost(on: boolean): void {
  topmost = on
  const win = getPlayerOverlay()
  if (!win) return
  if (on) win.setAlwaysOnTop(true, OVERLAY_TOPMOST_LEVEL)
  else win.setAlwaysOnTop(false)
}

/**
 * Raises the controls above mpv's video window, and by default gives them
 * keyboard focus.
 *
 * Ordering matters and is not obvious: this window is created BEFORE mpv has a
 * video window (mpv makes one on loadfile, not on launch), and a newly created
 * window arrives in front, so the controls start out buried under the video —
 * invisible, unclickable, and with no route for Escape. Symptom: a playing
 * title with no way to pause or exit it.
 *
 * So this must be called AFTER the file is loaded, not when the window is made.
 *
 * `focus: false` is for the raises that are only tidying the z-order — the app
 * being activated, mpv reporting that its own window was — where taking the
 * keyboard would interrupt whatever the person is actually doing in the window
 * they just clicked.
 */
export function raisePlayerOverlay({ focus = true }: { focus?: boolean } = {}): void {
  const win = getPlayerOverlay()
  if (!win) return
  // Deliberately does NOT reveal. A raise can be provoked while the title is
  // still loading — the renderer reports set-interactive the moment it mounts,
  // and playerBridge raises on that — and revealing there would put the bar
  // back over the detail page for the rest of the load. Raising a window that
  // is not on screen yet is harmless; the reveal has one caller, and it is the
  // one that knows the film has loaded.
  //
  // THE RAISE IS A BAND TOGGLE. Enter the always-on-top band and leave it
  // again; leaving lands the window at the FRONT of the ordinary band, so the
  // pair is a raise rather than a no-op.
  //
  // This is not a roundabout moveTop() — it is the only thing that works.
  // moveTop() is SetWindowPos(HWND_TOP), which Windows declines to honour
  // against a window owned by ANOTHER PROCESS unless the caller is the
  // foreground application, and mpv's video window is exactly such a window.
  // Measured with mpv raised and the real bundled build: moveTop() left the
  // controls underneath it every single time, and so did focus(); entering and
  // leaving the band put them in front every single time.
  //
  // It is also exactly what mpv does to raise ITSELF (MpvPlayer.raiseWindow).
  // That was the whole asymmetry behind "the film is playing and the control
  // bar has gone": both windows were competing for the front, mpv with a lever
  // that always works and this side with one that mostly does not, so mpv won
  // every contest.
  //
  // Both calls run in the same tick with no repaint between them, so the window
  // is never seen in the wrong band.
  win.setAlwaysOnTop(true, OVERLAY_TOPMOST_LEVEL)
  // Within the band the most recently raised window wins — 'screen-saver' is
  // not a level that outranks mpv's topmost on Win32, measured, whatever the
  // name suggests. So a fullscreen film stays in the band and only re-asserts,
  // while windowed playback drops back out of it.
  if (!topmost) win.setAlwaysOnTop(false)
  // Without focus the keydown handler never runs, which is what leaves Escape
  // and space dead while a title is playing.
  if (focus) win.focus()
}

/**
 * Click-through control. `interactive: false` forwards mouse events to whatever
 * is underneath (mpv) while still delivering mousemove to this window, which is
 * what lets moving the mouse over the video reveal the controls without the
 * overlay stealing clicks meant for play/pause.
 */
export function setOverlayInteractive(interactive: boolean): void {
  const win = getPlayerOverlay()
  if (!win) return
  if (interactive) win.setIgnoreMouseEvents(false)
  else win.setIgnoreMouseEvents(true, { forward: true })
}

export function closePlayerOverlay(): void {
  const win = getPlayerOverlay()
  detachBoundsListeners?.()
  detachBoundsListeners = null
  overlayWindow = null
  parentWindow = null
  inputReady = false
  readyToShow = false
  revealRequested = false
  // The next session decides its own band from the state the app is in then,
  // not from how the last one ended.
  topmost = false
  if (win) win.destroy()
}
