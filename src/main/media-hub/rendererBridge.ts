// New (not a direct port) — the original app kept a single module-level
// `activeWindow`/`sendToRenderer` pair directly in main.cjs, since
// everything lived in one file. This project's port splits that file into
// many modules (settingsStore, watchParty, autoUpdate, playbackSession,
// ...) that all still need to push events to the renderer, so the same
// module-level window handle is pulled out into its own tiny module they
// can all import without reaching back into src/main/index.ts.

import type { BrowserWindow } from 'electron'

import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import type { LibraryChangeScope, LibraryChangedEvent } from '../../shared/media-hub/types'

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

/** How long writes are gathered before one library:changed goes out. A job
 *  that lands rows in several passes should cost the renderer one refetch. */
const LIBRARY_CHANGE_COALESCE_MS = 300
let pendingLibraryChange: { scopes: Set<LibraryChangeScope>; sources: Set<string> } | null = null
let pendingLibraryChangeTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Tells the renderer that main changed the library behind its back.
 *
 * The app's rule is that whoever writes, refetches: a renderer call site
 * that marks something watched refreshes the hooks that show it. That rule
 * has no answer for writes the renderer never asked for — the hourly
 * watchlist pull tracking a title, a MAL reconcile marking a season, the
 * anime id repair moving history under a merged show, the household title
 * sync growing the index — which used to stay invisible until something
 * unrelated happened to refetch. This is the one notification all of them
 * send, so AppStateContext can refresh in one place rather than each
 * writer having to know which hooks exist.
 *
 * Coalesced, because a job writes in passes and the renderer should pay
 * for one refetch, not one per pass.
 */
export function notifyLibraryChanged(source: string, ...scopes: LibraryChangeScope[]): void {
  if (!scopes.length) return
  if (!pendingLibraryChange) pendingLibraryChange = { scopes: new Set(), sources: new Set() }
  for (const scope of scopes) pendingLibraryChange.scopes.add(scope)
  pendingLibraryChange.sources.add(source)
  if (pendingLibraryChangeTimer) return
  pendingLibraryChangeTimer = setTimeout(() => {
    pendingLibraryChangeTimer = null
    const pending = pendingLibraryChange
    pendingLibraryChange = null
    if (!pending) return
    const event: LibraryChangedEvent = {
      scopes: [...pending.scopes],
      sources: [...pending.sources]
    }
    sendToRenderer(MEDIA_HUB_CHANNELS.libraryChanged, event)
  }, LIBRARY_CHANGE_COALESCE_MS)
}
