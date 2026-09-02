'use client'

// The controls a mixed list needs that a single-kind library page does not.
//
// CategoryFilterBar is the app's real filter bar and this is deliberately
// not it: that one is built around ONE kind, with runtime buckets for
// films, season counts for series and episode counts for anime, and a
// saved-views system keyed by kind. Planned holds all three at once, so
// most of its controls would be inapplicable to most of the rows.

import type { MediaItem } from '@renderer/types'
import { availableGenres, RATING_THRESHOLDS } from '@renderer/lib/mediaHub/categoryFilters'
import { EMPTY_PLANNED_FILTERS, type PlannedFilterState } from './plannedFilterRules'
import styles from './PlannedFilters.module.css'

const KINDS: { id: PlannedFilterState['kind']; label: string }[] = [
  { id: 'all', label: 'Everything' },
  { id: 'movie', label: 'Films' },
  { id: 'series', label: 'Series' },
  { id: 'anime', label: 'Anime' }
]

const SOURCES: { id: PlannedFilterState['source']; label: string }[] = [
  { id: 'all', label: 'Anywhere' },
  { id: 'here', label: 'Added here' },
  { id: 'simkl', label: 'Simkl' },
  { id: 'trakt', label: 'Trakt' },
  { id: 'mal', label: 'MyAnimeList' }
]

export function PlannedFilters({
  items,
  filters,
  onChange,
  resultCount
}: {
  /** The unfiltered list, so the genre options describe what is actually
   *  there rather than every genre the catalog knows. */
  items: MediaItem[]
  filters: PlannedFilterState
  onChange: (next: PlannedFilterState) => void
  resultCount: number
}) {
  const genres = availableGenres(items)
  const dirty =
    filters.kind !== 'all' ||
    filters.genre !== null ||
    filters.minRating !== null ||
    filters.source !== 'all'

  return (
    <div className={styles.bar}>
      <div className={styles.segments} role="group" aria-label="Kind">
        {KINDS.map((kind) => (
          <button
            key={kind.id}
            type="button"
            className={`${styles.segment} ${filters.kind === kind.id ? styles.segmentOn : ''}`}
            onClick={() => onChange({ ...filters, kind: kind.id })}
          >
            {kind.label}
          </button>
        ))}
      </div>

      <label className={styles.field}>
        <span className="visually-hidden">Genre</span>
        <select
          value={filters.genre ?? ''}
          onChange={(event) => onChange({ ...filters, genre: event.target.value || null })}
        >
          <option value="">Any genre</option>
          {genres.map((genre) => (
            <option key={genre} value={genre}>
              {genre}
            </option>
          ))}
        </select>
      </label>

      <label className={styles.field}>
        <span className="visually-hidden">Minimum rating</span>
        <select
          value={filters.minRating ?? ''}
          onChange={(event) =>
            onChange({
              ...filters,
              minRating: event.target.value ? Number(event.target.value) : null
            })
          }
        >
          <option value="">Any rating</option>
          {RATING_THRESHOLDS.map((threshold) => (
            <option key={threshold.value} value={threshold.value}>
              {threshold.label}
            </option>
          ))}
        </select>
      </label>

      <label className={styles.field}>
        <span className="visually-hidden">Source</span>
        <select
          value={filters.source}
          onChange={(event) =>
            onChange({ ...filters, source: event.target.value as PlannedFilterState['source'] })
          }
        >
          {SOURCES.map((source) => (
            <option key={source.id} value={source.id}>
              {source.label}
            </option>
          ))}
        </select>
      </label>

      <span className={styles.count}>
        {resultCount} {resultCount === 1 ? 'title' : 'titles'}
      </span>

      {dirty && (
        <button
          type="button"
          className={styles.clear}
          onClick={() => onChange(EMPTY_PLANNED_FILTERS)}
        >
          Clear
        </button>
      )}
    </div>
  )
}
