'use client'

import { useMemo, useRef } from 'react'
import { CATALOG, MOOD_CATEGORIES } from '@renderer/data/mockData'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import { useReducedMotion } from '@renderer/hooks/useReducedMotion'
import styles from './MoodBrowser.module.css'

export function MoodBrowser() {
  const { activeMood, setActiveMood, combinedMoods, toggleCombinedMood, openDetail } = useAppState()
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reducedMotion = useReducedMotion()

  const activeMoods = useMemo(
    () => (combinedMoods.length > 0 ? combinedMoods : activeMood ? [activeMood] : []),
    [combinedMoods, activeMood]
  )

  const results = useMemo(() => {
    if (activeMoods.length === 0) return []
    return CATALOG.filter((m) => m.moods?.some((mood) => activeMoods.includes(mood)))
  }, [activeMoods])

  function selectMood(id: string, combine: boolean) {
    if (combine) {
      toggleCombinedMood(id)
      return
    }
    setActiveMood(activeMood === id ? null : id)
  }

  function clearFilter() {
    setActiveMood(null)
    activeMoods.forEach((m) => toggleCombinedMood(m))
  }

  return (
    <section className={styles.section} aria-label="Browse by mood">
      {activeMoods.length > 0 && (
        <div className={`${styles.resultsDrawer} glass-panel`}>
          <div className={styles.resultsHeader}>
            <span>
              Showing {results.length} title{results.length === 1 ? '' : 's'} for{' '}
              {activeMoods
                .map((id) => MOOD_CATEGORIES.find((m) => m.id === id)?.label)
                .filter(Boolean)
                .join(' + ')}
            </span>
            <button type="button" className={styles.resultsClear} onClick={clearFilter}>
              Clear
            </button>
          </div>
          {results.length === 0 ? (
            <p className={styles.resultsEmpty}>Nothing matches that mood combination yet.</p>
          ) : (
            <div className={styles.resultsGrid}>
              {results.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={styles.resultCard}
                  style={{
                    background: `linear-gradient(150deg, ${m.artTint[0]}, ${m.artTint[1]})`
                  }}
                  onClick={() => openDetail(m)}
                >
                  {m.title}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <h2 className={styles.heading}>Browse By Mood</h2>
      <div className={`${styles.cropX} thin-scroll`}>
        <div className={styles.row}>
          <svg
            className={`${styles.connector} ${reducedMotion ? styles.reduced : ''}`}
            viewBox="0 0 100 20"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="moodConnectorGrad" x1="0" y1="0" x2="1" y2="0">
                {MOOD_CATEGORIES.map((mood, i) => (
                  <stop
                    key={mood.id}
                    offset={`${(i / Math.max(1, MOOD_CATEGORIES.length - 1)) * 100}%`}
                    stopColor={mood.accent}
                  />
                ))}
              </linearGradient>
            </defs>
            <line
              className={styles.connectorLine}
              x1="0"
              y1="10"
              x2="100"
              y2="10"
              stroke="url(#moodConnectorGrad)"
              strokeWidth="0.6"
              vectorEffect="non-scaling-stroke"
            />
            <line
              className={styles.connectorPulse}
              x1="0"
              y1="10"
              x2="100"
              y2="10"
              stroke="url(#moodConnectorGrad)"
              strokeWidth="1.4"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              pathLength={1000}
            />
          </svg>
          {MOOD_CATEGORIES.map((mood, i) => {
            const isActive = activeMoods.includes(mood.id)
            return (
              <button
                key={mood.id}
                type="button"
                className={`${styles.pill} animated-edge ${isActive ? `${styles.pillActive} edge-active` : ''}`}
                style={{
                  ['--hue' as string]: mood.hue,
                  ['--edge-delay' as string]: `${i * 0.35}s`
                }}
                onClick={(e) => selectMood(mood.id, e.shiftKey)}
                onTouchStart={() => {
                  longPressTimer.current = setTimeout(() => selectMood(mood.id, true), 550)
                }}
                onTouchEnd={() => {
                  if (longPressTimer.current) clearTimeout(longPressTimer.current)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  selectMood(mood.id, true)
                }}
                aria-pressed={isActive}
                aria-label={`Browse ${mood.label} — shift-click to combine with another mood`}
              >
                <span
                  className={`${styles.pillHalo} breathing-glow`}
                  style={{ ['--breathe-delay' as string]: `${i * 0.5}s` }}
                  aria-hidden="true"
                />
                <span className={styles.pillIcon} aria-hidden="true">
                  <Icon name={mood.icon} />
                </span>
                <span className={styles.pillLabel}>{mood.label}</span>
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
}
