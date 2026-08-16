// Registers every media-hub backend IPC handler. This is the equivalent of
// r3v07v3r-media-hub's src/main.cjs, which registered every `handle(...)`
// call inline, top-to-bottom, in one file — that file has been split into
// one module per domain (see src/main/media-hub/), and this is where they
// all get wired together, mirroring how this project's existing
// registerSettingsIpc()/registerTelemetryIpc()/registerHttpProxyIpc() are
// wired from src/main/index.ts.
//
// Registration order doesn't matter functionally (ipcMain.handle just adds
// a listener per channel; nothing here is invoked until the renderer
// actually calls it, which is always well after app.whenReady() has
// finished setting up the database — see index.ts), so the order below
// just follows the domain grouping used elsewhere in this port.

import { registerAniskipIpc } from '../media-hub/aniskip'
import { registerAppIpc } from '../media-hub/appIpc'
import { registerAutoUpdateIpc } from '../media-hub/autoUpdate'
import { registerCatalogIpc } from '../media-hub/catalog'
import { registerDownloadGuardIpc } from '../media-hub/downloadGuard'
import { registerMalIpc } from '../media-hub/malSync'
import { registerNetworkIpc } from '../media-hub/network'
import { registerOmdbIpc } from '../media-hub/omdb'
import { registerPlaybackIpc, subtitleCacheDir } from '../media-hub/playbackSession'
import { registerPlayerIpc } from '../media-hub/playerBridge'
import { registerProfilesIpc } from '../media-hub/profiles'
import { registerSubtitlesIpc } from '../media-hub/subtitlesService'
import { registerTorBoxIpc } from '../media-hub/torbox'
import { registerTrackingIpc } from '../media-hub/tracking'
import { registerWatchPartyIpc } from '../media-hub/watchParty'
import { registerFriendsIpc, restoreFriendsGroup } from '../media-hub/friends'

export function registerMediaHubIpc(): void {
  registerAppIpc()
  registerAutoUpdateIpc()
  registerTorBoxIpc()
  registerCatalogIpc()
  registerTrackingIpc()
  registerMalIpc()
  registerSubtitlesIpc()
  registerPlaybackIpc()
  // Passed as a getter rather than a value: subtitleCacheDir() reads
  // app.getPath('userData'), which is only valid once the app is ready, and it
  // is the sole directory add-subtitle-file is allowed to load from.
  registerPlayerIpc({ subtitleCacheDir })
  registerWatchPartyIpc()
  registerFriendsIpc()
  // A saved group reconnects on its own — a friends group is meant to be
  // always-on, so it must not require anyone to open a panel first.
  restoreFriendsGroup()
  registerProfilesIpc()
  registerNetworkIpc()
  registerAniskipIpc()
  registerOmdbIpc()
  registerDownloadGuardIpc()
}
