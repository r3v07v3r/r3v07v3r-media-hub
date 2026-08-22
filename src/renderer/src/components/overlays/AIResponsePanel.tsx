'use client'

import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './Overlays.module.css'

export function AIResponsePanel() {
  const { assistantState, assistantResponse, closeAssistant } = useAppState()

  // 'error' shows too: a local model that isn't connected, isn't running,
  // or timed out puts its reason in assistantResponse, and that reason is
  // the whole point — silently rendering nothing would look like the field
  // ignored the question.
  if (
    assistantState !== 'processing' &&
    assistantState !== 'responding' &&
    assistantState !== 'error'
  ) {
    return null
  }

  return (
    <div className={`${styles.aiPanel} glass-panel`} role="status" aria-live="polite">
      <span className={styles.aiPanelIcon}>
        <Icon name={assistantState === 'error' ? 'info' : 'sparkle'} />
      </span>
      <div className={styles.aiPanelText}>
        {assistantState === 'processing' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span className={styles.skeletonLine} style={{ width: '80%' }} />
            <span className={styles.skeletonLine} style={{ width: '55%' }} />
          </div>
        ) : (
          assistantResponse
        )}
      </div>
      <button
        type="button"
        className={styles.aiPanelClose}
        onClick={closeAssistant}
        aria-label="Dismiss response"
      >
        <Icon name="x" size={13} />
      </button>
    </div>
  )
}
