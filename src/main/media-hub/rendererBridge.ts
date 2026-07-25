// New (not a direct port) — the original app kept a single module-level
// `activeWindow`/`sendToRenderer` pair directly in main.cjs, since
// everything lived in one file. This project's port splits that file into
// many modules (settingsStore, watchParty, autoUpdate, playbackSession,
// ...) that all still need to push events to the renderer, so the same
// module-level window handle is pulled out into its own tiny module they
// can all import without reaching back into src/main/index.ts.

import type { BrowserWindow } from 'electron'

let activeWindow: BrowserWindow | null = null

/** Called once from src/main/index.ts after the media-hub main window is created (and again on macOS re-activation). */
export function setActiveWindow(win: BrowserWindow | null): void {
  activeWindow = win
}

export function getActiveWindow(): BrowserWindow | null {
  return activeWindow
}

/** Pushes an unsolicited event to the renderer (e.g. torbox:unauthorized, party:event, update:status). No-ops if there's no live window. */
export function sendToRenderer(channel: string, payload?: unknown): void {
  if (activeWindow && !activeWindow.isDestroyed()) {
    activeWindow.webContents.send(channel, payload)
  }
}
