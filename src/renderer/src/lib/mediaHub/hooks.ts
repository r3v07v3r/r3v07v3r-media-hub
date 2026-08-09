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

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CatalogItem, HistoryEntry, MediaKind } from '@shared/media-hub/types'
import type { MediaItem, Recommendation } from '@renderer/types'
import { CATALOG } from '@renderer/data/mockData'
import {
  catalogItemToMediaItem,
  catalogItemToRecommendation,
  continueWatchingEntryToItem
} from './adapters'

const CATALOG_KINDS: MediaKind[] = ['movie', 'series', 'anime']

// Module-level so the optional parameters below default to a STABLE
// identity. A `= []` / `= new Set()` default constructs a fresh value on
// every call, which would silently defeat the memo it feeds — the kind of
// thing that reintroduces a fixed bug by way of an innocent-looking new
// call site.
const NO_HISTORY: HistoryEntry[] = []
const NO_IDS: Set<string> = new Set()

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
  /** True once the initial fetch has settled (succeeded or failed) at
   *  least once — lets a consumer tell "still loading for the first time"
   *  apart from "loading again because refresh() was just called", since
   *  both report `loading: true` the same way. */
  settled: boolean
  /** Re-runs catalog:list across all three kinds — the retry action for
   *  category pages' "couldn't reach the backend" error state (spec:
   *  "retry-capable error states"), and generally for anything that wants
   *  a fresh pull without a full remount. */
  refresh: () => void
}

/**
 * The flat "browse everything" pool backing mood filtering, My Stuff, and
 * the Movies/Series/Anime category pages — mirrors mockData.ts's CATALOG
 * (movies + series + anime merged), but fetched from the real catalog:list
 * handler across all three kinds. Falls back to the mock CATALOG while
 * loading fails/is unavailable, so mood browsing and My List never go
 * blank — `live` tells a consumer which source it's actually looking at,
 * so a page can say so honestly instead of presenting the fallback as
 * real data.
 */
