'use client'

import { useOverlayActions, useOverlayState } from '@renderer/context/OverlayContext'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './Overlays.module.css'

const DOT_CLASS: Record<string, string> = {
  info: styles.toastDotInfo,
  success: styles.toastDotSuccess,
  warning: styles.toastDotWarning,
  error: styles.toastDotError
}

export function NotificationLayer() {
  // Reads the overlay context directly rather than the app-wide one: this
  // is one of only two components that need the toast list, and keeping it
  // out of AppStateContext is what stops a toast re-rendering the entire
  // app (see context/OverlayContext.tsx).
  const { notifications } = useOverlayState()
  const { dismissNotification } = useOverlayActions()

  return (
    <div className={styles.notifications} aria-live="polite" aria-relevant="additions">
      {notifications.map((n) => (
        <div key={n.id} className={`${styles.toast} glass-panel`} role="status">
          <span className={`${styles.toastDot} ${DOT_CLASS[n.tone]}`} aria-hidden="true" />
          <span className={styles.toastMessage}>{n.message}</span>
          {n.action && (
            <button
              type="button"
              className={styles.toastAction}
              onClick={() => {
                dismissNotification(n.id)
                n.action?.run()
              }}
            >
              {n.action.label}
            </button>
          )}
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
