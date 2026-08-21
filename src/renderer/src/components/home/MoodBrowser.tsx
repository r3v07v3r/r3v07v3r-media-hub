'use client'

import { useMemo, useRef } from 'react'
import { MOOD_CATEGORIES } from '@renderer/data/mockData'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import { useReducedMotion } from '@renderer/hooks/useReducedMotion'
import { resolveArtwork } from '@renderer/lib/artwork'
import { ArtworkImage } from '@renderer/components/media/ArtworkImage'
import { WatchStatusBadge } from '@renderer/components/media/WatchStatusBadge'
import { getWatchStatus } from '@renderer/lib/mediaHub/watchStatus'
import { applyWatchStateFilters } from '@renderer/lib/mediaHub/categoryFilters'
import styles from './MoodBrowser.module.css'

// The dock's whole visual vocabulary is flowing light lines. Everything
// below is authored in a 1200x208 viewBox stretched onto the dock's real
// box with preserveAspectRatio="none", so y units land 1:1 on the dock's
// 208px height and only x scales with the window.
const VB_WIDTH = 1200

/** Smooth cubic chain through a list of points, with a horizontal tangent
 *  at every one of them. Each segment's control points sit half a span in
 *  from each end at that end's own height, which is the standard cosine-
 *  like ease between two extrema — it's what keeps a wave from kinking at
 *  its own crests. */
