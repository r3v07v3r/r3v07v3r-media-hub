'use client'

import type { CategoryKind } from '@renderer/lib/mediaHub/categoryFilters'
import { useOllamaAvailable } from '@renderer/lib/mediaHub/useOllamaAvailable'
import { RecommendationActions } from './RecommendationActions'
import styles from './CompactAIAssistant.module.css'

interface CompactAIAssistantProps {
  /** Passed straight through to RecommendationActions — see that
   *  component for why Home omits this (both movie+series buttons) while
   *  a category page passes its own single kind. */
  kinds?: CategoryKind[]
}

/**
 * Two "quick pick" cards — no shared frame around them, no heading. Used
 * to be a 302px animated orb narrating a local model's connection
 * status; that panel took up an entire grid column to say very little
 * (the actual useful part was always just these two buttons), so it's
 * gone. What's left is pure CSS-responsive: the same markup renders as a
 * slim side column on tall desktop windows and a full-width row wherever
 * the dashboard grid collapses to one column (mobile width, or a short
 * window — see CompactAIAssistant.module.css's own media queries, which
 * mirror useDashboardLayoutMode's STACKED_QUERY/COMPACT_QUERY), so there
 * is no JS layout-mode branching left to do here.
 *
 * Drawn only while a local model is actually reachable (useOllamaAvailable):
 * the buttons ask Ollama, and two buttons whose only possible outcome is
 * "couldn't reach the server" are not an offer. The dashboard asks the same
 * question to hand the hero this column — see HomeDashboard.
 */
export function CompactAIAssistant({ kinds }: CompactAIAssistantProps = {}) {
  const available = useOllamaAvailable()
  if (!available) return null
  return (
    <div className={styles.panel} aria-label="Discover something to watch">
      <RecommendationActions kinds={kinds} />
    </div>
  )
}
