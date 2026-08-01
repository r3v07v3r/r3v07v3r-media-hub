'use client'

// Shared shell for the Movies/Series/Anime category pages — one
// implementation driven by a CategoryConfig (see lib/mediaHub/
// categoryConfig.ts) rather than three near-identical page components, per
// the integration spec's "prefer a shared category-page architecture with
// configuration/data adapters" instruction. Composition mirrors
// HomeDashboard.tsx's own grid (same "assistant"/"hero"/"picks" grid-area
// names, reused unchanged by CompactAIAssistant/FeaturedHero/
// ContinueWatchingPanel/RecommendationCarousel — see CategoryPage.module.css)
// so these pages read as direct siblings of Home rather than a new layout
// pattern, with two new rows of its own: the filter bar and one continuous
// results grid below it (see MediaGrid — always showing every title
// matching the current filters, lazily revealed as the person scrolls,
// rather than splitting the same pool into a few curated rails above a
// genre-pill row). PerformanceWidget (Home's own CPU/GPU/RAM gauges) is
// deliberately NOT reused here — that panel is Home-specific, not a
// standing app-wide fixture.

import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAppState } from '@renderer/context/AppStateContext'
import { CategoryConfig } from '@renderer/lib/mediaHub/categoryConfig'
import {
  matchesCategoryKind,
  applyCategoryFilters,
  applyWatchStateFilters,
  sortMediaItems,
  filterStateFromSearchParams,
  filterStateToSearchParams,
  type HideStateDefaults
} from '@renderer/lib/mediaHub/categoryFilters'
import { useRestoreBrowsingOrigin } from '@renderer/lib/mediaHub/useRestoreBrowsingOrigin'
import { CompactAIAssistant } from '@renderer/components/home/CompactAIAssistant'
import { FeaturedHero } from '@renderer/components/home/FeaturedHero/FeaturedHero'
import { ContinueWatchingPanel } from '@renderer/components/home/ContinueWatchingPanel'
import { RecommendationCarousel } from '@renderer/components/home/RecommendationCarousel'
import { Icon } from '@renderer/components/icons/Icon'
import { CategoryFilterBar } from './CategoryFilterBar'
import { MediaGrid } from './MediaGrid'
import styles from './CategoryPage.module.css'

