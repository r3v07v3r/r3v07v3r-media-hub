// The transparent control surface layered over mpv's native video window.
//
// WHY A SECOND WINDOW. mpv is embedded into the main window via --wid, and on
// Windows a native child window always composites above Chromium's web
// content. There is no per-region transparency that would let the existing
// React player UI draw on top of it inside one window. So the controls move to
// their own frameless, transparent, always-on-top BrowserWindow whose bounds
// track the main window's.
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

import { BrowserWindow, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import path from 'node:path'

import { APP_SCHEME } from '../appProtocol'
import { PLAYER_OVERLAY_ROUTE } from '../../shared/media-hub/playerRoute'
import { isAllowedExternalUrl } from './security'

let overlayWindow: BrowserWindow | null = null
let parentWindow: BrowserWindow | null = null
let detachBoundsListeners: (() => void) | null = null

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
 * The overlay covers the main window's *content* area, not its outer frame:
 * mpv is embedded into the same client area via --wid, so anything else leaves
 * the controls offset from the picture they belong to. Measured during the
 * embedding spike, the two differ by the frame and menu-bar allowance, which
 * is exactly what getContentBounds accounts for and getBounds does not.
 */
function contentBoundsOf(win: BrowserWindow): Electron.Rectangle {
  return win.getContentBounds()
}

function mirrorBounds(): void {
  const win = getPlayerOverlay()
  if (!win || !parentWindow || parentWindow.isDestroyed()) return
  const bounds = contentBoundsOf(parentWindow)
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
  const win = new BrowserWindow({
    ...contentBoundsOf(parent),
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
    alwaysOnTop: true,
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
    if (!win.isDestroyed()) win.show()
  })

  const onBoundsChange = (): void => mirrorBounds()
  parent.on('resize', onBoundsChange)
  parent.on('move', onBoundsChange)
  // Fullscreen is real OS-level BrowserWindow fullscreen (see appIpc.ts), and
  // mpv follows it automatically as a child of the main window. The overlay is
  // a separate top-level window, so it does not — it has to be told.
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

  detachBoundsListeners = () => {
    parent.off('resize', onBoundsChange)
    parent.off('move', onBoundsChange)
    parent.off('enter-full-screen', onBoundsChange)
    parent.off('leave-full-screen', onBoundsChange)
    parent.off('enter-full-screen', onFullscreenSettled)
    parent.off('leave-full-screen', onFullscreenSettled)
  }

  win.on('closed', () => {
    detachBoundsListeners?.()
    detachBoundsListeners = null
    overlayWindow = null
    parentWindow = null
  })

  return win
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
  if (win) win.destroy()
}
