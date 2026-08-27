'use client'

import type { CategoryKind } from '@renderer/lib/mediaHub/categoryFilters'
import { useDashboardLayoutMode } from '@renderer/hooks/useDashboardLayoutMode'
import { AIOrb } from './AIOrb'
import { AssistantStatus } from './AssistantStatus'
import { AssistantStrip } from './AssistantStrip'
import { RecommendationActions } from './RecommendationActions'
import { CompactStatusBar } from './CompactStatusBar'
import styles from './CompactAIAssistant.module.css'

export interface CompactAIAssistantProps {
  /** Passed straight through to RecommendationActions — see that
   *  component for why Home omits this (both movie+series buttons) while
   *  a category page passes its own single kind. */
  kinds?: CategoryKind[]
}

export function CompactAIAssistant({ kinds }: CompactAIAssistantProps = {}) {
  // Three different answers, one per layout mode — see
  // useDashboardLayoutMode for the thresholds and why height is now one
  // of them:
  //
  // 'stacked' (narrow): a single-line status bar. At phone width the
  //   full panel would eat most of the fold before the hero appeared,
  //   and there is no horizontal room to keep the buttons beside it.
  // 'compact' (short): the orb goes, the buttons stay — the whole panel
  //   becomes one ~40px strip across the top. A 302px sphere plus its
  //   halo is the single largest thing on the dashboard, and on a
  //   window under ~940px tall it is the difference between the mood
  //   dock landing on top of the AI Picks row and everything fitting.
  // 'short'/'full': unchanged, the orb panel as designed. (The orb
  //   itself shrinks a little at 'short' — see the media query in
  //   CompactAIAssistant.module.css.)
  const mode = useDashboardLayoutMode()

  if (mode === 'stacked') return <CompactStatusBar />
  if (mode === 'compact') return <AssistantStrip kinds={kinds} />

  return (
    <section className={styles.panel} aria-label="AI assistant">
      <AIOrb />
      <AssistantStatus />
      <RecommendationActions kinds={kinds} />
    </section>
  )
}
