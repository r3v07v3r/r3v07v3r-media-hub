'use client'

import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useAppState } from '@renderer/context/AppStateContext'
import type { CategoryKind } from '@renderer/lib/mediaHub/categoryFilters'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './AIAssistantInput.module.css'

// Route -> category kind, so this one global search field knows when it's
// sitting on a Movies/Series/Anime page and should hit the real
// catalog:search backend (see AppStateContext's categorySearch) instead of
// the scripted assistant response every other route still uses. Kept as a
// plain lookup rather than parsing categoryConfig.ts here, since this
// component only needs the kind + a short label, not the full per-page
// config (filters, genre lists, ...).
const CATEGORY_ROUTE_KIND: Record<string, { kind: CategoryKind; label: string }> = {
  '/movies': { kind: 'movie', label: 'movies' },
  '/series': { kind: 'series', label: 'series' },
  '/anime': { kind: 'anime', label: 'anime' }
}

const WAVE_PATH =
  'M0,14 C15,14 15,4 30,4 C45,4 45,14 60,14 C75,14 75,24 90,24 C105,24 105,14 120,14'

function WaveSpacer({ mirrored = false, state }: { mirrored?: boolean; state: string }) {
  return (
    <div
      className={`${styles.spacer} ${mirrored ? styles.spacerRight : ''} ${styles['waveState-' + state] ?? ''}`}
    >
      <svg
        className={styles.wave}
        viewBox="0 0 120 28"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={`aiWaveGrad-${mirrored ? 'r' : 'l'}`} x1="1" y1="0" x2="0" y2="0">
            <stop offset="0%" stopColor="#38e5ff" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#38e5ff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path
          className={styles.waveGlow}
          d={WAVE_PATH}
          fill="none"
          stroke={`url(#aiWaveGrad-${mirrored ? 'r' : 'l'})`}
          strokeWidth={5}
          strokeLinecap="round"
        />
        <path
          className={styles.waveLine}
          d={WAVE_PATH}
          fill="none"
          stroke={`url(#aiWaveGrad-${mirrored ? 'r' : 'l'})`}
          strokeWidth={1.2}
          strokeLinecap="round"
        />
        {/* One or two brighter travelling pulses riding the same path —
            the "energy line" the motion spec calls for, not a static
            glow. pathLength=1 normalizes stroke-dasharray/offset to a
            0-1 unit so the same keyframes work on both the mirrored
            left/right halves regardless of their actual pixel length. */}
        <path
          className={styles.wavePulse}
          d={WAVE_PATH}
          pathLength={1}
          fill="none"
          stroke="#bfe9ff"
          strokeWidth={2}
          strokeLinecap="round"
        />
      </svg>
    </div>
  )
}

export function AIAssistantInput() {
  const {
    assistantState,
    setAssistantState,
    runAssistantQuery,
    closeAssistant,
    runCategorySearch,
    clearCategorySearch
  } = useAppState()
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const listenTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pathname = useLocation().pathname
  const category = CATEGORY_ROUTE_KIND[pathname]

  useEffect(() => {
    return () => {
      if (listenTimer.current) clearTimeout(listenTimer.current)
    }
  }, [])

  // Leaving a category page (or the query going back to empty) drops
  // whatever search was in flight/showing on that page — otherwise a
  // search typed on /movies would still be "active" in context after
  // navigating to /series, which would incorrectly gate that page's own
  // search-results view too (see CategoryPage's categorySearch check).
  useEffect(() => {
    if (!category) clearCategorySearch()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setValue('')
  }, [pathname, category, clearCategorySearch])

  function submitQuery(query: string) {
    if (category) {
      runCategorySearch(category.kind, query)
    } else {
      runAssistantQuery(query)
    }
  }

  const capsuleClass = [
    styles.capsule,
    assistantState === 'focused' ? styles.capsuleFocused : '',
    assistantState === 'listening' ? styles.capsuleListening : '',
    assistantState === 'processing' ? styles.capsuleProcessing : '',
    assistantState === 'error' ? styles.capsuleError : ''
  ]
    .filter(Boolean)
    .join(' ')

  function handleMicClick() {
    if (assistantState === 'listening') {
      setAssistantState('idle')
      return
    }
    setAssistantState('listening')
    listenTimer.current = setTimeout(() => {
      const heard = category ? category.label : 'something thrilling for tonight'
      setValue(heard)
      setAssistantState(category ? 'idle' : 'listening')
      submitQuery(heard)
    }, 1600)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      submitQuery(value)
    } else if (e.key === 'Escape') {
      setValue('')
      if (category) clearCategorySearch()
      closeAssistant()
      inputRef.current?.blur()
    }
  }

  const statusLabel: Partial<Record<string, string>> = {
    listening: 'Listening…',
    processing: 'Thinking…',
    responding: ''
  }

  return (
    <div className={styles.wrap}>
      <WaveSpacer state={assistantState} />
      <div className={capsuleClass}>
        <button
          type="button"
          className={`${styles.micButton} ${assistantState === 'listening' ? styles.micButtonActive : ''}`}
          aria-pressed={assistantState === 'listening'}
          aria-label={assistantState === 'listening' ? 'Stop listening' : 'Ask with your voice'}
          onClick={handleMicClick}
        >
          <Icon name="mic" className={styles.micIcon} />
        </button>
        <input
          ref={inputRef}
          type="text"
          className={styles.input}
          placeholder={category ? `Search ${category.label}…` : 'Ask R3 anything…'}
          value={value}
          onChange={(e) => {
            const next = e.target.value
            setValue(next)
            // Backspacing to empty restores the browse view immediately —
            // otherwise the last search-results view would linger until
            // the user pressed Enter again on an empty field.
            if (category && next.trim() === '') clearCategorySearch()
          }}
          onFocus={() => {
            if (assistantState === 'idle') setAssistantState('focused')
          }}
          onBlur={() => {
            if (assistantState === 'focused') setAssistantState('idle')
          }}
          onKeyDown={handleKeyDown}
          aria-label={category ? `Search ${category.label}` : 'Ask R3 anything'}
        />
        {assistantState === 'processing' && (
          <span className={styles.processingRing} aria-hidden="true" />
        )}
        {statusLabel[assistantState] && (
          <span className={styles.statusText}>{statusLabel[assistantState]}</span>
        )}
        <span className="visually-hidden" role="status" aria-live="polite">
          {assistantState === 'listening' && 'Voice assistant is listening'}
          {assistantState === 'processing' && 'Voice assistant is processing your request'}
          {assistantState === 'responding' && 'Voice assistant has a response'}
          {assistantState === 'error' && 'Voice assistant encountered an error'}
        </span>
      </div>
      <WaveSpacer mirrored state={assistantState} />
    </div>
  )
}
