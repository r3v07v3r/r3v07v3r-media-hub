// The embedded video's window plumbing: keeps mpv's --wid child sized to the
// main window's client area and stacked ABOVE Chromium's compositor child.
//
// Why the stacking move exists: a plain --wid embed composites mpv BEHIND the
// "Intermediate D3D Window" that carries the web content, which is the failure
// that un-embedded mpv in commit 0ae7dfb (audio, correct clock, no picture).
// Raising mpv's child above that sibling is the missing move, proven by the
// Phase-0 spike's OS-level screenshots (embedSpike.ts) — never by mpv property
// reads.
//
// Everything here is idempotent and cheap, and syncEmbeddedVideo() is
// deliberately re-run on every event that can disturb the arrangement:
//   - vo-configured: mpv creates a NEW child per loadfile (and can re-create
//     it mid-playback), so the child is re-discovered every call, never cached.
//   - resize / fullscreen settle: the child does not follow the parent's size
//     on its own in --wid mode; GetClientRect is physical pixels, so there is
//     no DIP conversion anywhere.
//   - re-asserting the z-order every call is the standing defense against a
//     GPU-process restart recreating the D3D window on top of the video.
//
// The child is also stripped of WS_DISABLED (mpv's embed etiquette flag).
// Input-wise it makes no difference — mpv processes no mouse input in --wid
// mode regardless, measured in the spike — but an enabled child keeps
// hit-testing conventional for whatever sits above it.

import type { BrowserWindow } from 'electron'

import {
  findChildByPid,
  getClientSize,
  hwndOf,
  isWindowAlive,
  raiseToTopOfSiblings,
  removeWindowStyle,
  setChildRect,
  setShown,
  addWindowStyle,
  WS_CLIPSIBLINGS,
  WS_DISABLED,
  win32Available
} from './win32'

let parentHwnd: bigint | null = null
let mpvPid = 0
// Whether the video is deliberately hidden behind main-window UI (the watch
// party hub). Remembered so a sync arriving mid-panel (a resize, a
// vo-configured from a title change) does not undo the hide.
let videoHidden = false

export function embedAvailable(): boolean {
  return win32Available()
}

/** Remembers where the video embeds. Called once per session start, before
 *  mpv spawns — the HWND is what --wid gets. */
export function attachEmbedTarget(mainWindow: BrowserWindow): bigint {
  parentHwnd = hwndOf(mainWindow)
  return parentHwnd
}

/** Which process's child window to look for. The mpv process outlives titles,
 *  so this is set once per spawn, not per load. */
export function setEmbeddedPlayerPid(pid: number): void {
  mpvPid = pid
}

export function detachEmbedTarget(): void {
  parentHwnd = null
  mpvPid = 0
  videoHidden = false
}

/** Whether the running player is embedded in THIS window. --wid is a
 *  spawn-time option, so a player attached to a recreated window's dead HWND
 *  has to be respawned, not reused. */
export function embedTargetMatches(mainWindow: BrowserWindow): boolean {
  return parentHwnd !== null && parentHwnd === hwndOf(mainWindow)
}

function findVideoChild(): bigint | null {
  if (!parentHwnd || !mpvPid || !isWindowAlive(parentHwnd)) return null
  return findChildByPid(parentHwnd, mpvPid)
}

/**
 * Puts the embedded video where it belongs: filling the parent's client area,
 * at the top of the sibling z-order. Safe to call at any time; no-ops when
 * there is no child (idle player, stopped title, non-Windows).
 */
export function syncEmbeddedVideo(): void {
  const child = findVideoChild()
  if (!child || !parentHwnd) return
  addWindowStyle(child, WS_CLIPSIBLINGS)
  removeWindowStyle(child, WS_DISABLED)
  const size = getClientSize(parentHwnd)
  if (size && size.width > 0 && size.height > 0) {
    setChildRect(child, 0, 0, size.width, size.height)
  }
  raiseToTopOfSiblings(child)
  if (videoHidden) setShown(child, false)
}

/**
 * Hides/shows the video child without unloading the title — how main-window
 * UI (the watch party hub) stays visible and clickable while a film keeps
 * playing underneath: the child always covers the whole client area, so DOM
 * can never be composited over it, only revealed by removing it.
 */
export function setEmbeddedVideoHidden(hidden: boolean): void {
  videoHidden = hidden
  const child = findVideoChild()
  if (!child) return
  setShown(child, !hidden)
  if (!hidden) syncEmbeddedVideo()
}
