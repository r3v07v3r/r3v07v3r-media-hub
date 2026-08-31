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

/** ensureItem's RUNAWAY GUARD, not its reach. The loop's real
 *  terminator is the honest end of the result set (appendPage returns
 *  null once the backend runs dry) — a Back-restore target must be
 *  reachable however deep the person actually scrolled, so no page
 *  budget smaller than the grid's own depth is defensible. What this
 *  bounds is the pathological case only: a STALE id hunting through an
 *  enormous filtered set would otherwise crawl it to the end. Two
 *  hundred pages is twelve thousand titles — past any real scroll
 *  depth, a fraction of a deep index. */
const ENSURE_ITEM_MAX_PAGES = 200

/** The backend clamps every query's limit to 500 (database.ts's
 *  indexQuery) — mirrored here so the in-place reload knows to page in
 *  chunks rather than asking for a 900-row window and getting 500. */
const BACKEND_QUERY_LIMIT = 500

/** Whether the Electron bridge exists at all. The supported non-Electron
 *  browser preview has no `window.api`; there the catalog hook falls
 *  back to mock data, and this hook's honest contribution is to report
 *  settled-and-empty so the page can use its array mode — never an
 *  eternal loading state no query will ever resolve. */
export const CATALOG_BRIDGE_AVAILABLE =
  typeof window !== 'undefined' && Boolean(window.api?.mediaHub?.catalog?.query)

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
  /** The BACKEND offset: rows requested so far, not rows displayed.
   *  Dedup can make the display shorter than what was fetched, and using
   *  the display length as the next offset re-reads the overlap — near
   *  the tail that can loop on a duplicate-only slice forever. */
  offset: number
  /** The backend returned an empty page — the honest end of this view,
   *  even if a shifted index leaves `total` claiming more. */
  end: boolean
  loading: boolean
  error: boolean
}

