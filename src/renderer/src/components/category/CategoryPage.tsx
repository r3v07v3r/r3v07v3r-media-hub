'use client'

// Shared shell for the Movies/Series/Anime category pages — one
// implementation driven by a CategoryConfig (see lib/mediaHub/
// categoryConfig.ts) rather than three near-identical page components, per
// the integration spec's "prefer a shared category-page architecture with
// configuration/data adapters" instruction. Composition mirrors
// HomeDashboard.tsx's own grid (same "assistant"/"hero"/"status"
// grid-area names, reused unchanged by CompactAIAssistant/
// ContinueWatchingPanel/PerformanceWidget — see CategoryPage.module.css)
// so these pages read as direct siblings of Home rather than a new layout
// pattern, with two new rows of its own: the filter bar and the bottom
// genre-blob row.

import { useMemo, useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { CategoryConfig } from '@renderer/lib/mediaHub/categoryConfig'
import {
  matchesCategoryKind,
  applyCategoryFilters,
  sortMediaItems,
  trendingRail,
  newAndPopularRail,
  topRatedRail,
  DEFAULT_FILTER_STATE
} from '@renderer/lib/mediaHub/categoryFilters'
import { CompactAIAssistant } from '@renderer/components/home/CompactAIAssistant'
import { FeaturedHero } from '@renderer/components/home/FeaturedHero/FeaturedHero'
import { ContinueWatchingPanel } from '@renderer/components/home/ContinueWatchingPanel'
import { PerformanceWidget } from '@renderer/components/home/PerformanceWidget'
import { Icon } from '@renderer/components/icons/Icon'
import { CategoryFilterBar } from './CategoryFilterBar'
import { GenreBlobRow } from './GenreBlobRow'
import { MediaRail } from './MediaRail'
import { MediaGrid } from './MediaGrid'
import styles from './CategoryPage.module.css'

const RAIL_FN = {
  trending: trendingRail,
  newAndPopular: newAndPopularRail,
  topRated: topRatedRail
} as const

export function CategoryPage({ config }: { config: CategoryConfig }) {
  const {
    catalog,
    catalogLoading,
    catalogLive,
    catalogSettled,
    refreshCatalog,
    categorySearch,
    clearCategorySearch,
    runCategorySearch
  } = useAppState()
  const [filters, setFilters] = useState(DEFAULT_FILTER_STATE)

  const kindItems = useMemo(
    () => catalog.filter((item) => matchesCategoryKind(item, config.kind)),
    [catalog, config.kind]
  )

  const isFiltering =
    filters.genre != null ||
    filters.year != null ||
    filters.minRating != null ||
    filters.runtimeBucket != null ||
    filters.seasonsBucket != null ||
    filters.episodeLengthBucket != null ||
    filters.episodesBucket != null ||
    filters.status != null ||
    filters.sort !== 'trending'

  const filteredSorted = useMemo(
    () => sortMediaItems(applyCategoryFilters(kindItems, filters), filters.sort),
    [kindItems, filters]
  )

  const isSearchActive =
    categorySearch.kind === config.kind && categorySearch.query.trim().length > 0

  const heroItems = useMemo(() => kindItems.slice(0, 6), [kindItems])

  return (
    <div className={styles.page}>
      {/* CompactAIAssistant/FeaturedHero/ContinueWatchingPanel/
          PerformanceWidget/GenreBlobRow are rendered as DIRECT children of
          this grid container (not wrapped) — each hardcodes its own
          `grid-area` (assistant/hero/hero/status/mood respectively, the
          exact same area names HomeDashboard.module.css uses — see
          CategoryPage.module.css), which only takes effect on an actual
          grid item. Wrapping any of them in an extra div here would break
          that self-placement. */}
      <CompactAIAssistant kinds={[config.kind]} />

      <FeaturedHero items={heroItems} heroLabel={config.heroLabel} />
      <ContinueWatchingPanel kindFilter={config.kind} />

      <div className={styles.filterbarArea}>
        <CategoryFilterBar
          config={config}
          items={kindItems}
          filters={filters}
          onChange={setFilters}
          resultCount={filteredSorted.length}
        />
        {catalogSettled && !catalogLive && (
          <div className={styles.offlineBanner} role="status">
            <Icon name="wifi-off" size={15} />
            Showing preview titles — couldn&apos;t reach the media hub backend.
            <button type="button" onClick={refreshCatalog} className={styles.offlineRetry}>
              <Icon name="refresh" size={13} />
              Retry
            </button>
          </div>
        )}
      </div>

      <div className={styles.contentArea}>
        {isSearchActive ? (
          <>
            <div className={styles.resultsHeading}>
              <h2>Search results for &ldquo;{categorySearch.query}&rdquo;</h2>
              <button type="button" className={styles.clearSearch} onClick={clearCategorySearch}>
                <Icon name="x" size={12} />
                Clear
              </button>
            </div>
            <MediaGrid
              items={categorySearch.results}
              loading={categorySearch.loading}
              error={categorySearch.error}
              onRetry={() => runCategorySearch(config.kind, categorySearch.query)}
              emptyTitle={`No ${config.pluralLabel} found for "${categorySearch.query}"`}
              emptyMessage="Try a different title or keyword."
            />
          </>
        ) : isFiltering ? (
          <MediaGrid items={filteredSorted} loading={catalogLoading} />
        ) : (
          <div className={styles.rails}>
            {config.rails.map((rail) => (
              <MediaRail
                key={rail.key}
                title={rail.title}
                icon={config.icon}
                items={RAIL_FN[rail.key](kindItems)}
                loading={catalogLoading}
                emptyMessage={`No ${config.pluralLabel} to show yet.`}
              />
            ))}
          </div>
        )}
      </div>

      <PerformanceWidget />

      <GenreBlobRow
        genres={config.genres}
        activeGenre={filters.genre}
        onSelect={(genre) => setFilters((prev) => ({ ...prev, genre }))}
      />
    </div>
  )
}
