// Entry point for the phone/TV app. Its one job before anything else runs
// is the same as src/renderer/src/web/main.ts's: make window.api exist, if
// a backend is actually serving this page, before App's first render — see
// that file's header comment for why the bridge marker is what decides
// this rather than the app guessing. Reuses the same transport and status
// banner the desktop's web build uses (imported, not copied), so the wire
// protocol and reconnect behaviour can never drift between the two.
import './theme.css'
import './app.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createApi } from '../preload/api'
import { BRIDGE_MARKER_NAME } from '@shared/bridgeProtocol'
import { showBridgeStatus } from '../renderer/src/web/bridgeStatus'
import { createWebSocketTransport } from '../renderer/src/web/transport'
import App from './App'

if (document.querySelector(`meta[name="${BRIDGE_MARKER_NAME}"]`)) {
  // This app has no player-overlay window — there is exactly one "window"
  // here — so the scope is always 'main'.
  const transport = createWebSocketTransport('main')
  ;(window as { api: unknown }).api = createApi(transport)
  showBridgeStatus(transport)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
