'use client'

import type { MediaItem } from '@renderer/types'
import styles from './RatingsPanel.module.css'

function Gauge({ value, max, label, color }: { value: number; max: number; label: string; color: string }) {
  const pct = Math.max(0, Math.min(1, value / max))
  const radius = 30
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - pct)
  return (
    <div className={styles.gauge}>
      <svg viewBox="0 0 72 72" className={styles.gaugeSvg}>
        <circle cx="36" cy="36" r={radius} className={styles.gaugeTrack} />
        <circle
          cx="36"
          cy="36"
          r={radius}
          className={styles.gaugeFill}
          style={{ stroke: color, strokeDasharray: circumference, strokeDashoffset: offset }}
        />
      </svg>
      <span className={styles.gaugeValue}>{max === 100 ? Math.round(value) : value.toFixed(1)}</span>
      <span className={styles.gaugeLabel}>{label}</span>
    </div>
  )
}

/**
 * Only ever renders sources the item's own data actually has — no
 * invented ratings, and gauges adapt to however many are present rather
 * than leaving empty placeholder circles for a source with no value (see
 * this file's own note: communityRating/imdbRating are the same parsed
 * number for real backend data today — see adapters.ts's
 * catalogItemToMediaItem — not two independent sources yet, though the
 * type and this panel both support them being distinct once/if the
 * backend integration adds a second one).
 */
export function RatingsPanel({ media }: { media: MediaItem }) {
  const gauges: { value: number; max: number; label: string; color: string }[] = []
  if (media.communityRating) {
    gauges.push({ value: media.communityRating, max: 10, label: 'R3 Score', color: 'var(--accent-yellow)' })
  }
  if (media.matchPercentage !== undefined) {
    gauges.push({ value: media.matchPercentage, max: 100, label: 'Match', color: 'var(--accent-green)' })
  }
  if (media.imdbRating) {
    gauges.push({ value: media.imdbRating, max: 10, label: 'IMDb', color: 'var(--accent-cyan)' })
  }

  if (gauges.length === 0) return null

  return (
    <section className={`${styles.panel} glass-panel`} aria-label="Ratings">
      <h2 className={styles.heading}>Crowd Ratings</h2>
      <div className={styles.gaugeRow}>
        {gauges.map((g) => (
          <Gauge key={g.label} {...g} />
        ))}
      </div>
    </section>
  )
}
