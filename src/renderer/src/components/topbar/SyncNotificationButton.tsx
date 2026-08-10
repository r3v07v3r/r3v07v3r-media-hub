'use client'

import { Icon } from '@renderer/components/icons/Icon'
import { useAppState } from '@renderer/context/AppStateContext'
import styles from './TopUtilityBar.module.css'

/** Keeps unresolved reconciliation results reachable after their temporary
 * startup toast disappears. The button goes away once every discrepancy has
 * been resolved, so it represents actionable notifications rather than a
 * generic empty inbox. */
export function SyncNotificationButton() {
  const { syncDiscrepancies, syncReviewOpen, setSyncReviewOpen } = useAppState()
  const count = syncDiscrepancies.length

  if (count === 0) return null

  return (
    <button
      type="button"
      className={styles.notificationButton}
      aria-pressed={syncReviewOpen}
      aria-label={`${count} ${count === 1 ? 'title is' : 'titles are'} out of sync with Simkl — review`}
      onClick={() => setSyncReviewOpen(true)}
    >
      <Icon name="notification" size={18} />
      <span className={styles.notificationBadge} aria-hidden="true">
        {count > 99 ? '99+' : count}
      </span>
    </button>
  )
}
