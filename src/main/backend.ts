// The part of starting and stopping this app that is about SERVICES rather
// than windows: the IPC handlers, the database, and the teardown that leaves
// both in a fit state. Pulled out of index.ts so that the desktop app and the
// headless backend (src/headless/main.ts — the same service layer with no
// Electron around it) run one list each way, not two that can drift.
//
// Nothing here may assume a BrowserWindow exists.

import { app } from 'electron'
import { join } from 'path'
import { registerTelemetryIpc } from './ipc/telemetry'
import { registerSettingsIpc } from './ipc/settings'
import { registerHttpProxyIpc } from './ipc/httpProxy'
import { registerMediaHubIpc } from './ipc/mediaHub'
import { createDatabase } from './media-hub/database'
import { activeProfileId } from './media-hub/profiles'
import { ensureSetupCompleteDecided } from './media-hub/settingsStore'
import { getDatabase, setDatabase } from './media-hub/dbState'
import { closeParty } from './media-hub/watchParty'
import { stopPlayback } from './media-hub/playbackSession'
import { flushPlaybackPosition, shutdownPlayer } from './media-hub/playerBridge'
import { shutdownScheduler } from './media-hub/taskScheduler'
import { stopBackgroundJobs } from './media-hub/backgroundJobs'

/** Registers every IPC handler and opens the database. Background jobs are
 *  NOT started here — the caller starts them once its own startup is done. */
export function startBackend(): void {
  registerTelemetryIpc()
  registerSettingsIpc()
  registerHttpProxyIpc()

  // media-hub's own SQLite store (tracked items/watch history/catalog
  // cache) — must exist before registerMediaHubIpc()'s handlers can ever
  // be invoked, though since ipcMain.handle registration itself is
  // synchronous and handlers only actually run once the renderer calls
  // them (well after this whole block completes), the ordering here is
  // for clarity more than strict necessity.
  // Resolved BEFORE the database opens, and seeded here if this is a first
  // launch: the connection is scoped to a profile from the moment it opens,
  // and the profile-scoping migration attributes every row that predates
  // profiles to whichever one is active now — which, on any install that has
  // never switched, is the only one there has ever been.
  // BEFORE activeProfileId(): that call seeds the default "Profile 1" on a
  // fresh launch, and the setupComplete decision uses existing profiles as
  // evidence of a pre-existing install — decided any later, every fresh
  // install would look pre-existing and the welcome flow would never show.
  ensureSetupCompleteDecided()
  setDatabase(createDatabase(join(app.getPath('userData'), 'media-hub.sqlite'), activeProfileId()))
  registerMediaHubIpc()
}

// media-hub cleanup: stop any in-flight playback (closes StreamCache +
// kills a running ffmpeg transcoder), leave/close any active Watch Party,
// and close the SQLite handle. Ported from the original app's `before-quit`
// handler. deleteCache=true here (unlike an ordinary close mid-session,
// which leaves the cache for a likely near-term resume — see
// playbackSession.ts's stopPlayback): there's no future session left to
// resume into once the app has actually quit.
export function stopBackend(): void {
  // First, so nothing new is dispatched while everything below is being
  // torn down — a queued catalog crawl reaching for the database this
  // handler is about to close is exactly the kind of shutdown-order race
  // the scheduler makes it possible to rule out in one place.
  shutdownScheduler()
  stopBackgroundJobs()
  // The bookmark first, while the session that describes it still exists:
  // stopPlayback below clears that session, and the overlay's own saves
  // never get a turn on the way out — see playerBridge.flushPlaybackPosition.
  flushPlaybackPosition()
  stopPlayback(true).catch(() => {})
  // mpv is a child process that outlives any single title deliberately (see
  // playerBridge.ts) — quitting the app is the one point it must actually be
  // torn down, or it survives as an orphan holding the window handle it was
  // embedded into.
  shutdownPlayer().catch(() => {})
  closeParty()
  try {
    getDatabase().close()
  } catch {
    // best-effort close only — if the DB was never initialized (e.g. quit
    // during startup before app.whenReady() finished), there's nothing to
    // close.
  }
}
