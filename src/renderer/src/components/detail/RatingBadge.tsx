'use client'

// Who says so, next to what they said.
//
// A rating with no source is a number nobody can weigh. Worse, this app was
// printing the SAME number twice — communityRating and imdbRating are both
// filled from CatalogItem.rating (see adapters.ts), so "★ 7.8 | IMDb 7.8"
// was one figure wearing two hats, which reads as corroboration between two
// independent sources when there is only ever one.
//
// So: one crowd figure, labelled with where it actually came from, and
// Rotten Tomatoes beside it when OMDb is connected and has an entry — that
// one IS genuinely independent.

import { RATING_SOURCE_LABELS, type RatingSource } from './ratingSource'
import styles from './RatingBadge.module.css'

/**
 * The tomato, drawn rather than fetched — every asset in this app has to
 * work offline, and a remote logo would be a network request on a card.
 * A body, a highlight and a leaf is enough to read as one at 14px.
 */
function TomatoMark() {
  return (
    <svg viewBox="0 0 16 16" className={styles.mark} aria-hidden="true" focusable="false">
      <circle cx="8" cy="9.5" r="5.5" fill="#fa320a" />
      <path d="M8 4.2c-1.1-1.5-2.6-2-4-1.9.5 1.4 1.7 2.4 3.1 2.6z" fill="#3f9c35" />
      <path d="M8 4.2c.9-1.2 2.1-1.7 3.3-1.7-.4 1.2-1.4 2-2.5 2.2z" fill="#3f9c35" />
      <ellipse cx="6.2" cy="8" rx="1.1" ry="1.6" fill="#ff6a45" opacity="0.55" />
    </svg>
  )
}

/**
 * IMDb and Kitsu as wordmarks, because that is what they are — IMDb's own
 * mark is the letters on yellow, and a made-up glyph for either would be
 * less recognisable than the name, not more.
 */
/**
 * Just the mark, for places that already draw the figure themselves — the
 * detail page's gauges put the number in the middle of a ring, so the
 * source belongs underneath on its own.
 */
export function RatingSourceMark({ source }: { source: RatingSource }) {
  return (
    <span className={`${styles.badge} ${styles[source]}`}>
      {source === 'rottenTomatoes' ? (
        <TomatoMark />
      ) : (
        <span className={styles.wordmark} aria-hidden="true">
          {RATING_SOURCE_LABELS[source]}
        </span>
      )}
      <span className="visually-hidden">{RATING_SOURCE_LABELS[source]}</span>
    </span>
  )
}

export function RatingBadge({
  source,
  value,
  compact = false
}: {
  source: RatingSource
  /** Already formatted: "7.8" out of ten, or "87%" for Rotten Tomatoes. */
  value: string
  /** For card meta rows, where this sits among already-dimmed text and
   *  should not shout over it. */
  compact?: boolean
}) {
  return (
    <span className={`${styles.badge} ${styles[source]} ${compact ? styles.compact : ''}`}>
      {source === 'rottenTomatoes' ? (
        <TomatoMark />
      ) : (
        <span className={styles.wordmark} aria-hidden="true">
          {RATING_SOURCE_LABELS[source]}
        </span>
      )}
      <b className={styles.value}>{value}</b>
      {/* The name again, for anyone not looking at it. The wordmark above is
          aria-hidden precisely so this is not read out twice. */}
      <span className="visually-hidden">{RATING_SOURCE_LABELS[source]}</span>
    </span>
  )
}
