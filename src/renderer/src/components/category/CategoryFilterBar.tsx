'use client'

// Filter/sort bar for the Movies/Series/Anime category pages. Every
// dropdown here is driven by lib/mediaHub/categoryFilters.ts — the shared
// client-side filter/sort engine — because the backend's catalog.list(kind)
// has no server-side filter/sort/pagination at all (see that file's header
// comment). Genre/Year/Rating/Status option lists are derived from
// whatever values actually exist in the currently-loaded pool
// (availableGenres/availableYears/availableStatuses) rather than a
// hardcoded guess at the backend's vocabulary, so a dropdown option never
// promises a result set that comes back empty.

import { MediaItem } from '@renderer/types'
import { Icon } from '@renderer/components/icons/Icon'
import { CategoryConfig } from '@renderer/lib/mediaHub/categoryConfig'
import {
  availableGenres,
  availableYears,
  availableStatuses,
  CategoryFilterState,
  RUNTIME_BUCKETS,
  SEASONS_BUCKETS,
  EPISODE_LENGTH_BUCKETS,
  EPISODES_BUCKETS,
  RATING_THRESHOLDS,
  SORT_OPTIONS,
  RUNTIME_SORT_OPTIONS,
  filterStateToSearchParams
} from '@renderer/lib/mediaHub/categoryFilters'
import { useAppState } from '@renderer/context/AppStateContext'
import styles from './CategoryFilterBar.module.css'

export interface CategoryFilterBarProps {
  config: CategoryConfig
  /** The kind's full, unfiltered pool — used only to compute each
   *  dropdown's option list (available genres/years/statuses), never
   *  filtered itself here. */
  items: MediaItem[]
  filters: CategoryFilterState
  onChange: (next: CategoryFilterState) => void
  /** Applies a saved view by its serialised query — the page owns the URL, so
   *  it does the navigating. */
  onApplySaved: (query: string) => void
  resultCount: number
}

