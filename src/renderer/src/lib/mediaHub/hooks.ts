// Real-backend data hooks for the media-hub integration, following this
// codebase's existing pattern (see src/renderer/src/hooks/
// usePerformanceMetrics.ts): fetch once via window.api, guard against
// setting state after unmount, and degrade gracefully — never throw —
// when window.api.mediaHub is absent (non-Electron preview) or a call
// fails, so "keep the dashboard visible" (see AppStateContext) holds even
// offline/before TorBox is connected. `live` mirrors this codebase's
// ClientResult convention: true only once real backend data has actually
// loaded; false (with a remembered/empty fallback) otherwise — the UI is
// never meant to silently present stale or mock data as if it were live.
//
// What `live: false` falls back TO changed: it used to be mockData.ts's
// demo pools, which is why every cold start opened on Blade Runner 2049
// and Interstellar regardless of what the person actually watches. It is
// now the previous session's real data (startupSnapshot.ts), and the mock
// pools survive only for the non-Electron preview build — the browser
// harness used for visual QA/screenshots, which has no bridge to get real
// data from and no snapshot to have written one. In the app itself,
// "nothing remembered yet" renders a skeleton rather than someone else's
// taste in films.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CatalogItem, HistoryEntry, MediaKind, PlayRecord } from '@shared/media-hub/types'
import type { ContinueWatchingItem, MediaItem, Recommendation } from '@renderer/types'
import { AI_PICKS, CATALOG, CONTINUE_WATCHING, FEATURED_ITEMS } from '@renderer/data/mockData'
import {
  catalogItemToMediaItem,
  indexHistoryById,
  catalogItemToRecommendation,
  continueWatchingEntryToItem
} from './adapters'
import {
  applyTrackingState,
  mergeRememberedCatalog,
  rememberCatalog,
  rememberHomeFeed,
  rememberedCatalog,
  rememberedHomeFeed,
  type ResolvedKind
} from './startupSnapshot'

const CATALOG_KINDS: MediaKind[] = ['movie', 'series', 'anime']

// Module-level so the optional parameters below default to a STABLE
// identity. A `= []` / `= new Set()` default constructs a fresh value on
// every call, which would silently defeat the memo it feeds — the kind of
// thing that reintroduces a fixed bug by way of an innocent-looking new
// call site.
const NO_HISTORY: HistoryEntry[] = []
const NO_IDS: Set<string> = new Set()
const NO_ITEMS: MediaItem[] = []

const EMPTY_HOME_FEED = {
  continueWatching: [] as ContinueWatchingItem[],
  recommendations: [] as Recommendation[],
  featured: [] as MediaItem[],
  preferredGenres: [] as string[],
  trackedIds: new Set<string>()
}

/** True in the real (Electron) app, false in the plain-browser preview build used for visual QA. */
function hasBridge(): boolean {
  return Boolean(window.api?.mediaHub)
}

// Resolved once per session, not per render: what the snapshot held at
// startup is a fixed fact for this run (later writes are for the NEXT
// launch), and a fresh array identity here would churn every memo
// downstream of `catalog` — see the mapped/useMemo comment below for how
// expensive that particular churn turned out to be.
let browseFallback: MediaItem[] | null = null
function startupCatalogFallback(): MediaItem[] {
  if (!browseFallback) {
    const remembered = rememberedCatalog()
    browseFallback = remembered.length ? remembered : hasBridge() ? NO_ITEMS : CATALOG
  }
  return browseFallback
}

// The single place the "remembered, else mock, else nothing" decision is
// made. Keeping it here rather than in each consumer is deliberate: the
// bug this fixes existed because three components each made that call
// independently and all three defaulted to the demo pools.
let homeFeedFallback: typeof EMPTY_HOME_FEED | null = null
function startupHomeFeedFallback(): typeof EMPTY_HOME_FEED {
  if (!homeFeedFallback) {
    const remembered = rememberedHomeFeed()
    const bridge = hasBridge()
    homeFeedFallback = {
      ...EMPTY_HOME_FEED,
      featured: remembered.featured.length
        ? remembered.featured
        : bridge
          ? EMPTY_HOME_FEED.featured
          : FEATURED_ITEMS,
      recommendations: remembered.recommendations.length
        ? remembered.recommendations
        : bridge
          ? EMPTY_HOME_FEED.recommendations
          : AI_PICKS,
      continueWatching: remembered.continueWatching.length
        ? remembered.continueWatching
        : bridge
          ? EMPTY_HOME_FEED.continueWatching
          : CONTINUE_WATCHING,
      preferredGenres: remembered.preferredGenres,
      // This used to stay empty, on the reasoning that a remembered set is
      // a claim about server state nothing has re-checked. That was wrong,
      // and destructively so: an EMPTY set is also a claim — that nothing
      // is in My List — and it is the one that is definitely false. My
      // List controls read `myList.has(id)`, so every remembered title
      // rendered with an Add affordance, and pressing it called the
      // backend's *toggle*, which removed a title the person had saved.
      // The last known truth, corrected the moment `live` lands, beats a
      // confident falsehood that loses data on click.
      trackedIds: new Set(remembered.trackedIds)
    }
  }
  return homeFeedFallback
}

