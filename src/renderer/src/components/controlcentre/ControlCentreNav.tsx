'use client'

// The control centre's rail.
//
// It sits on the LEFT, in the same column the app face puts its own nav
// rail. That is not decoration: the two faces are sides of one object, and
// a rail that jumped across the screen when the cube turned would break the
// impression that anything solid was rotating.
//
// A tablist rather than a list of buttons, because that is what it is —
// selecting an entry swaps the panel beside it rather than navigating
// anywhere — and the roving tabindex below is what a tablist owes a
// keyboard: one stop in the tab order, arrows to move within it.

import { useCallback, useRef } from 'react'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './ControlCentre.module.css'
import { CONTROL_CENTRE_SECTIONS, type ControlCentreSectionId } from './sections'

interface Props {
  active: ControlCentreSectionId
  onSelect: (id: ControlCentreSectionId) => void
}

export function ControlCentreNav({ active, onSelect }: Props) {
  const railRef = useRef<HTMLDivElement | null>(null)

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step =
        event.key === 'ArrowDown' || event.key === 'ArrowRight'
          ? 1
          : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
            ? -1
            : 0
      if (!step) return
      // Stopped as well as prevented: the face above this listens for keys
      // of its own, and an arrow that both moved the selection here and did
      // something up there would be one press doing two things.
      event.preventDefault()
      event.stopPropagation()
      const index = CONTROL_CENTRE_SECTIONS.findIndex((section) => section.id === active)
      const next =
        CONTROL_CENTRE_SECTIONS[
          (index + step + CONTROL_CENTRE_SECTIONS.length) % CONTROL_CENTRE_SECTIONS.length
        ]
      onSelect(next.id)
      // Focus follows selection in a tablist with automatic activation —
      // without this the arrow moves the panel and leaves the caret behind,
      // so the next arrow starts from the wrong place.
      railRef.current?.querySelector<HTMLElement>(`[data-section="${next.id}"]`)?.focus()
    },
    [active, onSelect]
  )

  return (
    <div
      ref={railRef}
      className={styles.rail}
      role="tablist"
      aria-orientation="vertical"
      aria-label="Control centre sections"
      onKeyDown={onKeyDown}
    >
      {CONTROL_CENTRE_SECTIONS.map((section) => {
        const selected = section.id === active
        return (
          <button
            key={section.id}
            type="button"
            role="tab"
            data-section={section.id}
            id={`cc-tab-${section.id}`}
            aria-selected={selected}
            aria-controls={`cc-panel-${section.id}`}
            // Roving: exactly one entry is in the tab order, so Tab enters
            // and leaves the rail rather than walking every item in it.
            tabIndex={selected ? 0 : -1}
            className={`${styles.railButton} ${selected ? styles.railButtonActive : ''}`}
            onClick={() => onSelect(section.id)}
          >
            <span className={styles.railIcon} aria-hidden="true">
              <Icon name={section.icon} size={18} />
            </span>
            <span className={styles.railLabel}>{section.label}</span>
          </button>
        )
      })}
    </div>
  )
}
