'use client'

import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './PartyButton.module.css'

export function PartyButton() {
  const { partyStatus, partyPanelOpen, setPartyPanelOpen } = useAppState()
  const inParty = partyStatus?.inParty ?? false
  const memberCount = partyStatus?.members?.length ?? 0

  return (
    <>
      <button
        type="button"
        className={`${styles.button} ${inParty ? styles.active : ''}`}
        aria-pressed={partyPanelOpen}
        aria-label={inParty ? `Open room — ${memberCount} people` : 'Open Rooms'}
        onClick={() => setPartyPanelOpen((v) => !v)}
      >
        <Icon name="people" size={17} className={styles.icon} />
        <span className={styles.label}>{inParty ? 'Room' : 'Rooms'}</span>
        {inParty && memberCount > 0 && <span className={styles.badge}>{memberCount}</span>}
      </button>
      <div className={styles.separator} aria-hidden="true" />
    </>
  )
}
