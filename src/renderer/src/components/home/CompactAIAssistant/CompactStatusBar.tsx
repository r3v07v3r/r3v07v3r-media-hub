'use client'

import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './CompactAIAssistant.module.css'

const STATUS_LABEL: Record<string, string> = {
  idle: 'R3 AI ready when you are',
  hover: 'R3 AI ready when you are',
  focused: 'R3 AI ready when you are',
  listening: 'Hearing you…',
  processing: 'Thinking…',
  responding: "Here's an idea",
  playing: 'Playing',
  loading: 'Loading…',
  error: "Didn't catch that"
}

/** The mobile-only "compact assistant status" required by spec section 8
 *  — a single slim row (icon + live status + a small breathing dot)
 *  standing in for the full orb + recommend-buttons panel, which doesn't
 *  fit phone width without pushing the hero below the fold. */
export function CompactStatusBar() {
  const { assistantState } = useAppState()
  const active = assistantState === 'listening' || assistantState === 'processing'

  return (
    <section
      className={`${styles.compactStatusBar} ${active ? styles.compactStatusBarActive : ''}`}
      aria-label="AI assistant status"
    >
      <Icon name="waveform" />
      <span className={styles.compactStatusText}>
        {STATUS_LABEL[assistantState] ?? STATUS_LABEL.idle}
      </span>
      <span className={styles.compactStatusDot} aria-hidden="true" />
    </section>
  )
}
