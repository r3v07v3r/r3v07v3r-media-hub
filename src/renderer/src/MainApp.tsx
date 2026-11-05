import { Suspense, useEffect, type ReactNode } from 'react'
import { HashRouter, Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom'
import { AppStateProvider, useAppState } from '@renderer/context/AppStateContext'
import { OverlayProvider } from '@renderer/context/OverlayContext'
import { AppShell } from '@renderer/components/layout/AppShell'
import { ErrorBoundary } from '@renderer/components/errors/ErrorBoundary'
import { HomeDashboard } from '@renderer/components/home/HomeDashboard'
import {
  AnimePage,
  CalendarPage,
  CollectionPage,
  CollectionsPage,
  ForYouPage,
  MediaDetailPage,
  MoodExplorePage,
  MoviesPage,
  MyStuffPage,
  PersonPage,
  prefetchRoutes,
  SeriesPage,
  SettingsPage
} from '@renderer/routes/lazyRoutes'
import { useServiceCatchUp } from '@renderer/hooks/useServiceCatchUp'

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

/**
 * A new page starts at the top.
 *
 * The routed pages share one scroller (AppShell's <main>), and a route
 * change alone leaves its offset where it was — so a title opened from
 * half-way down a library grid landed on its own About panel with the
 * hero scrolled out of sight. The one exception is a return to a page
 * whose position is being put back (useRestoreBrowsingOrigin): that
 * navigation parks a pendingRestore first, and the restore owns the
 * scroller until it has run.
 */
function ScrollToTopOnNavigate() {
  const location = useLocation()
  const { pendingRestore } = useAppState()
  useEffect(() => {
    // Only the route the restore is for. An entry nobody consumed (a page
    // without the restore hook) must not veto every later navigation.
    if (pendingRestore && pendingRestore.route === `${location.pathname}${location.search}`) {
      return
    }
    document.getElementById('main-content')?.scrollTo({ top: 0 })
    // Only a new path is a new page; a changed query string is the same
    // page with different filters, and its own list is what moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])
  return null
}

/** The desktop's catch-up with the tracking services, on open and on focus —
 *  see useServiceCatchUp. */
function ServiceCatchUp() {
  useServiceCatchUp()
  return null
}

/** Every other page's chunk, fetched once the window is idle after first
 *  paint, so the first click on a nav item rarely waits — see lazyRoutes. */
function PrefetchRoutes() {
  useEffect(() => {
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(prefetchRoutes, { timeout: 3000 })
      return () => window.cancelIdleCallback(id)
    }
    const timer = window.setTimeout(prefetchRoutes, 1500)
    return () => window.clearTimeout(timer)
  }, [])
  return null
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
export default function MainApp() {
  return (
    <HashRouter>
      {/* Above AppStateProvider on purpose: several of its own handlers
          (startPlayback, party events, profile switching) push toasts
          while they work, so the actions have to already exist. */}
      <OverlayProvider>
        <AppStateProvider>
          <AppShell>
            <ScrollToTopOnNavigate />
            <ServiceCatchUp />
            <PrefetchRoutes />
            <RoutedErrorBoundary>
              {/* Inside the boundary, so a page chunk that fails to load is
                  reported like any other page error. Null fallback: the
                  shell stays painted and the content area fills a moment
                  later — normally not at all, since the chunk is prefetched. */}
              <Suspense fallback={null}>
                <Routes>
                  <Route path="/" element={<HomeDashboard />} />
                  <Route path="/for-you" element={<ForYouPage />} />
                  <Route path="/movies" element={<MoviesPage />} />
                  <Route path="/movies/:id" element={<MediaDetailPage kind="movie" />} />
                  <Route path="/series" element={<SeriesPage />} />
                  <Route path="/series/:id" element={<MediaDetailPage kind="series" />} />
                  <Route path="/anime" element={<AnimePage />} />
                  <Route path="/anime/:id" element={<MediaDetailPage kind="anime" />} />
                  {/* /tv-shows was this route's path before the Series category
                  page existed (NAV_ITEMS' 'tv' entry — data/constants.ts — now
                  points at /series); redirected rather than removed outright
                  so any existing deep link/bookmark still lands somewhere
                  real instead of 404ing, without adding a second routing
                  pattern (react-router's own <Navigate>, not a new mechanism). */}
                  <Route path="/tv-shows" element={<Navigate to="/series" replace />} />
                  <Route path="/tv-shows/:id" element={<LegacyTvShowDetailRedirect />} />
                  <Route path="/collections" element={<CollectionsPage />} />
                  <Route path="/collections/:id" element={<CollectionPage />} />
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
              </Suspense>
            </RoutedErrorBoundary>
          </AppShell>
        </AppStateProvider>
      </OverlayProvider>
    </HashRouter>
  )
}
