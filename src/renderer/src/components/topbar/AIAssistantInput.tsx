'use client'

import { useEffect, useRef, useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './AIAssistantInput.module.css'

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
  const { assistantState, setAssistantState, runAssistantQuery, closeAssistant } = useAppState()
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const listenTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (listenTimer.current) clearTimeout(listenTimer.current)
    }
  }, [])

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
      const heard = 'something thrilling for tonight'
      setValue(heard)
      runAssistantQuery(heard)
    }, 1600)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      runAssistantQuery(value)
    } else if (e.key === 'Escape') {
      setValue('')
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
          placeholder="Ask R3 anything…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => {
            if (assistantState === 'idle') setAssistantState('focused')
          }}
          onBlur={() => {
            if (assistantState === 'focused') setAssistantState('idle')
          }}
          onKeyDown={handleKeyDown}
          aria-label="Ask R3 anything"
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
