// Client-side filter/sort engine shared by the Movies/Series/Anime
// category pages. Exists because the backend's catalog.list(kind) returns
// the entire cached catalog for that kind with no server-side filter/sort
// support at all (confirmed against main/media-hub/catalog.ts — the
// handler just validates `kind` and returns the full cached list) — every
// genre/year/rating/runtime/seasons/episodes/status filter and every sort
// order has to be computed here, in memory, over whatever catalog.list()
// (or AppStateContext's already-fetched `catalog`) returned. One shared
// engine rather than three near-identical page-local copies, per this
// integration's "avoid duplicating almost-identical page implementations"
// requirement.

import type { MediaItem } from '@renderer/types'

export type CategoryKind = 'movie' | 'series' | 'anime'

export type SortKey =
  'trending' | 'title-asc' | 'year-desc' | 'rating-desc' | 'runtime-asc' | 'runtime-desc'

export interface CategoryFilterState {
  genre: string | null
  year: string | null
  minRating: number | null
  /** Movies only — see RUNTIME_BUCKETS. */
  runtimeBucket: string | null
  /** Series only — see SEASONS_BUCKETS. */
  seasonsBucket: string | null
  /** Series only — see EPISODE_LENGTH_BUCKETS. */
  episodeLengthBucket: string | null
  /** Anime only — see EPISODES_BUCKETS. */
  episodesBucket: string | null
  /** Series/anime — CatalogItem.status passed through verbatim (see
   *  adapters.ts), e.g. "ongoing"/"ended"/"returning series". Options are
   *  derived from whatever values actually appear in the loaded catalog,
   *  never a hardcoded guess at the backend's vocabulary. */
  status: string | null
  /** Hide anything already (fully or partially) watched, completed, or
   *  disliked — see applyWatchStateFilters below. Unlike every other field
   *  here, these three don't default to "off"/unset on a fresh page visit:
   *  CategoryPage seeds them from the person's global Settings default
   *  (MediaHubPublicSettings.hideWatchedDefault etc.) the first time the
   *  page mounts with no explicit value in the URL, then normal URL
   *  round-tripping takes over once they've been touched on this page. */
  hideWatched: boolean
  hideCompleted: boolean
  hideDisliked: boolean
  sort: SortKey
}

export const DEFAULT_FILTER_STATE: CategoryFilterState = {
  genre: null,
  year: null,
  minRating: null,
  runtimeBucket: null,
  seasonsBucket: null,
  episodeLengthBucket: null,
  episodesBucket: null,
  status: null,
  hideWatched: false,
  hideCompleted: false,
  hideDisliked: false,
  sort: 'trending'
}

const SORT_KEYS = new Set<SortKey>([
  'trending',
  'title-asc',
  'year-desc',
  'rating-desc',
  'runtime-asc',
  'runtime-desc'
])

/**
 * Reflects filter/sort state in the URL query string rather than
 * component-local state — this is what makes "restore my filters" (the
 * detail page's contextual back button) just "navigate to the same URL,"
 * and what lets a genre chip elsewhere in the app link straight into a
 * filtered category page (`/movies?genre=Sci-Fi`) without a separate
 * cross-page state channel. See CategoryPage.tsx's use of these via
 * react-router's useSearchParams.
 */
export interface HideStateDefaults {
  hideWatched: boolean
  hideCompleted: boolean
  hideDisliked: boolean
}

export const NO_HIDE_DEFAULTS: HideStateDefaults = {
  hideWatched: false,
  hideCompleted: false,
  hideDisliked: false
}

/**
 * `hideDefaults` (the person's global Settings default for these three
 * toggles) only applies when the URL says nothing about them at all — a
 * fresh visit to /movies with no query string. Once CategoryPage's
 * onChange has ever fired (including toggling one back off, which
 * filterStateToSearchParams always writes explicitly as '0', never omits —
 * see that function's comment), the URL is the sole source of truth, so an
 * explicit "off" can't silently snap back to a global "on" default on the
 * next render.
 */
