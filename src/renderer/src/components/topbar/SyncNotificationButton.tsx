'use client'

import { Icon } from '@renderer/components/icons/Icon'
import { useAppState } from '@renderer/context/AppStateContext'
import styles from './TopUtilityBar.module.css'

/** Keeps unresolved reconciliation results reachable: films out of sync
 * with Simkl, and shows whose merged episodes have not been reviewed. The
 * startup toast that names them never leaves on its own (it goes when Review
 * or its close button is pressed), so this is the second way in, for after
 * it was closed, not a fallback for a toast that timed out. The button goes
 * away once every row has been dealt with, so it represents actionable
 * notifications rather than a generic empty inbox. */
export function SyncNotificationButton() {
  const { syncDiscrepancies, syncShows, syncReviewOpen, setSyncReviewOpen } = useAppState()
  const count = syncDiscrepancies.length + syncShows.length

  if (count === 0) return null

  return (
    <button
      type="button"
      className={styles.notificationButton}
      aria-pressed={syncReviewOpen}
      aria-label={`${count} ${count === 1 ? 'title' : 'titles'} to review in Sync review`}
      onClick={() => setSyncReviewOpen(true)}
    >
      <Icon name="notification" size={18} />
      <span className={styles.notificationBadge} aria-hidden="true">
        {count > 99 ? '99+' : count}
      </span>
    </button>
  )
}
