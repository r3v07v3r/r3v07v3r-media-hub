// The transparent control surface layered over the embedded video.
//
// WHY A SECOND WINDOW. The video is a native child window INSIDE the main
// window (mpv via --wid — see mpv.ts's WINDOWING note and mpvEmbed.ts), and a
// child window composites over every pixel of web content beneath it: nothing
// the main window's DOM draws can ever appear over the film. So the controls
// live here — a frameless, transparent BrowserWindow whose bounds track the
// main window's content area — because a separate window is the only surface
// that CAN sit above the video.
//
// OWNERSHIP. Created with `parent`, and that is now load-bearing in the
// opposite direction it used to be. Win32 keeps an owner and its owned
// windows together as one z-order block, owned windows always in front — and
// with the video inside the owner, that block IS the required order: main
// window (video child within it) below, controls above, held by the OS with
// no re-raising, no retry trains, and no always-on-top band. (The old
// floating-window design had to keep this window unowned precisely because
// mpv's foreign top-level had to fit between owner and owned — see git
// history around commit 59bbe14 for the measurements.)
//
// INPUT. This window takes EVERY mouse event for the whole session — it is
// never click-through. The click-through dance (setIgnoreMouseEvents with
// forward: true while the controls were hidden) existed to let clicks reach
// mpv's own window, whose MBTN_LEFT bindings did click-to-pause; the embedded
// child processes no mouse input at all (measured — see mpv.ts's
// bindSafetyKeys), so there is nothing below that wants a click any more and
// letting one fall through would only land it on the main window's invisible
// DOM. The renderer's surface handlers do click-to-pause and
// double-click-fullscreen whether or not the controls are showing, so a
// stationary click on a faded-out player still pauses — the exact behaviour
// the old mpv-side binding provided. (AppShell's data-playback-covered guard
// stays as defence in depth for the moments this window does not exist yet.)
//
// The obvious worry with a transparent overlay is cost: Electron transparent
// overlays on Windows have a reputation for flicker and for throttling
// whatever renders beneath them. Measured before committing to this design,
// against 4K60 at 40Mbps: 0 dropped and 0 delayed frames with the overlay
// present versus absent. One rule keeps it that way: the window is created
// once per playback session and never shown/hidden to reveal or conceal
// CONTROLS — toggling visibility on a transparent window is what actually
// produces the documented flicker. The controls fade via CSS inside a window
// that stays up. (Hiding for the length of the watch-party hub, or with the
// app minimised, is a different, rare event and fine.)

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
// Whether this window is deliberately off screen so main-window UI (the
// watch-party hub) can be used — an owned window cannot be dropped BELOW its
// owner, so getting the overlay out of the hub's way means hiding it. Guarded
// in showOverlayWindow so a reveal or app-restore during an open hub stays
// hidden until the hub closes.
let hiddenForMainUi = false

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

/**
 * Creates the overlay for a playback session. Idempotent — calling it while an
 * overlay is already open just re-mirrors the bounds, so a title change inside
 * an open player does not tear the window down and rebuild it.
 */
export function openPlayerOverlay(parent: BrowserWindow): BrowserWindow {
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
  hiddenForMainUi = false
  const win = new BrowserWindow({
    ...overlayBoundsFor(parent),
    // Owned by the main window — see this file's OWNERSHIP note: with the
    // video embedded inside the owner, the owner group's fixed order (owned
    // window always above its owner) is exactly controls > video > app.
    parent,
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

  const onBoundsChange = (): void => mirrorBounds()
  parent.on('resize', onBoundsChange)
  parent.on('move', onBoundsChange)
  // Fullscreen is real OS-level BrowserWindow fullscreen (see appIpc.ts).
  // Ownership holds the z-order, not the rectangle — an owned window does not
  // track its owner's bounds, so the mirroring stays.
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

  // Ownership makes most of this the OS's job — owned windows hide with a
  // minimised owner and Electron closes children with their parent — but the
  // show half is still ours: a reveal requested while the app was minimised
  // (a cold stream finishing its load in the background) is performed on
  // restore by showOverlayWindow, which declines to show into an app nobody
  // is looking at. The hide half stays as belt and braces; hiding a hidden
  // window is free.
  const hideWithApp = (): void => {
    if (!win.isDestroyed() && win.isVisible()) win.hide()
  }
  const showWithApp = (): void => {
    if (win.isDestroyed()) return
    showOverlayWindow()
    mirrorBounds()
  }
  parent.on('minimize', hideWithApp)
  parent.on('restore', showWithApp)
  parent.on('hide', hideWithApp)
  parent.on('show', showWithApp)

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
    hiddenForMainUi = false
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
  if (hiddenForMainUi) return
  if (!parentWindow || parentWindow.isDestroyed()) return
  if (parentWindow.isMinimized() || !parentWindow.isVisible()) return
  win.showInactive()
  // The renderer cannot see this for itself — see playerControlsShown.
  sendToPlayerOverlay(MEDIA_HUB_CHANNELS.playerControlsShown)
}

/**
 * Takes the controls off screen while main-window UI (the watch-party hub) is
 * in use, and puts them back after. An owned window cannot be lowered below
 * its owner, so "get out of the hub's way" can only mean hide — the paired
 * reveal goes through showOverlayWindow, so it keeps every guard (renderer
 * ready, reveal requested, app visible) rather than force-showing.
 */
export function hidePlayerOverlayForMainUi(): void {
  hiddenForMainUi = true
  const win = getPlayerOverlay()
  if (win && win.isVisible()) win.hide()
}

export function showPlayerOverlayAfterMainUi(): void {
  hiddenForMainUi = false
  showOverlayWindow()
}

/**
 * Gives the controls keyboard focus — reached when someone starts interacting
 * with the player surface (set-interactive). Ownership already holds this
 * window above the main window, so there is nothing left to raise; without
 * focus the keydown handler never runs, which is what used to leave Escape
 * and space dead while a title was playing.
 */
export function focusPlayerOverlay(): void {
  const win = getPlayerOverlay()
  if (!win) return
  win.focus()
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
  hiddenForMainUi = false
  if (win) win.destroy()
}