export function filterStateFromSearchParams(
  params: URLSearchParams,
  hideDefaults: HideStateDefaults = NO_HIDE_DEFAULTS
): CategoryFilterState {
  const sort = params.get('sort')
  return {
    genre: params.get('genre'),
    year: params.get('year'),
    minRating: params.has('minRating') ? Number(params.get('minRating')) || null : null,
    runtimeBucket: params.get('runtime'),
    seasonsBucket: params.get('seasons'),
    episodeLengthBucket: params.get('epLength'),
    episodesBucket: params.get('epCount'),
    status: params.get('status'),
    hideWatched: params.has('hideWatched')
      ? params.get('hideWatched') === '1'
      : hideDefaults.hideWatched,
    hideCompleted: params.has('hideCompleted')
      ? params.get('hideCompleted') === '1'
      : hideDefaults.hideCompleted,
    hideDisliked: params.has('hideDisliked')
      ? params.get('hideDisliked') === '1'
      : hideDefaults.hideDisliked,
    sort: sort && SORT_KEYS.has(sort as SortKey) ? (sort as SortKey) : 'trending'
  }
}

export function filterStateToSearchParams(filters: CategoryFilterState): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.genre) params.set('genre', filters.genre)
  if (filters.year) params.set('year', filters.year)
  if (filters.minRating != null) params.set('minRating', String(filters.minRating))
  if (filters.runtimeBucket) params.set('runtime', filters.runtimeBucket)
  if (filters.seasonsBucket) params.set('seasons', filters.seasonsBucket)
  if (filters.episodeLengthBucket) params.set('epLength', filters.episodeLengthBucket)
  if (filters.episodesBucket) params.set('epCount', filters.episodesBucket)
  if (filters.status) params.set('status', filters.status)
  // Always written explicitly (unlike every filter above, which omits a
  // falsy/unset value) — see filterStateFromSearchParams's comment on why
  // an explicit "off" has to survive the round trip instead of being
  // indistinguishable from "never set."
  params.set('hideWatched', filters.hideWatched ? '1' : '0')
  params.set('hideCompleted', filters.hideCompleted ? '1' : '0')
  params.set('hideDisliked', filters.hideDisliked ? '1' : '0')
  if (filters.sort !== 'trending') params.set('sort', filters.sort)
  return params
}

export interface Bucket {
  value: string
  label: string
  test: (n: number) => boolean
}

export const RUNTIME_BUCKETS: Bucket[] = [
  { value: 'short', label: 'Under 90 min', test: (m) => m < 90 },
  { value: 'medium', label: '90–120 min', test: (m) => m >= 90 && m <= 120 },
  { value: 'long', label: 'Over 120 min', test: (m) => m > 120 }
]

export const SEASONS_BUCKETS: Bucket[] = [
  { value: '1', label: '1 season', test: (n) => n === 1 },
  { value: '2-4', label: '2–4 seasons', test: (n) => n >= 2 && n <= 4 },
  { value: '5plus', label: '5+ seasons', test: (n) => n >= 5 }
]

export const EPISODE_LENGTH_BUCKETS: Bucket[] = [
  { value: 'short', label: 'Under 30 min', test: (m) => m < 30 },
  { value: 'medium', label: '30–45 min', test: (m) => m >= 30 && m <= 45 },
  { value: 'long', label: 'Over 45 min', test: (m) => m > 45 }
]

export const EPISODES_BUCKETS: Bucket[] = [
  { value: 'short', label: 'Under 13 episodes', test: (n) => n < 13 },
  { value: 'medium', label: '13–26 episodes', test: (n) => n >= 13 && n <= 26 },
  { value: 'long', label: '26+ episodes', test: (n) => n > 26 }
]

export const RATING_THRESHOLDS = [
  { value: '9', label: '9+' },
  { value: '8', label: '8+' },
  { value: '7', label: '7+' },
  { value: '6', label: '6+' }
]

export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'trending', label: 'Trending' },
  { value: 'title-asc', label: 'Title (A–Z)' },
  { value: 'year-desc', label: 'Newest' },
  { value: 'rating-desc', label: 'Top Rated' }
]

export const RUNTIME_SORT_OPTIONS: { value: SortKey; label: string }[] = [
  ...SORT_OPTIONS,
  { value: 'runtime-asc', label: 'Shortest Runtime' },
  { value: 'runtime-desc', label: 'Longest Runtime' }
]

/**
 * Whether a MediaItem belongs on a given category page. Real backend items
 * always carry `mediaKind` (set by catalogItemToMediaItem) and match
 * exactly. Mock fallback items only carry `mediaKind` when the mock data
 * explicitly tagged it as anime (see mockData.ts's `anime()` helper) — a
 * plain mock movie/series item has no `mediaKind` at all, so it falls back
 * to `mediaType`, which has no 'anime' member. That asymmetry is
 * deliberate: a mock series item must never leak onto the Anime page just
 * because `mediaType` can't tell the two apart.
 */
