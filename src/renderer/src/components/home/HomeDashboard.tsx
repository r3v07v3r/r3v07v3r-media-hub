import { CompactAIAssistant } from './CompactAIAssistant'
import { FeaturedHero } from './FeaturedHero/FeaturedHero'
import { ContinueWatchingPanel } from './ContinueWatchingPanel'
import { RecommendationCarousel } from './RecommendationCarousel'
import { PerformanceWidget } from './PerformanceWidget'
import { MoodBrowser } from './MoodBrowser'
import styles from './HomeDashboard.module.css'

// Reference composition target (public/reference/dashboard-reference.png)
// puts the telemetry cluster back in its own small column to the right
// of the AI Picks row — not the top bar (see topbar/TopUtilityBar.tsx,
// which no longer renders a system-monitor widget).
export function HomeDashboard() {
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
