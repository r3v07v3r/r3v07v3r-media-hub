'use client'

import { useAppState } from '@renderer/context/AppStateContext'
import type { MediaItem } from '@renderer/types'
import { MAX_RATING, ratingLabel } from '@shared/media-hub/rating'
import styles from './RatingsPanel.module.css'

function Gauge({
  value,
  max,
  label,
  color
}: {
  value: number
  max: number
  label: string
  color: string
}) {
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
      <span className={styles.gaugeValue}>
        {max === 100 ? Math.round(value) : value.toFixed(1)}
      </span>
      <span className={styles.gaugeLabel}>{label}</span>
    </div>
  )
}

/**
 * Only ever renders sources the item's own data actually has — no
 * invented ratings, and gauges adapt to however many are present rather
 * than leaving empty placeholder circles for a source with no value.
 * communityRating/imdbRating are still the same parsed number for real
 * backend data today (see adapters.ts's catalogItemToMediaItem) — not two
 * independent sources yet, though the type and this panel both support
 * them being distinct once/if the backend integration adds a second one.
 * rottenTomatoesRating IS a genuinely independent third source (OMDb) —
 * present only for movies/series with OMDb connected and a Rotten Tomatoes
 * entry on file; never present for anime (see catalog.ts's metadata()).
 */
export function RatingsPanel({ media }: { media: MediaItem }) {
  const gauges: { value: number; max: number; label: string; color: string }[] = []
  if (media.communityRating) {
    gauges.push({
      value: media.communityRating,
      max: 10,
      label: 'R3 Score',
      color: 'var(--accent-yellow)'
    })
  }
  if (media.matchPercentage !== undefined) {
    gauges.push({
      value: media.matchPercentage,
      max: 100,
      label: 'Match',
      color: 'var(--accent-green)'
    })
  }
  if (media.imdbRating) {
    gauges.push({ value: media.imdbRating, max: 10, label: 'IMDb', color: 'var(--accent-cyan)' })
  }
  if (media.rottenTomatoesRating !== undefined) {
    gauges.push({
      value: media.rottenTomatoesRating,
      max: 100,
      label: 'Rotten Tomatoes',
      color: 'var(--accent-orange)'
    })
  }

  // Unlike the gauges, the personal score is always offered: a title nobody
  // has ever rated is exactly the one worth asking about, and "no crowd
  // ratings for this" is no reason to withhold the control.
  return (
    <section className={`${styles.panel} glass-panel`} aria-label="Ratings">
      {gauges.length > 0 && (
        <>
          <h2 className={styles.heading}>Crowd Ratings</h2>
          <div className={styles.gaugeRow}>
            {gauges.map((g) => (
              <Gauge key={g.label} {...g} />
            ))}
          </div>
        </>
      )}
      <YourRating media={media} />
    </section>
  )
}

/**
 * The person's own 1-10 score.
 *
 * Ten buttons rather than a slider or a star widget: a slider makes an exact
 * score fiddly to hit and impossible to keyboard, and stars would have to be
 * halved to reach ten — which is the scale Simkl, MyAnimeList, AniList and
 * Trakt all speak, and the one worth storing. Pressing the current score
 * again clears it, because withdrawing an opinion should not need a second
 * control.
 */
function YourRating({ media }: { media: MediaItem }) {
  const { ratings, rateMedia } = useAppState()
  const score = ratings.get(media.id) ?? 0

  return (
    <div className={styles.yours}>
      <div className={styles.yoursHead}>
        <h3 className={styles.yoursHeading}>Your rating</h3>
        <span className={styles.yoursValue}>
          {score > 0 ? `${score}/10 · ${ratingLabel(score)}` : 'Not rated'}
        </span>
      </div>
      <div className={styles.scale} role="radiogroup" aria-label={`Your rating for ${media.title}`}>
        {Array.from({ length: MAX_RATING }, (_, index) => index + 1).map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={score === value}
            aria-label={`${value} out of 10 — ${ratingLabel(value)}`}
            className={`${styles.scaleButton} ${value <= score ? styles.scaleButtonOn : ''}`}
            onClick={() => void rateMedia(media.id, score === value ? 0 : value)}
          >
            {value}
          </button>
        ))}
      </div>
    </div>
  )
}
