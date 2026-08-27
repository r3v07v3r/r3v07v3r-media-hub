'use client'

import { useAppState } from '@renderer/context/AppStateContext'
import type { CategoryKind } from '@renderer/lib/mediaHub/categoryFilters'
import { Icon } from '@renderer/components/icons/Icon'
import { RecommendationActions } from './RecommendationActions'
import styles from './CompactAIAssistant.module.css'

const STATUS_LABEL: Record<string, string> = {
  processing: 'Thinking…',
  responding: "Here's an idea",
  playing: 'Playing',
  loading: 'Loading…',
  error: 'R3 AI could not answer that'
}

/**
 * The 'compact' layout mode's assistant (see useDashboardLayoutMode): the
 * 302px orb — and the 300px-tall column it needs — is gone, but the two
 * things that column actually DID are not. Status and the Recommend
 * Next Movie/Series buttons move onto one ~40px row across the top of
 * the dashboard, where there is horizontal room to spare and the
 * vertical cost is a twentieth of the panel's.
 *
 * Distinct from CompactStatusBar, which is the narrow-width ('stacked')
 * answer: at phone width there is no room to put buttons beside the
 * status text, so that one drops them. Here there is.
 */
export function AssistantStrip({ kinds }: { kinds?: CategoryKind[] }) {
  const { assistantState, mediaHubSettings } = useAppState()
  const active = assistantState === 'processing'
  const model = mediaHubSettings?.ollamaConnected ? mediaHubSettings.ollamaModel : ''
  // Same honesty as the full panel's AssistantStatus — at rest, say
  // whether there is a model to ask at all rather than a blanket "Ready".
  const idleLabel = model ? `Ready — running ${model} locally.` : 'No local model connected yet.'

  return (
    <section
      className={`${styles.assistantStrip} ${active ? styles.compactStatusBarActive : ''}`}
      aria-label="AI assistant"
    >
      <Icon name="waveform" />
      <span className={styles.compactStatusText}>{STATUS_LABEL[assistantState] ?? idleLabel}</span>
      <span className={styles.compactStatusDot} aria-hidden="true" />
      <RecommendationActions kinds={kinds} />
    </section>
  )
}
