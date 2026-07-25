'use client'

import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './Overlays.module.css'

const DOT_CLASS: Record<string, string> = {
  info: styles.toastDotInfo,
  success: styles.toastDotSuccess,
  warning: styles.toastDotWarning,
  error: styles.toastDotError
}

export function NotificationLayer() {
  const { notifications, dismissNotification } = useAppState()

  return (
    <div className={styles.notifications} aria-live="polite" aria-relevant="additions">
      {notifications.map((n) => (
        <div key={n.id} className={`${styles.toast} glass-panel`} role="status">
          <span className={`${styles.toastDot} ${DOT_CLASS[n.tone]}`} aria-hidden="true" />
          <span className={styles.toastMessage}>{n.message}</span>
          <button
            type="button"
            className={styles.toastClose}
            onClick={() => dismissNotification(n.id)}
            aria-label="Dismiss notification"
          >
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