export function CategoryPage({ config }: { config: CategoryConfig }) {
  const {
    catalog,
    catalogLoading,
    catalogLive,
    catalogSettled,
    refreshCatalog,
    categorySearch,
    clearCategorySearch,
    runCategorySearch,
    browsingOrigin,
    mediaHubSettings
  } = useAppState()
  // Filters live in the URL, not component state — this is what makes
  // "restore my filters" (the detail page's contextual back button) just
  // "navigate to the same URL," and what lets a genre chip on the detail
  // page link straight into a filtered category page
  // (/movies?genre=Sci-Fi) with no separate cross-page state channel. See
  // categoryFilters.ts's filterStateFromSearchParams/ToSearchParams.
  const [searchParams, setSearchParams] = useSearchParams()
  // Keyed on the string form, not `searchParams` itself, in a variable
  // first — URLSearchParams doesn't have stable reference equality across
  // renders the way a plain string does, and the lint rule wants a plain
  // expression in the dependency array rather than a method call there.
  const searchParamsString = searchParams.toString()
  // Only takes effect on a fresh page visit with nothing in the URL yet —
  // see filterStateFromSearchParams's doc comment for why an explicit
  // per-page override, once made, can never silently fall back to this.
  const hideDefaults: HideStateDefaults = useMemo(
    () => ({
      hideWatched: mediaHubSettings?.hideWatchedDefault ?? false,
      hideCompleted: mediaHubSettings?.hideCompletedDefault ?? false,
      hideDisliked: mediaHubSettings?.hideDislikedDefault ?? false
    }),
    [mediaHubSettings]
  )
  const filters = useMemo(
    () => filterStateFromSearchParams(searchParams, hideDefaults),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on searchParamsString, see comment above
    [searchParamsString, hideDefaults]
  )
  function setFilters(next: typeof filters): void {
    setSearchParams(filterStateToSearchParams(next), { replace: true })
  }

  const kindItems = useMemo(
    () => catalog.filter((item) => matchesCategoryKind(item, config.kind)),
    [catalog, config.kind]
  )

  const filteredSorted = useMemo(
    () => sortMediaItems(applyCategoryFilters(kindItems, filters), filters.sort),
    [kindItems, filters]
  )

  const isSearchActive =
    categorySearch.kind === config.kind && categorySearch.query.trim().length > 0

  // Search results bypass genre/year/rating/etc (a search query has its own
  // meaning independent of the browse filters) but still honor hide-
  // watched/completed/disliked — those three are a standing "don't show me
  // this" preference, not a browse-specific narrowing.
  const filteredSearchResults = useMemo(
    () => applyWatchStateFilters(categorySearch.results, filters),
    [categorySearch.results, filters]
  )

  const heroItems = useMemo(() => kindItems.slice(0, 6), [kindItems])

  // Enough of the grid needs to already be rendered for the restore step
  // (see useRestoreBrowsingOrigin) to find the previously-focused card at
  // all — seed MediaGrid's initial reveal batch past wherever that card's
  // index actually falls, rounded up to a clean batch boundary, instead
  // of leaving it to the default first-30 that a deep scroll position
  // would fall past. Computed against whichever list is actually being
  // rendered (search results persist across a detail-page visit and back
  // for free, since categorySearch is app-level state nothing here
  // clears — see isSearchActive above).
  const restoreVisibleCount = useMemo(() => {
    if (!browsingOrigin?.focusedItemId) return undefined
    const activeList = isSearchActive ? filteredSearchResults : filteredSorted
    const idx = activeList.findIndex((item) => item.id === browsingOrigin.focusedItemId)
    return idx >= 0 ? Math.ceil((idx + 1) / 30) * 30 : undefined
  }, [browsingOrigin, isSearchActive, filteredSearchResults, filteredSorted])

  // Catalog data is fetched once, globally (AppStateContext), not
  // per-page — by the time this page remounts after a detail-page visit,
  // it's already sitting in `catalog` with no loading flicker, so there's
  // no separate "is this page's content actually ready" signal beyond
  // "did we render past the loading branch," which `true` here reflects.
  useRestoreBrowsingOrigin(true)

  return (
    <div className={styles.page}>
      {/* CompactAIAssistant/FeaturedHero/ContinueWatchingPanel/
          RecommendationCarousel/PerformanceWidget are rendered as DIRECT
          children of this grid container (not wrapped) — each hardcodes
          its own `grid-area` (assistant/hero/hero/status/picks
          respectively, the exact same area names HomeDashboard.module.css
          uses — see CategoryPage.module.css), which only takes effect on
          an actual grid item. Wrapping any of them in an extra div here
          would break that self-placement. */}
      <CompactAIAssistant kinds={[config.kind]} />

      <FeaturedHero items={heroItems} />
      <ContinueWatchingPanel kindFilter={config.kind} className={styles.continuePanel} />
      <RecommendationCarousel />

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
              items={filteredSearchResults}
              loading={categorySearch.loading}
              error={categorySearch.error}
              onRetry={() => runCategorySearch(config.kind, categorySearch.query)}
              emptyTitle={`No ${config.pluralLabel} found for "${categorySearch.query}"`}
              emptyMessage="Try a different title or keyword."
              initialVisibleCount={restoreVisibleCount}
            />
          </>
        ) : (
          <MediaGrid
            items={filteredSorted}
            loading={catalogLoading}
            emptyTitle={`No ${config.pluralLabel} to show`}
            emptyMessage="Try widening a filter or clearing them all."
            initialVisibleCount={restoreVisibleCount}
          />
        )}
      </div>
    </div>
  )
}
