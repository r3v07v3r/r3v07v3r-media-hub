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
// the assistant (runAssistantQuery) every other route still uses. Kept as
// a plain lookup rather than parsing categoryConfig.ts here, since this
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
    categorySearch,
    runCategorySearch,
    clearCategorySearch
  } = useAppState()
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const pathname = useLocation().pathname
  const category = CATEGORY_ROUTE_KIND[pathname]

  // The search still standing for THIS page, if any — '' on every other
  // route (including a detail page, where the field is the assistant again
  // and a leftover query would read as nonsense in it).
  const activeQuery = category && categorySearch.kind === category.kind ? categorySearch.query : ''

  // Refills the field from that standing search whenever the route
  // changes. This is what makes "search, open a title, come back" land on
  // the results with the query still in the field, instead of on an empty
  // field over the full unfiltered grid: categorySearch is app-level state
  // that already survives the detail-page visit (CategoryPage renders
  // straight off it), and this is the half that keeps the input agreeing
  // with it. Navigating no longer clears the search at all — it now ends
  // only when the person ends it (the clear button here, the results
  // heading's own Clear, Escape, or emptying the field), which is also why
  // the query stays visible the whole time it is in effect rather than
  // silently filtering a page with a blank-looking search box.
  //
  // This does NOT fight typing: `activeQuery` only changes when a search is
  // actually submitted or cleared, never on a keystroke.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setValue(activeQuery)
  }, [pathname, activeQuery])

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
    assistantState === 'processing' ? styles.capsuleProcessing : '',
    assistantState === 'error' ? styles.capsuleError : ''
  ]
    .filter(Boolean)
    .join(' ')

  function clearSearch() {
    setValue('')
    clearCategorySearch()
    inputRef.current?.focus()
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
    processing: 'Thinking…',
    responding: ''
  }

  return (
    <div className={styles.wrap}>
      <WaveSpacer state={assistantState} />
      <div className={capsuleClass}>
        {/* Decorative, not a control. This slot used to hold a microphone
            button that faked a voice capture on a timer — no audio was
            ever recorded, and nothing in this app can ask for the
            microphone anyway (the main process denies every permission
            request outright, see main/index.ts). Removed rather than left
            standing as an affordance for a capability that isn't there. */}
        <span className={styles.leadIcon} aria-hidden="true">
          <Icon name={category ? 'search' : 'sparkle'} className={styles.leadIconGlyph} />
        </span>
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
        {/* Only while a search is actually standing. The search outlives
            navigating away and back now, so it needs a way out from the
            field itself, not only from the results heading further down
            the page. */}
        {activeQuery && (
          <button
            type="button"
            className={styles.clearButton}
            onClick={clearSearch}
            aria-label={category ? `Clear ${category.label} search` : 'Clear search'}
          >
            <Icon name="x" size={12} />
          </button>
        )}
        {assistantState === 'processing' && (
          <span className={styles.processingRing} aria-hidden="true" />
        )}
        {statusLabel[assistantState] && (
          <span className={styles.statusText}>{statusLabel[assistantState]}</span>
        )}
        <span className="visually-hidden" role="status" aria-live="polite">
          {assistantState === 'processing' && 'R3 AI is working on your request'}
          {assistantState === 'responding' && 'R3 AI has a response'}
          {assistantState === 'error' && 'R3 AI could not answer that'}
        </span>
      </div>
      <WaveSpacer mirrored state={assistantState} />
    </div>
  )
}
