import { useState } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { useSpatialNav } from './lib/spatialNav'
import NavChrome from './components/NavChrome'
import Home from './screens/Home'
import Browse from './screens/Browse'
import Search from './screens/Search'
import Title from './screens/Title'
import Settings from './screens/Settings'
import NotConnected from './screens/NotConnected'

function Shell() {
  useSpatialNav()
  return (
    <div className="app-shell">
      <main className="app-content">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/browse/:kind" element={<Browse />} />
          <Route path="/search" element={<Search />} />
          <Route path="/title/:kind/:id" element={<Title />} />
          <Route path="/settings" element={<Settings />} />
          {/* Where a scanned pairing code lands: Settings, with the link filled in. */}
          <Route path="/pair" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <NavChrome />
    </div>
  )
}

export default function App() {
  // A lazy initializer rather than a plain read during render: window.api
  // is installed once, before this module ever mounts (see main.tsx), so
  // whether a backend exists at all needs checking exactly once, not on
  // every render — same pattern as this app's own data hooks (see
  // src/renderer/src/lib/mediaHub/hooks.ts's identical `useState(() => ...)`).
  const [connected] = useState(() => Boolean(window.api?.mediaHub))
  if (!connected) return <NotConnected />
  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  )
}