/** The remembered Continue Watching row, for AppStateContext's own copy of that state. */
export function startupContinueWatchingFallback(): ContinueWatchingItem[] {
  return startupHomeFeedFallback().continueWatching
}

/** The remembered My List ids, for AppStateContext's own copy of that state. */
export function startupTrackedIdsFallback(): Set<string> {
  return startupHomeFeedFallback().trackedIds
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    if (!item.id || seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}

/**
 * Per kind, because the three catalog:list calls succeed and fail
 * independently — 'loading' until that kind answers, then 'live' or
 * 'failed'. A single global flag could not express "movies are fine,
 * anime is down", which is the state a person on the Anime page needs
 * told about.
 */
export type CatalogKindState = 'loading' | 'live' | 'failed'

export interface BrowseCatalogResult {
  items: MediaItem[]
  loading: boolean
  /** See CatalogKindState. Always has an entry for every kind.
   *
   *  This replaced a pair of global `live`/`settled` booleans. They could
   *  not say "movies are fine, anime is down" — and because the three
   *  kinds are fetched independently, that is the common failure, not an
   *  exotic one. A successful Movies fetch was flipping `live` true and
   *  silently vouching for a failed Anime one. */
  kindStates: Record<MediaKind, CatalogKindState>
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
 * handler across all three kinds. Falls back to the previous session's
 * remembered catalog (startupSnapshot.ts) while the fetch is out or has
 * failed, so mood browsing and My List never go blank — per kind, not
 * all-or-nothing, since the three kinds no longer land together.
 *
 * `items` is therefore a mix while any kind is still out: this run's rows
 * for the kinds that have answered, remembered ones for the kinds that
 * have not. `kindStates` is how a consumer tells which is which, and it
 * is deliberately the only availability signal here — see its own doc.
 */
export function useMediaHubBrowseCatalog(
  trackedIds: Set<string>,
  watchedIds: Set<string>,
  history: HistoryEntry[] = NO_HISTORY,
  dislikedIds: Set<string> = NO_IDS,
  /** Whether the two sets above have actually been read yet — see
   *  WatchedIdsResult.loaded. Only consulted for the REMEMBERED rows,
   *  where an unread set has a previous answer to preserve; a live row has
   *  no such history and is mapped from the sets as they stand. */
  loaded: { watched?: boolean; disliked?: boolean } = {}
): BrowseCatalogResult {
  // Kept per kind rather than as one merged array, because the three
  // fetches are no longer awaited together (see the effect below).
  const [groups, setGroups] = useState<Partial<Record<MediaKind, CatalogItem[]>>>({})
  // Answered-or-not, per kind, tracked separately from the rows above
  // because "returned nothing" and "never returned" are different facts
  // and only one of them is worth offering someone a Retry over.
  const [outcomes, setOutcomes] = useState<Partial<Record<MediaKind, 'live' | 'failed'>>>({})
  // Which `generation` last delivered rows for each kind. `groups` cannot
  // answer that: it deliberately retains a kind's rows across a refresh
  // that failed, so its mere presence says the rows exist, not that
  // anything re-fetched them.
  const [deliveries, setDeliveries] = useState<
    Partial<Record<MediaKind, { generation: number; at: number }>>
  >({})
  // Lazily derived from bridge presence (a constant for this component's
  // lifetime, not something that changes across renders) rather than
  // started `true` and flipped `false` in the effect below — keeps the
  // "no bridge" case out of the effect entirely instead of a synchronous
  // setState purely to undo the initial value.
  const [loading, setLoading] = useState(() => Boolean(window.api?.mediaHub))
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
    // A retry genuinely is 'loading' again for every kind, so the banner
    // and error states clear while it runs rather than sitting there
    // asserting a failure that is currently being re-tested. The rows in
    // `groups` are deliberately NOT cleared alongside them.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOutcomes({})
    // Deliberately NOT a Promise.all over the three kinds any more. The
    // anime crawl (catalog.ts's kitsuCatalog walks Kitsu 1000 entries
    // deep, throttled) routinely takes an order of magnitude longer than
    // the two Simkl feeds, and awaiting them together meant movies and
    // series — already parsed, already in hand — sat invisible behind it
    // while the Movies page showed a placeholder grid. Each kind is
    // published the moment it lands; `loading`/`settled` still describe
    // the whole set, so nothing downstream has to learn about kinds.
    let remaining = CATALOG_KINDS.length
    for (const kind of CATALOG_KINDS) {
      api.catalog
        .list(kind, generation > 0)
        .then(
          (result) => {
            if (cancelled) return
            const rows = result?.items
            // Main answers with rows from an EXPIRED cache when every live
            // source failed — real titles, but nothing fetched them (see
            // CatalogListing). Treated as the failure it is: the offline
            // banner belongs on a kind whose sources are all down, and
            // dating these rows to now would renew rows of unknown age
            // every launch, indefinitely. They are still published, since
            // they are the best this kind has.
            setOutcomes((prev) => ({ ...prev, [kind]: result?.stale ? 'failed' : 'live' }))
            // An empty kind leaves whatever that kind last had in place —
            // on a refresh that is the previous live data, which beats
            // blanking a populated grid over a momentary nothing.
            if (!rows?.length) return
            setGroups((prev) => ({ ...prev, [kind]: rows }))
            if (result?.stale) return
            // Which run these rows came from AND when, so freshness is
            // dated to the fetch that actually delivered them — see
            // `freshStamps`.
            setDeliveries((prev) => ({ ...prev, [kind]: { generation, at: Date.now() } }))
          },
          // Two-argument form, not a trailing .catch: a throw from the
          // success path above is a bug in this file, not a failed fetch,
          // and must not be recorded as one.
          () => {
            if (!cancelled) setOutcomes((prev) => ({ ...prev, [kind]: 'failed' }))
          }
        )
        .finally(() => {
          if (cancelled) return
          remaining -= 1
          if (remaining > 0) return
          setLoading(false)
        })
    }
    return () => {
      cancelled = true
    }
  }, [generation])

  const refresh = useCallback(() => setGeneration((g) => g + 1), [])

  const kindStates = useMemo(() => {
    const states = {} as Record<MediaKind, CatalogKindState>
    for (const kind of CATALOG_KINDS) states[kind] = outcomes[kind] ?? 'loading'
    return states
  }, [outcomes])

  const items = useMemo(() => {
    const merged = CATALOG_KINDS.flatMap((kind) => groups[kind] ?? [])
    return merged.length ? dedupeById(merged) : null
  }, [groups])

  // Two similar-looking sets that must not be conflated — they answer
  // different questions and were one set until that turned out to be a
  // bug.
  //
  // `heldKinds`: kinds we have rows for at all, whenever they arrived.
  // This is what the merge needs — a kind already represented in `items`
  // must not also have its remembered rows carried in on top.
  const heldKinds = useMemo(
    () => new Set<ResolvedKind>(CATALOG_KINDS.filter((kind) => groups[kind]?.length)),
    [groups]
  )

  // `freshStamps`: for the kinds THIS run delivered, the moment each
  // delivery actually landed. That is what freshness has to be dated
  // from. `groups` keeps a kind's rows across a refresh that failed for
  // it, so deriving freshness from `heldKinds` let a neighbour's
  // successful refresh re-date rows nothing had re-fetched — the dead
  // source stays "current" forever, one partial refresh at a time.
  //
  // Fixed timestamps rather than a set of kinds to stamp with "now" at
  // write time, for a second reason — see the persist effect below.
  const freshStamps = useMemo(() => {
    const stamps: Record<string, number> = {}
    for (const kind of CATALOG_KINDS) {
      const delivery = deliveries[kind]
      if (delivery?.generation === generation) stamps[kind] = delivery.at
    }
    return stamps
  }, [deliveries, generation])

  // Grouped once per history change rather than re-derived per item.
  // catalogItemToMediaItem's completion check would otherwise filter the
  // whole history for every entry — see CatalogItemAdapterContext.historyById.
  const historyById = useMemo(() => indexHistoryById(history), [history])

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
  // Every dependency here is genuinely stable: `items` is a memo over
  // useState, and the caller's arguments are useState values or module
  // constants (see EMPTY_HOME_FEED and NO_HISTORY/NO_IDS above, which is
  // why the defaults are hoisted). So this recomputes when the data
  // actually changes and not otherwise.
  const mapped = useMemo(
    () =>
      items?.length
        ? items.map((item) =>
            catalogItemToMediaItem(item, { trackedIds, watchedIds, historyById, dislikedIds })
          )
        : null,
    [items, trackedIds, watchedIds, historyById, dislikedIds]
  )

  // Live rows for the kinds that have answered, plus the remembered rows
  // for the kinds that have not — see mergeRememberedCatalog, which is
  // where the reasoning (and the bug it prevents) lives.
  // The remembered rows, brought up to date with this session's tracking
  // state. They were adapted when they were persisted, and nothing else
  // re-derives them — the live mapping above only covers rows the backend
  // returned this run — so without this a carried title kept last
  // session's watched/My List/disliked flags no matter what happened to it
  // since. See applyTrackingState, including what it deliberately cannot
  // restore.
  //
  // Skipped without a bridge, where the fallback is mockData's demo pool:
  // those rows' flags are authored demo state, not a stale reading of
  // anything, and the empty tracking sets would simply erase them.
  const rememberedItems = useMemo(() => {
    const remembered = startupCatalogFallback()
    if (!remembered.length || !hasBridge()) return remembered
    // A set is handed over only once it has been read. Passing it before
    // then would assert that nothing is watched and nothing is disliked,
    // which is not what an empty set fresh out of useState means — and
    // that assertion wiped every remembered badge on startup, kept it
    // wiped for the session if the read failed, and got persisted into the
    // next snapshot on the way past. `trackedIds` needs no such guard: it
    // is seeded from this same snapshot (see startupTrackedIdsFallback),
    // so it is established from the first render.
    const state = {
      trackedIds,
      watchedIds: loaded.watched ? watchedIds : undefined,
      dislikedIds: loaded.disliked ? dislikedIds : undefined
    }
    let changed = false
    const updated = remembered.map((item) => {
      const next = applyTrackingState(item, state)
      if (next !== item) changed = true
      return next
    })
    return changed ? updated : remembered
  }, [trackedIds, watchedIds, dislikedIds, loaded.watched, loaded.disliked])

  const catalog = useMemo(() => {
    if (!mapped) return rememberedItems
    return mergeRememberedCatalog(mapped, rememberedItems, heldKinds)
  }, [mapped, rememberedItems, heldKinds])

  // What the next cold start opens on. Written from the merged list rather
  // than the raw rows so the stored shape is the one the UI renders
  // directly, and re-written whenever a badge moves (marking something
  // watched changes `mapped`) so the remembered grid doesn't come back
  // with last week's badges on it. The write is deferred and coalesced —
  // see startupSnapshot.ts's WRITE_DELAY_MS.
  //
  // Guarded on `mapped`, not on `catalog`: with no bridge, `catalog` is
  // mockData's demo pool, and persisting THAT as this app's memory would
  // be the original bug wearing a new hat.
  useEffect(() => {
    // `freshStamps`, not `heldKinds` and not every kind in `catalog` —
    // see both definitions above. Only rows this run actually fetched may
    // be dated to this run.
    //
    // And it carries each delivery's own timestamp rather than letting
    // rememberCatalog reach for the clock, because this effect runs on
    // every `mapped` change — which includes every badge move: marking
    // watched, adding to My List, disliking. Stamping with "now" there
    // meant ordinary tracking activity re-dated catalog rows nothing had
    // re-fetched, keeping an old catalog inside MAX_AGE_MS indefinitely
    // across a long session. With fixed stamps, re-running this is
    // idempotent.
    if (mapped?.length) rememberCatalog(catalog, freshStamps)
  }, [mapped, catalog, freshStamps])

  return useMemo(
    () => ({ items: catalog, loading, kindStates, refresh }),
    [catalog, kindStates, loading, refresh]
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
  /** tracking:list has answered successfully at least once. Until then
   *  `watchedIds` is empty because nothing has been read, not because
   *  nothing is watched — a distinction remembered rows depend on (see
   *  startupSnapshot.ts's applyTrackingState). */
  loaded: boolean
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
  const [loaded, setLoaded] = useState(false)
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
        setLoaded(true)
      })
      // A failed read leaves `loaded` false on purpose: this set is then
      // still unknown, and callers must not read its emptiness as an
      // answer. Deliberately not reset at the top of a retry either — a
      // set that was established once does not become unknown again.
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
  return useMemo(
    () => ({ watchedIds, history, loaded, refresh }),
    [watchedIds, history, loaded, refresh]
  )
}

