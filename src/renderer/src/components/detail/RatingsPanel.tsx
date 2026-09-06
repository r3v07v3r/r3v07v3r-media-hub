'use client'

import { useAppState } from '@renderer/context/AppStateContext'
import type { MediaItem } from '@renderer/types'
import { MAX_RATING, ratingLabel } from '@shared/media-hub/rating'
import styles from './RatingsPanel.module.css'
import { RatingSourceMark } from './RatingBadge'
import { ratingSourceFor, type RatingSource } from './ratingSource'

function Gauge({
  value,
  max,
  label,
  color,
  source
}: {
  value: number
  max: number
  label: string
  color: string
  /** Present for a real service, absent for the app's own Match figure —
   *  which has no logo to show because it is not somebody else's score. */
  source?: RatingSource
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
      <span className={styles.gaugeLabel}>
        {source ? <RatingSourceMark source={source} /> : label}
      </span>
    </div>
  )
}

/**
 * Only ever renders sources the item's own data actually has — no
 * invented ratings, and gauges adapt to however many are present rather
 * than leaving empty placeholder circles for a source with no value.
 *
 * ONE CROWD FIGURE, not two. communityRating and imdbRating are filled
 * from the same CatalogItem.rating (adapters.ts), so showing both drew the
 * same number twice under different names — two gauges agreeing perfectly,
 * every time, because they were never independent. It is drawn once now,
 * labelled with the service it actually came from: IMDb for films and
 * series, whose ids ARE IMDb ids, and Kitsu for anime, which has no IMDb
 * id at all and whose figure is Kitsu's averageRating.
 *
 * rottenTomatoesRating IS a genuinely independent source (OMDb) — present
 * only for movies/series with OMDb connected and a Rotten Tomatoes entry
 * on file; never present for anime (see catalog.ts's metadata()).
 */
export function RatingsPanel({ media }: { media: MediaItem }) {
  const source = ratingSourceFor(media.mediaKind)
  const crowd = media.imdbRating ?? media.communityRating
  const gauges: {
    value: number
    max: number
    label: string
    color: string
    source?: RatingSource
  }[] = []
  if (crowd) {
    gauges.push({
      value: crowd,
      max: 10,
      label: source === 'kitsu' ? 'Kitsu' : 'IMDb',
      color: source === 'kitsu' ? 'var(--accent-orange)' : 'var(--accent-yellow)',
      source
    })
  }
  if (media.matchPercentage !== undefined) {
    // Not a crowd rating at all — this app's own guess at how well the
    // title fits this person. It keeps a plain label for that reason.
    gauges.push({
      value: media.matchPercentage,
      max: 100,
      label: 'Match',
      color: 'var(--accent-green)'
    })
  }
  if (media.rottenTomatoesRating !== undefined) {
    gauges.push({
      value: media.rottenTomatoesRating,
      max: 100,
      label: 'Rotten Tomatoes',
      color: 'var(--accent-orange)',
      source: 'rottenTomatoes'
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

  function handleScore(value: number): void {
    const next = score === value ? 0 : value
    void rateMedia(media.id, next, {
      type: media.mediaKind ?? (media.mediaType === 'series' ? 'series' : 'movie'),
      title: media.title
    })
  }

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
            onClick={() => handleScore(value)}
          >
            {value}
          </button>
        ))}
      </div>
    </div>
  )
}
