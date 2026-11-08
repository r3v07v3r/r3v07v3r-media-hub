'use client'

import type { CategoryKind } from '@renderer/lib/mediaHub/categoryFilters'
import { useOllamaAvailable } from '@renderer/lib/mediaHub/useOllamaAvailable'
import { useServiceReadiness } from '@renderer/hooks/useServiceReadiness'
import { RequiresSetup } from '@renderer/components/layout/RequiresSetup'
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
 * The buttons are drawn only while a local model is actually reachable
 * (useOllamaAvailable): they ask Ollama, and two buttons whose only possible
 * outcome is "couldn't reach the server" are not an offer. In their place,
 * once the settings have been read, a one-line notice with the way to set
 * Ollama up, so the feature is not simply missing. Nothing at all before
 * then, so the notice does not flash on a machine where Ollama answers.
 * The dashboard asks the same questions to lay the column out — see
 * HomeDashboard.
 */
export function CompactAIAssistant({ kinds }: CompactAIAssistantProps = {}) {
  const available = useOllamaAvailable()
  const ready = useServiceReadiness()
  if (!available) {
    if (!ready.loaded) return null
    return (
      <div className={styles.notice}>
        <RequiresSetup
          compact
          services={['ollama']}
          what="Recommendations"
          // Saved but not answering: the settings are there, the server is not.
          detail={ready.ollama ? 'Ollama is saved but is not answering right now.' : undefined}
        />
      </div>
    )
  }
  return (
    <div className={styles.panel} aria-label="Discover something to watch">
      <RecommendationActions kinds={kinds} />
    </div>
  )
}