function smoothPath(points: [number, number][]): string {
  let d = `M ${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]
    const [x1, y1] = points[i]
    const dx = (x1 - x0) * 0.5
    d += ` C ${(x0 + dx).toFixed(1)} ${y0.toFixed(1)}, ${(x1 - dx).toFixed(1)} ${y1.toFixed(1)}, ${x1.toFixed(1)} ${y1.toFixed(1)}`
  }
  return d
}

/** The spine: one continuous line running the width of the window that
 *  swells up under each mood and sinks back down between them, so the
 *  labels sit along a single ribbon of light instead of on nothing. Built
 *  from the mood count rather than hardcoded, so adding an eighth mood
 *  re-scallops the line instead of desyncing it.
 *
 *  It starts one full span left of 0 and ends one span past the right
 *  edge: the line has to arrive from outside the frame and leave through
 *  the other side, never begin and end inside it. */
function buildSpine(count: number, crestY: number, troughY: number, lift: number[]): string {
  const step = VB_WIDTH / count
  const points: [number, number][] = []
  for (let i = -1; i <= count; i++) {
    points.push([i * step, troughY])
    // Per-crest variation keeps this from reading as a machined
    // scallop — the deltas are small enough that the icons and labels
    // above still share one baseline.
    points.push([(i + 0.5) * step, crestY + lift[((i % lift.length) + lift.length) % lift.length]])
  }
  points.push([(count + 1) * step, troughY])
  return smoothPath(points)
}

// Free-drifting ambient filaments, independent of the moods. One cubic
// (C) followed by smooth continuations (S), which reflect the previous
// control point automatically so every joint stays C1 continuous. All of
// them start left of 0 and end right of 1200, and the lowest passes
// below y=208 — that part of the curve is under the bottom edge of the
// screen, which is what gives the light somewhere to come from.
const AMBIENT: { d: string; width: number; opacity: number; pulse: boolean }[] = [
  {
    d: 'M -60 58 C 160 50 260 6 480 18 S 820 68 1020 56 S 1220 26 1260 32',
    width: 0.9,
    opacity: 0.42,
    pulse: false
  },
  {
    d: 'M -60 112 C 110 104 180 30 340 42 S 540 112 700 102 S 900 28 1060 42 S 1200 90 1260 82',
    width: 1.1,
    opacity: 0.6,
    pulse: true
  },
  {
    // Weaves through the band between the labels and the window's edge.
    // Deliberately kept clear of the label band (dock y 120-134) — an
    // earlier run at y 96-158 drew a hairline straight through the middle
    // of five of the seven words.
    d: 'M -60 150 C 160 198 320 208 540 190 S 840 146 1040 158 S 1210 198 1260 192',
    width: 1,
    opacity: 0.55,
    pulse: true
  },
  {
    d: 'M -60 246 C 200 230 330 188 560 196 S 880 244 1080 232 S 1220 206 1260 212',
    width: 1.1,
    opacity: 0.55,
    pulse: false
  }
]

export function MoodBrowser() {
  const {
    activeMood,
    setActiveMood,
    combinedMoods,
    toggleCombinedMood,
    openDetail,
    catalog,
    continueWatching,
    mediaHubSettings
  } = useAppState()
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reducedMotion = useReducedMotion()

  const activeMoods = useMemo(
    () => (combinedMoods.length > 0 ? combinedMoods : activeMood ? [activeMood] : []),
    [combinedMoods, activeMood]
  )

  const results = useMemo(() => {
    if (activeMoods.length === 0) return []
    const matched = catalog.filter((m) => m.moods?.some((mood) => activeMoods.includes(mood)))
    // No per-page override here (unlike the Movies/Series/Anime filter bar)
    // — Mood Browser just reflects the person's global Settings default.
    return applyWatchStateFilters(matched, {
      hideWatched: mediaHubSettings?.hideWatchedDefault ?? false,
      hideCompleted: mediaHubSettings?.hideCompletedDefault ?? false,
      hideDisliked: mediaHubSettings?.hideDislikedDefault ?? false
    })
  }, [activeMoods, catalog, mediaHubSettings])

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

  const spine = useMemo(
    () => buildSpine(MOOD_CATEGORIES.length, 168, 190, [0, -5, 3, -3, 6, -2, 4]),
    []
  )

  // The same left-to-right run of mood accents the filaments are stroked
  // with, as a CSS gradient — it lights the window's own bottom edge (see
  // .edgeGlow). Built from the data rather than written out in the
  // stylesheet so the two can't drift apart when a mood is added, removed
  // or recoloured.
  const accentSweep = useMemo(() => {
    const stops = MOOD_CATEGORIES.map((mood, i) => {
      const offset = (i / Math.max(1, MOOD_CATEGORIES.length - 1)) * 100
      return `${mood.accent} ${offset.toFixed(1)}%`
    })
    return `linear-gradient(90deg, ${stops.join(', ')})`
  }, [])

  // Both filament layers (the blurred bloom pass and the crisp pass) draw
  // the same curves, so they share one source of truth here rather than
  // repeating the path data twice in the markup. A strand marked `pulse`
  // gets a SECOND crisp path laid over its own solid one — the travelling
  // highlight has to ride along a line that's already there, not replace
  // it, or all the eye sees is a detached dash sliding through space.
  const filaments = (variant: 'glow' | 'line') => {
    const strands = [...AMBIENT, { d: spine, width: 1.7, opacity: 1, pulse: true }]
    return strands.flatMap((strand, i) => {
      const nodes = [
        <path
          key={`${variant}-${i}`}
          className={styles.current}
          d={strand.d}
          fill="none"
          stroke="url(#moodCurrentGrad)"
          strokeWidth={variant === 'glow' ? strand.width * 3.6 : strand.width}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          style={{ opacity: variant === 'glow' ? strand.opacity * 0.45 : strand.opacity }}
        />
      ]
      if (variant === 'line' && strand.pulse) {
        nodes.push(
          <path
            key={`pulse-${i}`}
            className={styles.currentPulse}
            d={strand.d}
            fill="none"
            stroke="url(#moodCurrentGrad)"
            strokeWidth={strand.width * 1.8}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            pathLength={1000}
            style={{ ['--current-delay' as string]: `${i * 2.9}s` }}
          />
        )
      }
      return nodes
    })
  }

  return (
    <section className={styles.section} aria-label="Browse by mood">
      <div className={`${styles.dock} ${reducedMotion ? styles.reduced : ''}`}>
        {/* Soft vertical fade that grounds the dock against whatever art
            is behind it. Deliberately a gradient with no edge of its own
            — a panel with a top border here would put the invisible box
            straight back. */}
        <span className={styles.scrim} aria-hidden="true" />

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
                {results.map((m) => {
                  const artwork = resolveArtwork(m)
                  const watchStatus = getWatchStatus(m, continueWatching)
                  return (
                    <button
                      key={m.id}
                      type="button"
                      className={styles.resultCard}
                      data-media-id={m.id}
                      onClick={() => openDetail(m)}
                    >
                      <ArtworkImage
                        src={artwork.backdropUrl ?? artwork.posterUrl}
                        alt=""
                        fallbackTitle={m.title}
                        artTint={m.artTint}
                        sizes="110px"
                        className={styles.resultArt}
                      />
                      <div className={styles.resultScrim} aria-hidden="true" />
                      <span className={styles.resultTitle}>{m.title}</span>
                      <WatchStatusBadge status={watchStatus} compact />
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* Two passes over the same curves: a wide blurred one for the
            bloom, a hairline one on top for the filament itself. Only the
            crisp pass carries the travelling pulses — animating inside a
            blurred layer would re-run the blur every frame for no visible
            gain. */}
        <svg
          className={styles.currentsGlow}
          viewBox="0 0 1200 208"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="moodCurrentGrad" x1="0" y1="0" x2="1" y2="0">
              {MOOD_CATEGORIES.map((mood, i) => (
                <stop
                  key={mood.id}
                  offset={`${(i / Math.max(1, MOOD_CATEGORIES.length - 1)) * 100}%`}
                  stopColor={mood.accent}
                />
              ))}
            </linearGradient>
          </defs>
          {filaments('glow')}
        </svg>
        <svg
          className={styles.currents}
          viewBox="0 0 1200 208"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {filaments('line')}
        </svg>

        {/* The window's bottom edge itself, lit. Small, but it's what
            turns "glows near the bottom" into "light escaping from behind
            the edge of the screen". */}
        <span
          className={styles.edgeGlow}
          style={{ backgroundImage: accentSweep }}
          aria-hidden="true"
        />

        <h2 className={styles.heading}>Browse By Mood</h2>
        <div className={styles.row}>
          {MOOD_CATEGORIES.map((mood, i) => {
            const isActive = activeMoods.includes(mood.id)
            return (
              <button
                key={mood.id}
                type="button"
                className={`${styles.mood} ${isActive ? styles.moodActive : ''}`}
                style={{
                  ['--hue' as string]: mood.hue,
                  ['--breathe-delay' as string]: `${i * 0.62}s`
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
                <span className={styles.plume} aria-hidden="true" />
                <span className={styles.riser} aria-hidden="true" />
                {/* Everything clickable lives in here rather than on the
                    button's own (deliberately oversized) box — see .target
                    in the stylesheet. */}
                <span className={styles.target}>
                  <span className={styles.moodIcon} aria-hidden="true">
                    <Icon name={mood.icon} strokeWidth={1.25} />
                  </span>
                  <span className={styles.moodLabel}>{mood.label}</span>
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
}
