'use client'

import type { CategoryKind } from '@renderer/lib/mediaHub/categoryFilters'
import { RecommendationActions } from './RecommendationActions'
import styles from './CompactAIAssistant.module.css'

export interface CompactAIAssistantProps {
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
 */
export function CompactAIAssistant({ kinds }: CompactAIAssistantProps = {}) {
  return (
    <div className={styles.panel} aria-label="Discover something to watch">
      <RecommendationActions kinds={kinds} />
    </div>
  )
}
