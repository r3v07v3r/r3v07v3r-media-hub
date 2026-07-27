import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AppStateProvider } from '@renderer/context/AppStateContext'
import { AppShell } from '@renderer/components/layout/AppShell'
import { HomeDashboard } from '@renderer/components/home/HomeDashboard'
import MoviesPage from '@renderer/routes/MoviesPage'
import SeriesPage from '@renderer/routes/SeriesPage'
import AnimePage from '@renderer/routes/AnimePage'
import MyStuffPage from '@renderer/routes/MyStuffPage'
import DownloadsPage from '@renderer/routes/DownloadsPage'
import SettingsPage from '@renderer/routes/SettingsPage'
import { ReferenceOverlay } from '@renderer/components/debug/ReferenceOverlay'

// HashRouter rather than BrowserRouter — the production build loads
// dist/renderer/index.html directly off disk via file://, which has no
// server to fall back to for a client-side path like /movies, so history-
// API routing would 404 on refresh/deep navigation. Hash routing needs no
// server at all and behaves identically in dev (Vite server) and packaged
// builds.
export default function App() {
  return (
    <HashRouter>
      <AppStateProvider>
        <AppShell>
          <Routes>
            <Route path="/" element={<HomeDashboard />} />
            <Route path="/movies" element={<MoviesPage />} />
            <Route path="/series" element={<SeriesPage />} />
            <Route path="/anime" element={<AnimePage />} />
            {/* /tv-shows was this route's path before the Series category
                page existed (NAV_ITEMS' 'tv' entry — mockData.ts — now
                points at /series); redirected rather than removed outright
                so any existing deep link/bookmark still lands somewhere
                real instead of 404ing, without adding a second routing
                pattern (react-router's own <Navigate>, not a new mechanism). */}
            <Route path="/tv-shows" element={<Navigate to="/series" replace />} />
            <Route path="/my-stuff" element={<MyStuffPage />} />
            <Route path="/downloads" element={<DownloadsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </AppShell>
        {/* Dev/QA-only pixel-alignment tool (spec: F8 toggle, F9/F10/F11
            opacity presets) — renders null unless toggled on, so it's safe
            to always mount. */}
        <ReferenceOverlay />
      </AppStateProvider>
    </HashRouter>
  )
}