export interface DislikedIdsResult {
  dislikedIds: Set<string>
  /** disliked:list has answered successfully at least once — see WatchedIdsResult.loaded. */
  loaded: boolean
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
  const [loaded, setLoaded] = useState(false)
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
        setLoaded(true)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [generation])

  const refresh = useCallback(() => setGeneration((g) => g + 1), [])
  return useMemo(() => ({ dislikedIds, loaded, refresh }), [dislikedIds, loaded, refresh])
}

export interface PlaysResult {
  plays: PlayRecord[]
  loaded: boolean
  /** Removes one viewing and adopts the list the backend reports back. */
  remove: (playId: number) => Promise<void>
}

/**
 * The viewing record, newest first.
 *
 * Fetched on mount rather than held in AppStateContext with everything else:
 * only one tab of one page reads it, it can run to hundreds of rows, and
 * nothing else in the app needs to re-render when a play is removed.
 */
export function useMediaHubPlays(): PlaysResult {
  const [plays, setPlays] = useState<PlayRecord[]>([])
  // Seeded from whether there is an IPC bridge at all: outside the desktop
  // app (a plain browser tab during dev-server work) there is nothing to wait
  // for, and saying so at mount is both truthful and cheaper than an effect
  // that sets it synchronously — which cascades a render.
  const [loaded, setLoaded] = useState(() => !window.api?.mediaHub)

  useEffect(() => {
    let cancelled = false
    const api = window.api?.mediaHub
    if (!api) return
    api.plays
      .list()
      .then((result) => {
        if (cancelled) return
        setPlays(result.plays)
        setLoaded(true)
      })
      .catch(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const remove = useCallback(async (playId: number) => {
    const api = window.api?.mediaHub
    if (!api) return
    // Optimistic: the row disappears under the click, and the authoritative
    // list replaces it a moment later. A local SQLite delete is fast enough
    // that the two are usually indistinguishable, but not so fast that waiting
    // for it is free.
    setPlays((previous) => previous.filter((play) => play.playId !== playId))
    try {
      const result = await api.plays.remove(playId)
      setPlays(result.plays)
    } catch {
      // The optimistic removal stands. A failed delete here is almost always a
      // closing database, and putting the row back would be the more
      // confusing outcome.
    }
  }, [])

  return useMemo(() => ({ plays, loaded, remove }), [plays, loaded, remove])
}

export interface RatingsResult {
  /** Score by content id, 1-10. A title absent from the map is unrated, which
   *  is not the same as rated badly — see shared/media-hub/rating.ts. */
  ratings: Map<string, number>
  /** Applies a score (or 0 to clear) and adopts whatever the backend reports
   *  back, so the map on screen is the map that was stored. */
  rate: (id: string, score: number) => Promise<void>
}

export function useMediaHubRatings(): RatingsResult {
  const [ratings, setRatings] = useState<Map<string, number>>(new Map())

  useEffect(() => {
    let cancelled = false
    const api = window.api?.mediaHub
    if (!api) return
    api.ratings
      .list()
      .then((result) => {
        if (cancelled) return
        setRatings(new Map(Object.entries(result.ratings)))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const rate = useCallback(async (id: string, score: number) => {
    const api = window.api?.mediaHub
    if (!api) return
    // Optimistic, then reconciled with what came back. The write is local
    // SQLite and effectively instant, but it also kicks off a recommendation
    // rebuild — waiting for the round trip to move a button somebody just
    // pressed would make rating feel slower than it is.
    setRatings((previous) => {
      const next = new Map(previous)
      if (score > 0) next.set(id, score)
      else next.delete(id)
      return next
    })
    try {
      const result = await api.ratings.set(id, score)
      setRatings(new Map(Object.entries(result.ratings)))
    } catch {
      // The optimistic value stands rather than snapping back: a failed write
      // here is almost always a closed database on shutdown, and reverting a
      // score somebody just chose would be the more confusing outcome.
    }
  }, [])

  return useMemo(() => ({ ratings, rate }), [ratings, rate])
}

export interface HomeFeedResult {
  // The declared interface type, not `ReturnType<typeof
  // continueWatchingEntryToItem>` — this list now has a second source (a
  // snapshot revived from JSON, see startupSnapshot.ts), so it can no
  // longer be defined as "whatever that one adapter happens to return".
  continueWatching: ContinueWatchingItem[]
  recommendations: Recommendation[]
  featured: MediaItem[]
  preferredGenres: string[]
  trackedIds: Set<string>
  loading: boolean
  live: boolean
  /** The last home:personalized attempt threw.
   *
   *  Worth its own flag because the alternative reading is defamatory:
   *  main returns recommendations ranked over the WHOLE catalog when it
   *  has nothing personal to go on, and throws outright when every
   *  catalog source is down (tracking.ts's homePersonalized) — so an
   *  empty recommendations list essentially only happens when the fetch
   *  failed. Without this, a backend outage rendered as "watch a few
   *  titles and recommendations will show up here", which blames the
   *  person's viewing history for a network problem.
   *
   *  Can be true alongside a populated feed: a refresh that fails leaves
   *  the data it failed to replace on screen. */
  error: boolean
  /** Re-runs the home:personalized fetch — call after a mutation (mark watched, toggle tracking) that should move an item in/out of Continue Watching. */
  refresh: () => void
}

/**
 * home:personalized in one hook — Continue Watching, recommendations, and
 * a "featured" pool (this dashboard's hero-rotation concept, which the
 * backend has no equivalent of; the top few recommendations stand in for
 * it here). Until the fetch lands, this reports the previous session's
 * remembered feed (startupSnapshot.ts) — real titles this person really
 * did see, not mockData.ts's demo pools, which are now reachable only
 * from the bridgeless preview build. `live: false` still means "nothing
 * has been re-checked this run", so a caller that needs to distinguish
 * remembered from fresh still can.
 */
export function useMediaHubHomeFeed(): HomeFeedResult {
  const [state, setState] = useState<typeof EMPTY_HOME_FEED | null>(null)
  // See useMediaHubBrowseCatalog above for why this is a lazy initializer
  // rather than an effect-driven flip.
  const [loading, setLoading] = useState(() => Boolean(window.api?.mediaHub))
  const [error, setError] = useState(false)
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
    // A retry in progress is not a failure — see the same reasoning in
    // useMediaHubBrowseCatalog's setOutcomes({}).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setError(false)
    api.home
      .personalized()
      .then((result) => {
        if (cancelled) return
        const trackedIds = new Set(result.tracked.map((t) => t.id))
        const next = {
          continueWatching: result.continueWatching.map(continueWatchingEntryToItem),
          recommendations: result.recommendations.map((item) =>
            catalogItemToRecommendation(item, result.preferredGenres, { trackedIds })
          ),
          featured: result.recommendations
            .slice(0, 6)
            .map((item) => catalogItemToMediaItem(item, { trackedIds })),
          preferredGenres: result.preferredGenres,
          trackedIds
        }
        setState(next)
        // This is the part of the snapshot that matters most: the hero,
        // the AI Picks row and Continue Watching are the whole of what
        // Home is above the fold, and they are what the next launch has
        // to paint before home:personalized can answer again.
        rememberHomeFeed({
          featured: next.featured,
          recommendations: next.recommendations,
          continueWatching: next.continueWatching,
          preferredGenres: next.preferredGenres,
          trackedIds: [...next.trackedIds]
        })
      })
      .catch(() => {
        if (cancelled) return
        // `state` is deliberately left alone. refresh() runs after any
        // mutation that could move something in or out of Continue
        // Watching, so a failure here is usually a hiccup in the middle of
        // a session that already has good data on screen — and clearing it
        // rewound Home to the launch-time snapshot (`state` falls back to
        // a value memoised during the first render), or emptied the hero
        // outright on a first-ever run. Losing what is already displayed
        // is a strictly worse outcome than a stale row, and the `error`
        // flag reports the failure without it.
        setError(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [generation])

  const refresh = useCallback(() => setGeneration((g) => g + 1), [])

  // A rebuild that finishes mid-session pushes rather than being polled
  // for — see main/media-hub/recommendations.ts. Without this, marking
  // something watched would leave the row showing it until the next
  // launch, because the rebuild it triggers lands well after the refetch
  // the mutation itself already did.
  //
  // `refresh` is stable (useCallback with no deps), so this subscribes
  // once for the life of the provider rather than tearing the listener
  // down and re-establishing it on every rebuild it receives.
  useEffect(() => {
    return window.api?.mediaHub?.home?.onRecommendationsChanged?.(() => refresh())
  }, [refresh])

  return useMemo(
    () => ({
      ...(state ?? startupHomeFeedFallback()),
      loading,
      live: state !== null,
      error,
      refresh
    }),
    [state, loading, error, refresh]
  )
}
