'use client'

import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './OfflineBanner.module.css'

export function OfflineBanner() {
  const { isOffline } = useAppState()
  if (!isOffline) return null
  return (
    <div className={styles.banner} role="status">
      <Icon name="wifi-off" />
      You&apos;re offline — showing downloaded and cached content only.
    </div>
  )
}
