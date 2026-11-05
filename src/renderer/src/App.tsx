import { lazy, Suspense } from 'react'
import { ErrorBoundary } from '@renderer/components/errors/ErrorBoundary'
import { PLAYER_OVERLAY_ROUTE } from '@shared/media-hub/playerRoute'

// Both halves are loaded on demand, so each window parses only what it shows.
// The player-overlay window used to run the whole app bundle (every page,
// the catalog, the control centre) just to draw a transparent controls bar.
const MainApp = lazy(() => import('./MainApp'))
const PlayerOverlayWindow = lazy(() => import('@renderer/routes/PlayerOverlayWindow'))

export default function App() {
  // The player-overlay window loads this same bundle, at the same origin, with
  // only the hash differing — that is deliberate, because it is what lets that
  // window pass the identical assertTrustedSender check (the comparison strips
  // the hash). But it must NOT mount the app: AppShell + AppStateProvider would
  // run a second copy of the catalog, its fetches and its party subscriptions
  // in a window that only ever shows playback controls. Branching before the
  // router, rather than adding a <Route>, is what keeps that from happening.
  if (window.location.hash.startsWith(PLAYER_OVERLAY_ROUTE)) {
    return (
      <ErrorBoundary label="the player controls">
        {/* Null fallback: the overlay is transparent over mpv, and anything
            painted while its chunk loads would flash over the picture. */}
        <Suspense fallback={null}>
          <PlayerOverlayWindow />
        </Suspense>
      </ErrorBoundary>
    )
  }

  return (
    <ErrorBoundary label="the app">
      <Suspense fallback={null}>
        <MainApp />
      </Suspense>
    </ErrorBoundary>
  )
}
