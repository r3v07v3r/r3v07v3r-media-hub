// The renderer's entry point when it is built to run outside Electron
// (vite.web.config.ts swaps this in for main.tsx). Its one job is to make
// `window.api` exist BEFORE the app's first render — which is when the hooks
// decide, once, whether there is a backend at all — and then hand over to the
// ordinary entry, untouched.
//
// Whether there IS a backend is the backend's to say: it marks the page as it
// serves it (see BRIDGE_MARKER_META). The same files from any other server
// carry no mark, install nothing, and are the backend-less build the app has
// always degraded to gracefully. One bundle, both lives.

import { createApi } from '../../../preload/api'
import { BRIDGE_MARKER_NAME, type BridgeScope } from '@shared/bridgeProtocol'
import { PLAYER_OVERLAY_ROUTE } from '@shared/media-hub/playerRoute'
import { showBridgeStatus } from './bridgeStatus'
import { createWebSocketTransport } from './transport'

if (document.querySelector(`meta[name="${BRIDGE_MARKER_NAME}"]`)) {
  // The same test main.tsx uses to decide it is the player overlay: the two
  // "windows" are one bundle at two hashes, here as on the desktop.
  const scope: BridgeScope = window.location.hash.startsWith(PLAYER_OVERLAY_ROUTE)
    ? 'overlay'
    : 'main'
  const transport = createWebSocketTransport(scope)
  // Assigned, not exposed through a bridge: there is no second world to keep
  // it from here, and the transport itself stays in this closure either way.
  ;(window as { api: unknown }).api = createApi(transport)
  showBridgeStatus(transport)
}

void import('../main')
