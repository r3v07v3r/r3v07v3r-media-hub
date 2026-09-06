import { CompactAIAssistant } from './CompactAIAssistant'
import { FeaturedHero } from './FeaturedHero/FeaturedHero'
import { ContinueWatchingPanel } from './ContinueWatchingPanel'
import { RecommendationCarousel } from './RecommendationCarousel'
import { PerformanceWidget } from './PerformanceWidget'
import { MoodBrowser } from './MoodBrowser'
import { useRestoreBrowsingOrigin } from '@renderer/lib/mediaHub/useRestoreBrowsingOrigin'
import { usePlannedTitles } from '@renderer/lib/mediaHub/usePlannedTitles'
import { activeHomeRailTab } from '@renderer/lib/mediaHub/homeRailTab'
import styles from './HomeDashboard.module.css'

// The reference composition this screen was built against puts the
// telemetry cluster back in its own small column to the right
// of the AI Picks row — not the top bar (see topbar/TopUtilityBar.tsx,
// which no longer renders a system-monitor widget).
export function HomeDashboard() {
  // Home is a common origin for opening a title's detail page too
  // (Continue Watching, AI Picks, Planned, mood results) — restores
  // scroll/rail/focus the same way CategoryPage does.
  //
  // Planned is fetched HERE rather than inside the carousel so the row
  // and the restore gate below read one answer, not two fetches of it.
  // Home's other content is app-level state that is simply there, which
  // is why CategoryPage can pass a bare `true` and this cannot.
  const planned = usePlannedTitles()
  // "Ready" has to mean the rail the origin was captured FROM is on
  // screen. Restoration runs two frames after mount and consumes the
  // pending origin whether or not it found anything, so returning to the
  // Planned tab while its titles were still in flight lost the position
  // outright.
  //
  // Two escapes from the wait, because useCatalogByIds keeps `loading` up
  // for a fetch that never answers and this must not become a way for
  // Home to stop restoring at all: a tab other than Planned has nothing
  // to wait for, and a Planned rail that already has rows on screen —
  // last answer's, held deliberately while a refetch is out — is a rail
  // the restore can land in.
  useRestoreBrowsingOrigin(
    activeHomeRailTab() !== 'planned' || !planned.loading || planned.items.length > 0
  )

  return (
    <div className={styles.dashboard}>
      <CompactAIAssistant />
      <FeaturedHero />
      <ContinueWatchingPanel />
      {/* Both rails — Planned and Recommended — live in this one cell,
          as tabs. Home is clipped to no scroll (see HomeDashboard.module.css) and
          row 2 is the only place either can go; two sections claiming
          `grid-area: picks` drew one heading over the other. */}
      <RecommendationCarousel planned={planned} />
      <PerformanceWidget />
      <MoodBrowser />
    </div>
  )
}
