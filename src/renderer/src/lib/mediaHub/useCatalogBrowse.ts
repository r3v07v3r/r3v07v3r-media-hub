// The browse grid's data source, once the catalog stopped fitting in an
// array.
//
// Stages 1–2 of the title index put filter, sort and paging into SQL
// (catalog:query) precisely so this hook could exist: one page of sixty
// at a time, an exact `total` for the count the hero quotes, and the
// backend's own `completedIds` for the one badge whose denominator —
// aired episodes — lives only in the database. This is stage 3: the
// first renderer surface that reads the index instead of the in-memory
// catalog, which is what later stages need before that array can shrink.
//
// The rules this hook holds itself to:
//
//  - THE VIEW IS THE IDENTITY. kind + filters serialize to one key; any
//    change resets everything and fetches page zero. Within a view,
//    loadMore() appends — deduped by id, because a row can move between
//    pages when the underlying index shifts mid-scroll.
//  - EMPTY IS A CLAIM, LOADING IS NOT. On a first-ever run the index is
//    seeded by catalog:list, which may still be in flight. A `total` of
//    zero while this kind's catalog state is not yet 'live' reports as
//    loading, not as "nothing matches your filters" — and the query is
//    retried when the kind settles. An empty grid must mean empty.
//  - ADAPTATION IS THE CONTEXT'S JOB. Rows go through the context's
//    adaptCatalogItems so watched/list/disliked badges agree with every
//    other surface, and `completed` comes from the query result itself.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CatalogItem, CatalogQueryResult, MediaKind } from '@shared/media-hub/types'
import type { MediaItem } from '@renderer/types'
import type { CatalogKindState } from './hooks'
import { filterStateToCatalogQuery, type CategoryFilterState } from './categoryFilters'

export const BROWSE_PAGE_SIZE = 60

/** ensureItem's reach: how many pages beyond the current tail it will
 *  fetch hunting for a restore target before giving up. Five pages is
 *  three hundred titles — deeper than any real back-navigation, shallow
 *  enough that a stale id cannot trigger an unbounded crawl. */
const ENSURE_ITEM_MAX_PAGES = 5

export interface CatalogBrowseResult {
  items: MediaItem[]
  /** Exact size of the filtered result — the number the count labels
   *  quote. Zero only means "nothing matches" once `loading` is false. */
  total: number
  loading: boolean
  error: boolean
  hasMore: boolean
  loadMore: () => void
  /** Pages forward (bounded) until the id is present, for Back-restore.
   *  Resolves true when found, false when the cap ran out first. */
  ensureItem: (id: string) => Promise<boolean>
}

interface BrowseState {
  viewKey: string
  rows: CatalogItem[]
  completedIds: string[]
  total: number
  loading: boolean
  error: boolean
}

function freshBrowseState(viewKey: string): BrowseState {
  return { viewKey, rows: [], completedIds: [], total: 0, loading: true, error: false }
}

