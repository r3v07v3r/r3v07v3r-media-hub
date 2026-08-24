// The one place that decides what "fullscreen" means for this app.
//
// Fullscreen is always the MAIN window's, never the calling window's: mpv's
// video window and the player-controls overlay are both sized to the main
// window's content area (see playerWindow.ts), so it is the only window whose
// fullscreen state changes anything on screen. The overlay is even created
// `fullscreenable: false`, so a call aimed at it is dropped outright.
//
// Pulled out of appIpc.ts because there are now three ways in — the overlay's
// button (window:toggle-fullscreen), F11 from any app window (src/main/index.ts)
// and mpv's own window forwarding a double-click or F11 (playerBridge) — and
// they must not each keep their own idea of the current state.

import type { BrowserWindow } from 'electron'
import { getActiveWindow } from './rendererBridge'

// BrowserWindow#setFullScreen starts an asynchronous native transition.  Keep
// the requested state alongside Electron's eventually-consistent query so a
// second press (or Escape) during that transition reverses it rather than
// treating the still-old `isFullScreen()` value as the source of truth.
const requestedFullscreen = new WeakMap<BrowserWindow, boolean>()
const trackedFullscreenWindows = new WeakSet<BrowserWindow>()

function fullscreenTarget(win: BrowserWindow): boolean {
  if (!trackedFullscreenWindows.has(win)) {
    trackedFullscreenWindows.add(win)
    requestedFullscreen.set(win, win.isFullScreen())
    win.on('enter-full-screen', () => requestedFullscreen.set(win, true))
    win.on('leave-full-screen', () => requestedFullscreen.set(win, false))
  }
  return requestedFullscreen.get(win) ?? win.isFullScreen()
}

function liveMainWindow(): BrowserWindow | null {
  const win = getActiveWindow()
  return win && !win.isDestroyed() ? win : null
}

/** The state the main window is heading for — which is the current one whenever
 *  no transition is in flight. `false` when there is no window at all. */
export function mainWindowFullscreenTarget(): boolean {
  const win = liveMainWindow()
  return win ? fullscreenTarget(win) : false
}

/** Returns false when there is no window to apply it to. */
export function setMainWindowFullscreen(fullScreen: boolean): boolean {
  const win = liveMainWindow()
  if (!win) return false
  fullscreenTarget(win)
  requestedFullscreen.set(win, fullScreen)
  win.setFullScreen(fullScreen)
  return true
}

/** The new state, or null when there is no window. Callers report the returned
 *  value rather than re-reading isFullScreen(): on Windows that still answers
 *  with the old one until the enter/leave event arrives, which is what used to
 *  make the controls show the opposite state immediately after every click. */
export function toggleMainWindowFullscreen(): boolean | null {
  const win = liveMainWindow()
  if (!win) return null
  const fullScreen = !fullscreenTarget(win)
  setMainWindowFullscreen(fullScreen)
  return fullScreen
}
