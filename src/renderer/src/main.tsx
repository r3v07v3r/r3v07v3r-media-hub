import './styles/global.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { PLAYER_OVERLAY_ROUTE } from '@shared/media-hub/playerRoute'
import { installRendererDiagnostics } from './lib/feedback/diagnostics'

// Marked on <html> before React's first paint, not from inside a component:
// mpv renders *underneath* the overlay window, so a single frame painted with
// the app's opaque body background is a black flash over the picture. See
// global.css's [data-player-overlay] rules, which also disable the body::after
// grain overlay — it covers the viewport at z-index 999 and would otherwise
// tint the film.
const isPlayerOverlay = window.location.hash.startsWith(PLAYER_OVERLAY_ROUTE)
if (isPlayerOverlay) {
  document.documentElement.setAttribute('data-player-overlay', 'true')
}

// Errors, repeated clicks and back-and-forth for tester reports; see
// lib/feedback/diagnostics.ts. Before the first render, so an error in it
// is caught too.
installRendererDiagnostics({ watchClicks: !isPlayerOverlay })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