export function matchesCategoryKind(media: MediaItem, kind: CategoryKind): boolean {
  if (media.mediaKind) return media.mediaKind === kind
  if (kind === 'anime') return false
  return media.mediaType === kind
}

/** Every genre actually present in this pool, so filter options never offer a choice that would return zero results. */
export function availableGenres(items: MediaItem[]): string[] {
  const set = new Set<string>()
  for (const item of items) for (const g of item.genres) if (g) set.add(g)
  return Array.from(set).sort((a, b) => a.localeCompare(b))
}

/** Every release year actually present in this pool, newest first. */
export function availableYears(items: MediaItem[]): number[] {
  const set = new Set<number>()
  for (const item of items) if (item.releaseYear) set.add(item.releaseYear)
  return Array.from(set).sort((a, b) => b - a)
}

/** Every status string actually present in this pool (series/anime). */
export function availableStatuses(items: MediaItem[]): string[] {
  const set = new Set<string>()
  for (const item of items) if (item.status) set.add(item.status)
  return Array.from(set).sort((a, b) => a.localeCompare(b))
}

/** Just the watched/completed/disliked predicate, factored out so search
 *  results (which bypass every other category filter — genre/year/rating
 *  etc. don't apply to a search query) can still respect these three. */
export function applyWatchStateFilters(
  items: MediaItem[],
  filters: Pick<CategoryFilterState, 'hideWatched' | 'hideCompleted' | 'hideDisliked'>
): MediaItem[] {
  return items.filter((item) => {
    if (filters.hideWatched && item.watched) return false
    if (filters.hideCompleted && item.completed) return false
    if (filters.hideDisliked && item.disliked) return false
    return true
  })
}

export function applyCategoryFilters(
  items: MediaItem[],
  filters: CategoryFilterState
): MediaItem[] {
  return applyWatchStateFilters(items, filters).filter((item) => {
    if (filters.genre && !item.genres.includes(filters.genre)) return false
    if (filters.year && String(item.releaseYear ?? '') !== filters.year) return false
    if (filters.minRating != null && (item.communityRating ?? 0) < filters.minRating) return false

    if (filters.runtimeBucket) {
      const bucket = RUNTIME_BUCKETS.find((b) => b.value === filters.runtimeBucket)
      if (!bucket || item.runtimeMinutes == null || !bucket.test(item.runtimeMinutes)) return false
    }
    if (filters.seasonsBucket) {
      const bucket = SEASONS_BUCKETS.find((b) => b.value === filters.seasonsBucket)
      if (!bucket || item.totalSeasons == null || !bucket.test(item.totalSeasons)) return false
    }
    if (filters.episodeLengthBucket) {
      const bucket = EPISODE_LENGTH_BUCKETS.find((b) => b.value === filters.episodeLengthBucket)
      if (!bucket || item.runtimeMinutes == null || !bucket.test(item.runtimeMinutes)) return false
    }
    if (filters.episodesBucket) {
      const bucket = EPISODES_BUCKETS.find((b) => b.value === filters.episodesBucket)
      if (!bucket || item.totalEpisodes == null || !bucket.test(item.totalEpisodes)) return false
    }
    if (filters.status && item.status !== filters.status) return false

    return true
  })
}

export function sortMediaItems(items: MediaItem[], sort: SortKey): MediaItem[] {
  if (sort === 'trending') return items
  const arr = [...items]
  switch (sort) {
    case 'title-asc':
      arr.sort((a, b) => a.title.localeCompare(b.title))
      break
    case 'year-desc':
      arr.sort((a, b) => (b.releaseYear ?? 0) - (a.releaseYear ?? 0))
      break
    case 'rating-desc':
      arr.sort((a, b) => (b.communityRating ?? 0) - (a.communityRating ?? 0))
      break
    case 'runtime-asc':
      arr.sort((a, b) => (a.runtimeMinutes ?? 0) - (b.runtimeMinutes ?? 0))
      break
    case 'runtime-desc':
      arr.sort((a, b) => (b.runtimeMinutes ?? 0) - (a.runtimeMinutes ?? 0))
      break
  }
  return arr
}
