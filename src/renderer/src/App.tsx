import type { ReactNode } from 'react'
import { HashRouter, Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom'
import { AppStateProvider } from '@renderer/context/AppStateContext'
import { OverlayProvider } from '@renderer/context/OverlayContext'
import { AppShell } from '@renderer/components/layout/AppShell'
import { ErrorBoundary } from '@renderer/components/errors/ErrorBoundary'
import { HomeDashboard } from '@renderer/components/home/HomeDashboard'
import MoviesPage from '@renderer/routes/MoviesPage'
import SeriesPage from '@renderer/routes/SeriesPage'
import AnimePage from '@renderer/routes/AnimePage'
import { MediaDetailPage } from '@renderer/routes/MediaDetailPage'
import MyStuffPage from '@renderer/routes/MyStuffPage'
import CalendarPage from '@renderer/routes/CalendarPage'
import SettingsPage from '@renderer/routes/SettingsPage'
import MoodExplorePage from '@renderer/routes/MoodExplorePage'
import PersonPage from '@renderer/routes/PersonPage'
import PlayerOverlayWindow from '@renderer/routes/PlayerOverlayWindow'
import { PLAYER_OVERLAY_ROUTE } from '@shared/media-hub/playerRoute'

// Keyed on the pathname so that navigating away from a page that threw
// clears the fallback — without it, one bad title page would leave the error
// screen pinned under the shell for the rest of the session. Inside the
// router by necessity: useLocation only exists below <HashRouter>.
function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation()
  return (
    <ErrorBoundary label="this page" resetKey={location.pathname}>
      {children}
    </ErrorBoundary>
  )
}

function LegacyTvShowDetailRedirect() {
  const { id } = useParams()
  return <Navigate to={`/series/${encodeURIComponent(id ?? '')}`} replace />
}

// HashRouter rather than BrowserRouter — the production build loads
// dist/renderer/index.html directly off disk via file://, which has no
// server to fall back to for a client-side path like /movies, so history-
// API routing would 404 on refresh/deep navigation. Hash routing needs no
// server at all and behaves identically in dev (Vite server) and packaged
// builds.
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
        <PlayerOverlayWindow />
      </ErrorBoundary>
    )
  }

  return (
    <HashRouter>
      {/* Above AppStateProvider on purpose: several of its own handlers
          (startPlayback, party events, profile switching) push toasts
          while they work, so the actions have to already exist. */}
      <OverlayProvider>
        <AppStateProvider>
          <AppShell>
            <RoutedErrorBoundary>
              <Routes>
                <Route path="/" element={<HomeDashboard />} />
                <Route path="/movies" element={<MoviesPage />} />
                <Route path="/movies/:id" element={<MediaDetailPage kind="movie" />} />
                <Route path="/series" element={<SeriesPage />} />
                <Route path="/series/:id" element={<MediaDetailPage kind="series" />} />
                <Route path="/anime" element={<AnimePage />} />
                <Route path="/anime/:id" element={<MediaDetailPage kind="anime" />} />
                {/* /tv-shows was this route's path before the Series category
                  page existed (NAV_ITEMS' 'tv' entry — mockData.ts — now
                  points at /series); redirected rather than removed outright
                  so any existing deep link/bookmark still lands somewhere
                  real instead of 404ing, without adding a second routing
                  pattern (react-router's own <Navigate>, not a new mechanism). */}
                <Route path="/tv-shows" element={<Navigate to="/series" replace />} />
                <Route path="/tv-shows/:id" element={<LegacyTvShowDetailRedirect />} />
                <Route path="/my-stuff" element={<MyStuffPage />} />
                <Route path="/calendar" element={<CalendarPage />} />
                {/* Downloads is gone. What it listed — what this device has
                    cached — is on the control centre's Caching page beside
                    the cache server's own list, because "where is my media"
                    is one question and it had two pages. Redirected rather
                    than 404ing: the path is in people's muscle memory and in
                    any bookmark they made. */}
                <Route path="/downloads" element={<Navigate to="/" replace />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/moods" element={<MoodExplorePage />} />
                {/* A drill-down from a title page, not a nav destination — see
                    PersonPage's own header. */}
                <Route path="/people/:name" element={<PersonPage />} />
                {/* A stale bookmark or malformed external deep link should
                    recover to a usable screen instead of rendering an empty
                    application shell. */}
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </RoutedErrorBoundary>
          </AppShell>
        </AppStateProvider>
      </OverlayProvider>
    </HashRouter>
  )
}
