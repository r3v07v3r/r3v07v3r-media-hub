import { CompactAIAssistant } from './CompactAIAssistant'
import { FeaturedHero } from './FeaturedHero/FeaturedHero'
import { ContinueWatchingPanel } from './ContinueWatchingPanel'
import { RecommendationCarousel } from './RecommendationCarousel'
import { PerformanceWidget } from './PerformanceWidget'
import { MoodBrowser } from './MoodBrowser'
import { useRestoreBrowsingOrigin } from '@renderer/lib/mediaHub/useRestoreBrowsingOrigin'
import styles from './HomeDashboard.module.css'

// The reference composition this screen was built against puts the
// telemetry cluster back in its own small column to the right
// of the AI Picks row — not the top bar (see topbar/TopUtilityBar.tsx,
// which no longer renders a system-monitor widget).
export function HomeDashboard() {
  // Home is a common origin for opening a title's detail page too
  // (Continue Watching, AI Picks, mood results) — restores scroll/rail/
  // focus the same way CategoryPage does. Home's own content (catalog,
  // recommendations) is already app-level/global state, same reasoning
  // as CategoryPage's `true` here.
  useRestoreBrowsingOrigin(true)

  return (
    <div className={styles.dashboard}>
      <CompactAIAssistant />
      <FeaturedHero />
      <ContinueWatchingPanel />
      <RecommendationCarousel />
      <PerformanceWidget />
      <MoodBrowser />
    </div>
  )
}