export function CategoryFilterBar({
  config,
  items,
  filters,
  onChange,
  onApplySaved,
  resultCount
}: CategoryFilterBarProps) {
  const { mediaHubSettings, refreshMediaHubSettings } = useAppState()
  const mine = (mediaHubSettings?.savedFilters ?? []).filter((saved) => saved.kind === config.kind)

  async function saveCurrentFilter(name: string): Promise<void> {
    const api = window.api?.mediaHub
    if (!api) return
    // The current filter state serialised exactly as the URL carries it, so a
    // saved view is applied by navigating to it and anything the bar learns to
    // express is saveable with no second schema.
    await api.settings
      .saveFilter(name, config.kind, filterStateToSearchParams(filters).toString())
      .catch(() => {})
    refreshMediaHubSettings()
  }

  async function deleteFilter(id: string): Promise<void> {
    const api = window.api?.mediaHub
    if (!api) return
    await api.settings.deleteFilter(id).catch(() => {})
    refreshMediaHubSettings()
  }

  const genres = availableGenres(items)
  const years = availableYears(items)
  const statuses = availableStatuses(items)
  const hasActiveFilter =
    filters.genre ||
    filters.year ||
    filters.minRating != null ||
    filters.runtimeBucket ||
    filters.seasonsBucket ||
    filters.episodeLengthBucket ||
    filters.episodesBucket ||
    filters.status

  function set<K extends keyof CategoryFilterState>(key: K, value: CategoryFilterState[K]) {
    onChange({ ...filters, [key]: value })
  }

  function reset() {
    onChange({
      ...filters,
      genre: null,
      year: null,
      minRating: null,
      runtimeBucket: null,
      seasonsBucket: null,
      episodeLengthBucket: null,
      episodesBucket: null,
      status: null
    })
  }

  return (
    <div
      className={`${styles.bar} glass-panel`}
      role="group"
      aria-label={`${config.label} filters`}
    >
      <span className={styles.icon} aria-hidden="true">
        <Icon name="filter" />
      </span>

      {/* Saved views for THIS page only: a runtime filter means nothing on the
          series page, so offering a movie view there would be offering
          something that cannot apply. */}
      {mine.map((saved) => (
        <span key={saved.id} className={styles.savedChip}>
          <button
            type="button"
            className={styles.savedApply}
            onClick={() => onApplySaved(saved.query)}
            title={saved.name}
          >
            {saved.name}
          </button>
          <button
            type="button"
            className={styles.savedRemove}
            aria-label={`Delete the saved view ${saved.name}`}
            onClick={() => void deleteFilter(saved.id)}
          >
            <Icon name="x" size={10} />
          </button>
        </span>
      ))}

      <select
        className={styles.select}
        value={filters.genre ?? ''}
        onChange={(e) => set('genre', e.target.value || null)}
        aria-label="Filter by genre"
      >
        <option value="">All Genres</option>
        {genres.map((g) => (
          <option key={g} value={g}>
            {g}
          </option>
        ))}
      </select>

      <select
        className={styles.select}
        value={filters.year ?? ''}
        onChange={(e) => set('year', e.target.value || null)}
        aria-label="Filter by year"
      >
        <option value="">All Years</option>
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>

      <select
        className={styles.select}
        value={filters.minRating ?? ''}
        onChange={(e) => set('minRating', e.target.value ? Number(e.target.value) : null)}
        aria-label="Filter by minimum rating"
      >
        <option value="">Any Rating</option>
        {RATING_THRESHOLDS.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </select>

      {config.filterFields.runtime && (
        <select
          className={styles.select}
          value={filters.runtimeBucket ?? ''}
          onChange={(e) => set('runtimeBucket', e.target.value || null)}
          aria-label="Filter by runtime"
        >
          <option value="">Any Runtime</option>
          {RUNTIME_BUCKETS.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>
      )}

      {config.filterFields.seasons && (
        <select
          className={styles.select}
          value={filters.seasonsBucket ?? ''}
          onChange={(e) => set('seasonsBucket', e.target.value || null)}
          aria-label="Filter by number of seasons"
        >
          <option value="">Any Seasons</option>
          {SEASONS_BUCKETS.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>
      )}

      {config.filterFields.episodeLength && (
        <select
          className={styles.select}
          value={filters.episodeLengthBucket ?? ''}
          onChange={(e) => set('episodeLengthBucket', e.target.value || null)}
          aria-label="Filter by episode length"
        >
          <option value="">Any Episode Length</option>
          {EPISODE_LENGTH_BUCKETS.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>
      )}

      {config.filterFields.episodes && (
        <select
          className={styles.select}
          value={filters.episodesBucket ?? ''}
          onChange={(e) => set('episodesBucket', e.target.value || null)}
          aria-label="Filter by number of episodes"
        >
          <option value="">Any Episode Count</option>
          {EPISODES_BUCKETS.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>
      )}

      {config.filterFields.status && (
        <select
          className={styles.select}
          value={filters.status ?? ''}
          onChange={(e) => set('status', e.target.value || null)}
          aria-label="Filter by status"
        >
          <option value="">Any Status</option>
          {statuses.map((s) => (
            <option key={s} value={s} style={{ textTransform: 'capitalize' }}>
              {s}
            </option>
          ))}
        </select>
      )}

      <button
        type="button"
        className={`${styles.toggle} ${filters.hideWatched ? styles.toggleActive : ''}`}
        aria-pressed={filters.hideWatched}
        onClick={() => set('hideWatched', !filters.hideWatched)}
      >
        <Icon name="eye-off" size={12} />
        Hide Watched
      </button>

      <button
        type="button"
        className={`${styles.toggle} ${filters.hideCompleted ? styles.toggleActive : ''}`}
        aria-pressed={filters.hideCompleted}
        onClick={() => set('hideCompleted', !filters.hideCompleted)}
      >
        <Icon name="check" size={12} />
        Hide Completed
      </button>

      <button
        type="button"
        className={`${styles.toggle} ${filters.hideDisliked ? styles.toggleActive : ''}`}
        aria-pressed={filters.hideDisliked}
        onClick={() => set('hideDisliked', !filters.hideDisliked)}
      >
        <Icon name="thumbs-down" size={12} />
        Hide Disliked
      </button>

      <span className={styles.spacer} />

      <span className={styles.resultCount}>
        {resultCount} title{resultCount === 1 ? '' : 's'}
      </span>

      {hasActiveFilter && (
        <button type="button" className={styles.clearButton} onClick={reset}>
          <Icon name="x" />
          Clear
        </button>
      )}

      {/* Offered only when there is something worth keeping. A "save this
          view" button over an unfiltered page would be inviting people to
          bookmark the default. */}
      {hasActiveFilter && (
        <button
          type="button"
          className={styles.clear}
          onClick={() => {
            const name = window.prompt('Name this view')
            if (name?.trim()) void saveCurrentFilter(name.trim())
          }}
        >
          Save view
        </button>
      )}

      <span className={styles.sortWrap}>
        <Icon name="sort" className={styles.sortIcon} />
        <select
          className={styles.select}
          value={filters.sort}
          onChange={(e) => set('sort', e.target.value as CategoryFilterState['sort'])}
          aria-label="Sort by"
        >
          {(config.filterFields.runtime ? RUNTIME_SORT_OPTIONS : SORT_OPTIONS).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </span>
    </div>
  )
}
