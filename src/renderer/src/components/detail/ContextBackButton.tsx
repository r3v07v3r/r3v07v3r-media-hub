'use client'

import { useRef, useEffect } from 'react'
import { Icon } from '@renderer/components/icons/Icon'
import type { BrowsingOrigin } from '@renderer/lib/mediaHub/browsingContext'
import styles from './ContextBackButton.module.css'

export interface ContextBackButtonProps {
  /** The captured origin to return to, if this detail page was opened
   *  from somewhere in the app. Null for a direct/deep link — falls back
   *  to a plain "Back to {fallbackLabel}" targeting that kind's category
   *  page, per spec ("don't attempt to restore nonexistent scroll/filter
   *  state" when there's nothing to restore). */
  origin: BrowsingOrigin | null
  fallbackLabel: string
  onBack: () => void
}

/**
 * Contextual back control — auto-focused on mount so Enter/Space
 * activates it immediately without an extra Tab, matching the same
 * "focus the dismiss control" pattern the old detail modal used.
 */
export function ContextBackButton({ origin, fallbackLabel, onBack }: ContextBackButtonProps) {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])

  const label = origin?.label ?? fallbackLabel

  return (
    <button
      ref={ref}
      type="button"
      className={`${styles.button} animated-edge glass-panel`}
      onClick={onBack}
    >
      <Icon name="chevron-left" size={15} />
      <span>Back to {label}</span>
    </button>
  )
}