export function useMediaHubBrowseCatalog(
  trackedIds: Set<string>,
  watchedIds: Set<string>,
  history: HistoryEntry[] = NO_HISTORY,
  dislikedIds: Set<string> = NO_IDS
): BrowseCatalogResult {
  const [items, setItems] = useState<CatalogItem[] | null>(null)
  // Lazily derived from bridge presence (a constant for this component's
  // lifetime, not something that changes across renders) rather than
  // started `true` and flipped `false` in the effect below — keeps the
  // "no bridge" case out of the effect entirely instead of a synchronous
  // setState purely to undo the initial value.
  const [loading, setLoading] = useState(() => Boolean(window.api?.mediaHub))
  const [settled, setSettled] = useState(() => !window.api?.mediaHub)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    let cancelled = false
    const api = window.api?.mediaHub
    if (!api) return
    // Unlike the mount-only version this replaced, this effect also
    // re-runs whenever refresh() bumps `generation` — so past the first
    // run this is a real "a retry just started" transition, not a
    // redundant re-assertion of the lazy initial value.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    Promise.all(CATALOG_KINDS.map((kind) => api.catalog.list(kind, generation > 0).catch(() => [])))
      .then((groups) => {
        if (cancelled) return
        setItems(dedupeById(groups.flat()))
      })
      .catch(() => {
        if (!cancelled) setItems(null)
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
          setSettled(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [generation])

  const refresh = useCallback(() => setGeneration((g) => g + 1), [])

  // Memoised, and NOT computed inline in the return below. This mapping
  // used to run on every render, handing back a brand-new array each time
  // — which made AppStateContext's own context-value useMemo useless
  // (`browseCatalog.items` is one of its dependencies, so it "changed" on
  // every render) and pushed a new `catalog` identity to every consumer.
  //
  // That was a real, visible bug, not just wasted work: CategoryPage
  // derives kindItems -> filteredSorted from `catalog`, and MediaGrid
  // resets its lazy reveal batch back to 30 whenever the `items` prop is a
  // new array. So any unrelated app state change — opening a card's
  // context menu, a toast appearing — collapsed a grid the person had
  // scrolled hundreds of cards into back down to one batch, and the
  // browser clamped the now-impossible scroll position. It read as the
  // page flashing and jumping upward.
  //
  // Every dependency here is genuinely stable: `items` is useState, and
  // the caller's arguments are useState values or module constants (see
  // EMPTY_HOME_FEED and NO_HISTORY/NO_IDS above, which is why the
  // defaults are hoisted). So this recomputes when the data actually
  // changes and not otherwise.
  const mapped = useMemo(
    () =>
      items?.length
        ? items.map((item) =>
            catalogItemToMediaItem(item, { trackedIds, watchedIds, history, dislikedIds })
          )
        : null,
    [items, trackedIds, watchedIds, history, dislikedIds]
  )

  return useMemo(
    () =>
      mapped
        ? { items: mapped, loading, live: true, settled, refresh }
        : { items: CATALOG, loading, live: false, settled, refresh },
    [mapped, loading, settled, refresh]
  )
}

export interface WatchedIdsResult {
  /** ids with at least one tracking:list history entry — see
   *  CatalogItemAdapterContext's own doc comment in adapters.ts for what
   *  this does and doesn't distinguish (a movie's binary watched/unwatched,
   *  vs. a series/anime's "at least one episode watched," which reads as
   *  "completed" once it's no longer sitting in Continue Watching — see
   *  lib/mediaHub/watchStatus.ts, the one place that combines the two). */
  watchedIds: Set<string>
  /** The raw per-episode history behind watchedIds above — needed wherever
   *  a series/anime's real completion state (every aired episode watched,
   *  not just "started") has to be computed, since a flat id set can't
   *  tell that apart. See adapters.ts's isSeriesCompleted. */
  history: HistoryEntry[]
  refresh: () => void
}

/**
 * tracking:list's history, reduced to just the id set every catalog-sourced
 * MediaItem needs for its watched/completed badge (see
 * CatalogItemAdapterContext.watchedIds) — a separate hook from
 * useMediaHubHomeFeed because this is a flat, kind-agnostic id lookup
 * (Movies/Series/Anime grids and My Stuff all need it), not part of the
 * Home-specific personalized feed.
 */
export function useMediaHubWatchedIds(): WatchedIdsResult {
  const [watchedIds, setWatchedIds] = useState<Set<string>>(new Set())
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    let cancelled = false
    const api = window.api?.mediaHub
    if (!api) return
    api.tracking
      .list()
      .then((result) => {
        if (cancelled) return
        setWatchedIds(new Set(result.history.map((h) => h.id)))
        setHistory(result.history)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [generation])

  // Stable `refresh` and a memoised result object, for the same reason
  // useMediaHubBrowseCatalog above memoises its own: AppStateContext holds
  // this whole object in a useCallback dependency array
  // (`refreshWatchStatus`), which in turn sits in the context value's
  // dependency array — a fresh object here defeated both.
  const refresh = useCallback(() => setGeneration((g) => g + 1), [])
  return useMemo(() => ({ watchedIds, history, refresh }), [watchedIds, history, refresh])
}

export interface DislikedIdsResult {
  dislikedIds: Set<string>
  refresh: () => void
}

/**
 * disliked:list's ids, reduced the same way useMediaHubWatchedIds reduces
 * tracking:list's history — a flat, kind-agnostic lookup every catalog-
 * sourced MediaItem needs for its `disliked` field (see
 * CatalogItemAdapterContext.dislikedIds).
 */
export function useMediaHubDislikedIds(): DislikedIdsResult {
  const [dislikedIds, setDislikedIds] = useState<Set<string>>(new Set())
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    let cancelled = false
    const api = window.api?.mediaHub
    if (!api) return
    api.disliked
      .list()
      .then((result) => {
        if (cancelled) return
        setDislikedIds(new Set(result.disliked.map((d) => d.id)))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [generation])

  const refresh = useCallback(() => setGeneration((g) => g + 1), [])
  return useMemo(() => ({ dislikedIds, refresh }), [dislikedIds, refresh])
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

  const refresh = useCallback(() => setGeneration((g) => g + 1), [])
  return useMemo(
    () => ({
      ...(state ?? EMPTY_HOME_FEED),
      loading,
      live: state !== null,
      refresh
    }),
    [state, loading, refresh]
  )
}
