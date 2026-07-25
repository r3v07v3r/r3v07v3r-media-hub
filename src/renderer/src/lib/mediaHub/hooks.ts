// Real-backend data hooks for the media-hub integration, following this
// codebase's existing pattern (see src/renderer/src/hooks/
// usePerformanceMetrics.ts): fetch once via window.api, guard against
// setting state after unmount, and degrade gracefully — never throw —
// when window.api.mediaHub is absent (non-Electron preview) or a call
// fails, so "keep the dashboard visible" (see AppStateContext) holds even
// offline/before TorBox is connected. `live` mirrors this codebase's
// ClientResult convention: true only once real backend data has actually
// loaded; false (with a mock/empty fallback) otherwise — the UI is never
// meant to silently present mock data as if it were live.

import { useEffect, useState } from 'react'
import type { CatalogItem, MediaKind } from '@shared/media-hub/types'
import type { MediaItem, Recommendation } from '@renderer/types'
import { CATALOG } from '@renderer/data/mockData'
import {
  catalogItemToMediaItem,
  catalogItemToRecommendation,
  continueWatchingEntryToItem
} from './adapters'

const CATALOG_KINDS: MediaKind[] = ['movie', 'series', 'anime']

function dedupeById(items: CatalogItem[]): CatalogItem[] {
  const seen = new Set<string>()
  const out: CatalogItem[] = []
  for (const item of items) {
    if (!item.id || seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}

export interface BrowseCatalogResult {
  items: MediaItem[]
  loading: boolean
  live: boolean
}

/**
 * The flat "browse everything" pool backing mood filtering and My Stuff —
 * mirrors mockData.ts's CATALOG (movies + series + anime merged), but
 * fetched from the real catalog:list handler across all three kinds. Falls
 * back to the mock CATALOG while loading fails/is unavailable, so mood
 * browsing and My List never go blank.
 */
export function useMediaHubBrowseCatalog(trackedIds: Set<string>): BrowseCatalogResult {
  const [items, setItems] = useState<CatalogItem[] | null>(null)
  // Lazily derived from bridge presence (a constant for this component's
  // lifetime, not something that changes across renders) rather than
  // started `true` and flipped `false` in the effect below — keeps the
  // "no bridge" case out of the effect entirely instead of a synchronous
  // setState purely to undo the initial value.
  const [loading, setLoading] = useState(() => Boolean(window.api?.mediaHub))

  useEffect(() => {
    let cancelled = false
    const api = window.api?.mediaHub
    if (!api) return
    // No setLoading(true) here: this effect has an empty dep array (runs
    // once, on mount), and the lazy initializer above already set loading
    // to true for exactly this case (api present) — nothing to re-trigger.
    Promise.all(CATALOG_KINDS.map((kind) => api.catalog.list(kind).catch(() => [])))
      .then((groups) => {
        if (cancelled) return
        setItems(dedupeById(groups.flat()))
      })
      .catch(() => {
        if (!cancelled) setItems(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (items && items.length) {
    return {
      items: items.map((item) => catalogItemToMediaItem(item, { trackedIds })),
      loading,
      live: true
    }
  }
  return { items: CATALOG, loading, live: false }
}

export interface HomeFeedResult {
  continueWatching: ReturnType<typeof continueWatchingEntryToItem>[]
  recommendations: Recommendation[]
  featured: MediaItem[]
  preferredGenres: string[]
  trackedIds: Set<string>
  loading: boolean
  live: boolean
  /** Re-runs the home:personalized fetch — call after a mutation (mark watched, toggle tracking) that should move an item in/out of Continue Watching. */
  refresh: () => void
}

const EMPTY_HOME_FEED = {
  continueWatching: [] as ReturnType<typeof continueWatchingEntryToItem>[],
  recommendations: [] as Recommendation[],
  featured: [] as MediaItem[],
  preferredGenres: [] as string[],
  trackedIds: new Set<string>()
}

/**
 * home:personalized in one hook — Continue Watching, recommendations, and
 * a "featured" pool (this dashboard's hero-rotation concept, which the
 * backend has no equivalent of; the top few recommendations stand in for
 * it here). No mock fallback data for continueWatching/recommendations
 * (an empty state is honest — mockData.ts's CONTINUE_WATCHING/AI_PICKS
 * are just placeholder demo content, not something to blend with real
 * data); `live: false` signals callers to show their own mock fallback
 * where one exists (e.g. FeaturedHero keeps FEATURED_ITEMS).
 */
export function useMediaHubHomeFeed(): HomeFeedResult {
  const [state, setState] = useState<typeof EMPTY_HOME_FEED | null>(null)
  // See useMediaHubBrowseCatalog above for why this is a lazy initializer
  // rather than an effect-driven flip.
  const [loading, setLoading] = useState(() => Boolean(window.api?.mediaHub))
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    let cancelled = false
    const api = window.api?.mediaHub
    if (!api) return
    // Unlike useMediaHubBrowseCatalog, this effect re-runs on every
    // `refresh()` call (generation changes) — so, past the first run, this
    // setState is a real "a refetch just started" transition, not a
    // redundant re-assertion of the initial value.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    api.home
      .personalized()
      .then((result) => {
        if (cancelled) return
        const trackedIds = new Set(result.tracked.map((t) => t.id))
        setState({
          continueWatching: result.continueWatching.map(continueWatchingEntryToItem),
          recommendations: result.recommendations.map((item) =>
            catalogItemToRecommendation(item, result.preferredGenres, { trackedIds })
          ),
          featured: result.recommendations
            .slice(0, 6)
            .map((item) => catalogItemToMediaItem(item, { trackedIds })),
          preferredGenres: result.preferredGenres,
          trackedIds
        })
      })
      .catch(() => {
        if (!cancelled) setState(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [generation])

  return {
    ...(state ?? EMPTY_HOME_FEED),
    loading,
    live: state !== null,
    refresh: () => setGeneration((g) => g + 1)
  }
}