function freshBrowseState(viewKey: string): BrowseState {
  return {
    viewKey,
    rows: [],
    completedIds: [],
    total: 0,
    offset: 0,
    end: false,
    // Without a bridge there is nothing to load and never will be —
    // starting settled is what keeps the preview out of a forever-spinner.
    loading: CATALOG_BRIDGE_AVAILABLE,
    error: false
  }
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

  // WHICH view has an append in flight — a string key, not a boolean.
  // A boolean lock outlived its view: an append for the old filters kept
  // the ref true after a view change, the new view's sentinel request
  // was silently discarded, and completion only cleared the ref without
  // anything re-triggering the still-intersecting sentinel (observers
  // fire on transitions, not on standing state). Keyed by view, an
  // obsolete request never blocks the current view — its own writes were
  // always discarded by the viewKey guards anyway.
  const inFlightRef = useRef<string | null>(null)
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

  const stateRef = useRef(current)
  useEffect(() => {
    stateRef.current = current
  }, [current])

  // The in-place reload's generation counter. An append whose fetch
  // STARTED before the latest reload applied is discarded at completion
  // instead of merged — its snapshot base is gone, and the scroll
  // sentinel simply asks again against the fresh window. This is what
  // lets a reload run without waiting on appends, and appends without
  // locking out reloads.
  const reloadGenRef = useRef(0)
  // Reloads themselves are SERIALIZED on a promise chain, and each new
  // caller supersedes any reload still waiting in the queue — the answer
  // to several invalidations arriving back-to-back is one reload against
  // the final state, not a dropped one.
  const reloadQueueRef = useRef<Promise<void>>(Promise.resolve())
  // True while a reload's chunk walk is running. Appends asked for in
  // that window are refused AND remembered — the sentinel that asked
  // will not re-fire on its own (it is still intersecting; observers
  // report transitions), so the reload re-issues the append itself once
  // it has applied.
  const reloadingRef = useRef(false)
  const retryAppendRef = useRef(false)
  const appendPageRef = useRef<(() => Promise<CatalogQueryResult | null>) | null>(null)

  /** Queues a depth-preserving reload of the loaded window: same view,
   *  same depth, fresh SQL answer, fetched in BACKEND_QUERY_LIMIT chunks
   *  because the backend clamps per-query limits and a grid scrolled to
   *  900 rows must come back as 900 rows. Returns a cancel function that
   *  supersedes this reload if it has not started yet. */
  const queueReload = useCallback((): (() => void) => {
    let superseded = false
    reloadQueueRef.current = reloadQueueRef.current.then(async () => {
      if (superseded) return
      const snapshot = stateRef.current
      if (snapshot.viewKey !== viewKey || snapshot.loading) return
      const api = window.api?.mediaHub?.catalog
      if (!api?.query) return
      // Invalidate in-flight appends NOW, not at apply time. An append
      // that finished mid-reload used to merge (its generation still
      // matched), gain the user a page — and then the reload applied a
      // window sized from its own earlier snapshot, throwing that page
      // away and yanking the scroll backward. Bumping first means any
      // append racing this reload is discarded at completion, and the
      // depth the reload restores is exactly the depth it snapshotted.
      reloadGenRef.current += 1
      reloadingRef.current = true
      const wanted = Math.max(snapshot.rows.length, BROWSE_PAGE_SIZE)
      try {
        const rows: CatalogItem[] = []
        const completedIds: string[] = []
        const seen = new Set<string>()
        let offset = 0
        let total = 0
        let end = false
        while (rows.length < wanted && !end) {
          const asked = Math.min(BACKEND_QUERY_LIMIT, wanted - rows.length)
          const result = await api.query(
            filterStateToCatalogQuery(kind, filtersRef.current, {
              offset,
              limit: asked
            })
          )
          total = result.total
          offset += result.items.length
          // Short answer = ran dry; offset at total = done (see the
          // page-zero note).
          end = result.items.length < asked || offset >= total
          for (const row of result.items) {
            if (seen.has(row.id)) continue
            seen.add(row.id)
            rows.push(row)
          }
          completedIds.push(...result.completedIds)
        }
        if (superseded || stateRef.current.viewKey !== viewKey) return
        const next: BrowseState = {
          viewKey,
          rows,
          completedIds,
          total,
          offset,
          end,
          loading: false,
          error: false
        }
        setState(next)
        stateRef.current = next
      } catch {
        // Keep what is showing — badges already repainted through the
        // adapter, and the next invalidation retries.
      } finally {
        reloadingRef.current = false
        if (retryAppendRef.current) {
          retryAppendRef.current = false
          // The sentinel that was refused during the reload is still
          // intersecting and will not ask again — ask on its behalf.
          void appendPageRef.current?.()
        }
      }
    })
    return () => {
      superseded = true
    }
  }, [viewKey, kind])

  // Fetch page zero for the (possibly just-reset) view. Re-runs when the
  // kind's catalog state settles, which is what turns "the index was
  // empty because nothing had seeded it yet" into a real answer without
  // anyone pressing anything.
  useEffect(() => {
    if (!enabled || !CATALOG_BRIDGE_AVAILABLE) return
    // The kind settling under an ALREADY-POPULATED window is not a
    // reason to start over: a pre-existing index answers while a slow
    // crawl runs (anime especially), and a person can be hundreds of
    // rows deep by the time it finishes. Replace-with-page-zero is only
    // for a window that never got an answer; a populated one refreshes
    // at its current depth instead. (On a viewKey change the snapshot
    // still carries the OLD key, so this branch cannot swallow the
    // fresh view's page zero.)
    const settled = stateRef.current
    if (settled.viewKey === viewKey && !settled.loading && settled.rows.length > 0) {
      return queueReload()
    }
    let cancelled = false
    fetchPage(0)
      .then((result) => {
        if (cancelled || !result) return
        setState({
          viewKey,
          rows: result.items,
          completedIds: result.completedIds,
          total: result.total,
          offset: result.items.length,
          // A SHORT page is the end, not just an empty one — the backend
          // fills every page it can, so fewer rows than asked means it
          // ran dry. So is the offset reaching the total. Waiting for an
          // empty confirming page would need the already-intersecting
          // sentinel to fire again, which observers only do on
          // transitions; `end` is what stops the grid from mounting a
          // loading sentinel forever.
          end: result.items.length < BROWSE_PAGE_SIZE || result.items.length >= result.total,
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
  }, [viewKey, enabled, fetchPage, kindState, queueReload])

  const appendPage = useCallback(async (): Promise<CatalogQueryResult | null> => {
    const snapshot = stateRef.current
    if (snapshot.viewKey !== viewKey || snapshot.loading) return null
    if (snapshot.end || snapshot.rows.length >= snapshot.total) return null
    if (reloadingRef.current) {
      // A reload owns the window right now. Refuse — but remember, so
      // the reload re-issues this append when it finishes (the sentinel
      // will not re-fire by itself).
      retryAppendRef.current = true
      return null
    }
    if (inFlightRef.current === viewKey) return null
    inFlightRef.current = viewKey
    const generation = reloadGenRef.current
    try {
      // Paged by the BACKEND offset — what was requested, not what
      // survived dedup — so an index shifting between requests skips the
      // overlap instead of re-reading it (see BrowseState.offset).
      const result = await fetchPage(snapshot.offset)
      if (!result || stateRef.current.viewKey !== viewKey) return null
      // A reload replaced the window while this page was in flight: the
      // snapshot this fetch was based on no longer exists. Discard — but
      // the sentinel that asked is still intersecting and will NOT ask
      // again, so the retry is scheduled here: remembered for the reload
      // to re-issue if one is still running, or re-queued directly (as a
      // microtask, so it runs after this call's finally releases the
      // lock) when the reload already finished before this fetch landed.
      if (reloadGenRef.current !== generation) {
        if (reloadingRef.current) retryAppendRef.current = true
        else
          queueMicrotask(() => {
            void appendPageRef.current?.()
          })
        return null
      }
      const seen = new Set(snapshot.rows.map((row) => row.id))
      const fresh = result.items.filter((row) => !seen.has(row.id))
      const nextOffset = snapshot.offset + result.items.length
      // Two ways a view ends, both learned from the same stalled
      // sentinel: a SHORT page (the backend ran dry mid-page), and the
      // backend OFFSET reaching the total (a full terminal page whose
      // overlap deduped the display below the total — the confirming
      // empty request would need an intersection transition that never
      // comes). Either way, done is done.
      const end = result.items.length < BROWSE_PAGE_SIZE || nextOffset >= result.total
      setState((previous) =>
        previous.viewKey === viewKey
          ? {
              ...previous,
              rows: [...previous.rows, ...fresh],
              completedIds: [...previous.completedIds, ...result.completedIds],
              total: result.total,
              offset: nextOffset,
              end
            }
          : previous
      )
      // The ref too, synchronously, so ensureItem's loop sees progress
      // without waiting for a re-render to write it back.
      stateRef.current = {
        ...snapshot,
        rows: [...snapshot.rows, ...fresh],
        total: result.total,
        offset: nextOffset,
        end
      }
      return end ? null : result
    } catch {
      setState((previous) =>
        previous.viewKey === viewKey ? { ...previous, error: true } : previous
      )
      return null
    } finally {
      // Release only OUR view's lock — a newer view may already hold it.
      if (inFlightRef.current === viewKey) inFlightRef.current = null
    }
  }, [fetchPage, viewKey])

  // The reload's retry path calls appendPage through a ref (it is
  // declared later than queueReload, and a direct dependency would just
  // rebuild the queue callback on every append identity change).
  useEffect(() => {
    appendPageRef.current = appendPage
  }, [appendPage])

  // WATCH-STATE AND PROFILE CHANGES reach the SQL through the adapter's
  // own identity: adaptCatalogItems is rebuilt whenever the watched/list/
  // disliked/ratings sets change, and all of those reload on a profile
  // switch. The rows and total on show, though, were computed by SQL
  // against the OLD state — completedIds, the hide-filters' membership
  // and the total would all stay stale until the view identity changed.
  // So a changed adapter reloads the loaded window IN PLACE: same view,
  // same depth, fresh answer — stale-while-revalidate, never a collapse
  // back to page zero mid-scroll.
  //
  // Two discipline points, both learned from review:
  //  - reloads QUEUE rather than early-return. Profile switches resolve
  //    watch history, dislikes and My List independently, so the adapter
  //    changes several times in quick succession; dropping any of those
  //    invalidations leaves the previous profile's grid on show. Each
  //    effect run supersedes queued-but-unstarted predecessors and the
  //    last adapter always gets its reload.
  //  - the window is refetched in CHUNKS of BACKEND_QUERY_LIMIT. The
  //    backend clamps per-query limits, and a grid scrolled to 900 rows
  //    must come back as 900 rows, not collapse to one clamped page.
  const adaptRef = useRef(adapt)
  useEffect(() => {
    if (adaptRef.current === adapt) return
    adaptRef.current = adapt
    if (!enabled || !CATALOG_BRIDGE_AVAILABLE) return
    return queueReload()
  }, [adapt, enabled, queueReload])

  const loadMore = useCallback(() => {
    void appendPage()
  }, [appendPage])

  const ensureItem = useCallback(
    async (id: string): Promise<boolean> => {
      if (stateRef.current.rows.some((row) => row.id === id)) return true
      for (let page = 0; page < ENSURE_ITEM_MAX_PAGES; page++) {
        const result = await appendPage()
        // Found-check BEFORE the null-check: the final page of a view is
        // short, and appendPage reports it as null-with-rows-merged — a
        // target sitting on that very page must still count as found.
        if (stateRef.current.rows.some((row) => row.id === id)) return true
        if (!result) return false
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
    hasMore: !current.end && current.rows.length < current.total,
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
  /** Any value whose identity tracks watch-state/profile changes — the
   *  page passes its adaptCatalogItems, for the same reason the browse
   *  hook watches it: `completed` is profile-specific, and a hero
   *  quoting the previous profile's count until remount is a lie. */
  revision: unknown = null
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
  }, [kind, kindState, revision])
  return totals
}