export function useCatalogBrowse(
  kind: MediaKind,
  filters: CategoryFilterState,
  kindState: CatalogKindState,
  adapt: (items: CatalogItem[], completedIds?: string[]) => MediaItem[],
  enabled = true
): CatalogBrowseResult {
  // One serialized identity for the view. filterStateToCatalogQuery is
  // the same mapping the fetch uses, so the key cannot disagree with
  // the query it stands for.
  const viewKey = useMemo(
    () => JSON.stringify(filterStateToCatalogQuery(kind, filters, { offset: 0, limit: 0 })),
    [kind, filters]
  )
  const [state, setState] = useState<BrowseState>(() => freshBrowseState(viewKey))
  // View changed: reset DURING RENDER — React's sanctioned adjustment
  // for derived state, and what keeps stale rows from flashing for a
  // frame between the filter change and an effect running.
  if (state.viewKey !== viewKey) setState(freshBrowseState(viewKey))
  const current = state.viewKey === viewKey ? state : freshBrowseState(viewKey)

  const inFlightRef = useRef(false)
  // Refs written from an effect, not during render — the lint rule is
  // right that render-time ref writes misbehave under concurrent React.
  const filtersRef = useRef(filters)
  useEffect(() => {
    filtersRef.current = filters
  }, [filters])

  const fetchPage = useCallback(
    async (offset: number): Promise<CatalogQueryResult | null> => {
      const api = window.api?.mediaHub?.catalog
      if (!api?.query) return null
      return api.query(
        filterStateToCatalogQuery(kind, filtersRef.current, { offset, limit: BROWSE_PAGE_SIZE })
      )
    },
    [kind]
  )

  // Fetch page zero for the (possibly just-reset) view. Re-runs when the
  // kind's catalog state settles, which is what turns "the index was
  // empty because nothing had seeded it yet" into a real answer without
  // anyone pressing anything.
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    fetchPage(0)
      .then((result) => {
        if (cancelled || !result) return
        setState({
          viewKey,
          rows: result.items,
          completedIds: result.completedIds,
          total: result.total,
          loading: false,
          error: false
        })
      })
      .catch(() => {
        if (cancelled) return
        setState((previous) =>
          previous.viewKey === viewKey ? { ...previous, loading: false, error: true } : previous
        )
      })
    return () => {
      cancelled = true
    }
  }, [viewKey, enabled, fetchPage, kindState])

  const stateRef = useRef(current)
  useEffect(() => {
    stateRef.current = current
  }, [current])

  const appendPage = useCallback(async (): Promise<CatalogQueryResult | null> => {
    const snapshot = stateRef.current
    if (inFlightRef.current || snapshot.viewKey !== viewKey || snapshot.loading) return null
    if (snapshot.rows.length >= snapshot.total) return null
    inFlightRef.current = true
    try {
      const result = await fetchPage(snapshot.rows.length)
      if (!result || stateRef.current.viewKey !== viewKey) return null
      const seen = new Set(snapshot.rows.map((row) => row.id))
      const fresh = result.items.filter((row) => !seen.has(row.id))
      setState((previous) =>
        previous.viewKey === viewKey
          ? {
              ...previous,
              rows: [...previous.rows, ...fresh],
              completedIds: [...previous.completedIds, ...result.completedIds],
              total: result.total
            }
          : previous
      )
      // The ref too, synchronously, so ensureItem's loop sees progress
      // without waiting for a re-render to write it back.
      stateRef.current = {
        ...snapshot,
        rows: [...snapshot.rows, ...fresh],
        total: result.total
      }
      return result
    } catch {
      setState((previous) =>
        previous.viewKey === viewKey ? { ...previous, error: true } : previous
      )
      return null
    } finally {
      inFlightRef.current = false
    }
  }, [fetchPage, viewKey])

  const loadMore = useCallback(() => {
    void appendPage()
  }, [appendPage])

  const ensureItem = useCallback(
    async (id: string): Promise<boolean> => {
      if (stateRef.current.rows.some((row) => row.id === id)) return true
      for (let page = 0; page < ENSURE_ITEM_MAX_PAGES; page++) {
        const result = await appendPage()
        if (!result) return false
        if (stateRef.current.rows.some((row) => row.id === id)) return true
      }
      return false
    },
    [appendPage]
  )

  const items = useMemo(
    () => adapt(current.rows, current.completedIds),
    [current.rows, current.completedIds, adapt]
  )

  return {
    items,
    total: current.total,
    // EMPTY IS A CLAIM, LOADING IS NOT: an empty answer while this
    // kind's catalog is still seeding reports as loading. The effect
    // above re-queries when the kind settles, so this resolves itself.
    loading: current.loading || (current.total === 0 && !current.error && kindState === 'loading'),
    error: current.error,
    hasMore: current.rows.length < current.total,
    loadMore,
    ensureItem
  }
}

/**
 * One number: how many titles of a kind the index holds, unfiltered —
 * the figure the hero's "in your library" line quotes. Exact however
 * deep the index grows, unlike counting a bounded in-memory array.
 * Refreshes when the kind's catalog state changes (a finished crawl is
 * exactly when the number moves).
 */
export function useCatalogKindTotals(
  kind: MediaKind,
  kindState: CatalogKindState,
  /** Bump to refetch on demand — the deep scan's completion is the one
   *  caller: it just grew the index, and the number should show it. */
  refreshToken = 0
): { total: number; completed: number } {
  const [totals, setTotals] = useState({ total: 0, completed: 0 })
  useEffect(() => {
    let cancelled = false
    const api = window.api?.mediaHub?.catalog
    if (!api?.query) return
    Promise.all([
      api.query({ kind, limit: 0 }),
      // Completed, by subtraction: the index can exclude completed rows
      // (hideCompleted is a first-class filter), so the completed count
      // is the whole minus the not-completed — no new backend needed.
      api.query({ kind, hideCompleted: true, limit: 0 })
    ])
      .then(([all, notCompleted]) => {
        if (cancelled) return
        setTotals({ total: all.total, completed: Math.max(0, all.total - notCompleted.total) })
      })
      .catch(() => {
        // Keep the previous figure — a transient failure should not blank
        // the hero.
      })
    return () => {
      cancelled = true
    }
  }, [kind, kindState, refreshToken])
  return totals
}
