'use client'

import { Icon } from '@renderer/components/icons/Icon'
import { useAppState } from '@renderer/context/AppStateContext'
import styles from './TopUtilityBar.module.css'

/**
 * Opens the control centre — the settings and system surface that folds down
 * from this bar (see components/controlcentre/ControlCentre.tsx).
 *
 * `aria-expanded` rather than `aria-pressed`: this is a disclosure, not a
 * toggle with two equal states. A screen reader should say "expanded" once
 * the panel is down, which is also how the control's own icon rotation
 * reads visually.
 */
export function ControlCentreButton() {
  const { controlCentreOpen, setControlCentreOpen } = useAppState()

  return (
    <button
      type="button"
      className={styles.controlCentreButton}
      aria-expanded={controlCentreOpen}
      aria-label={controlCentreOpen ? 'Close control centre' : 'Open control centre'}
      onClick={() => setControlCentreOpen((open) => !open)}
    >
      <Icon name="settings" size={18} />
    </button>
  )
}
