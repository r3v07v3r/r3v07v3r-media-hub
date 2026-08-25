// Remembers the last real media-hub data this app actually displayed, so
// the next cold start paints THAT instead of mockData.ts's demo titles.
//
// Before this existed, every startup fallback pointed at the mock pools
// (FEATURED_ITEMS / AI_PICKS / CONTINUE_WATCHING / CATALOG), which meant
// the first several seconds of every launch showed Blade Runner 2049 and
// Interstellar to someone whose library has nothing to do with either —
// and then swapped the whole dashboard out from under them once
// catalog:list and home:personalized finally resolved. Main's own
// six-hour catalog cache (catalog.ts's CATALOG_TTL_MS) doesn't help with
// that: it still sits behind an IPC round trip the renderer has to paint
// something during.
//
// So the renderer keeps its own copy, on the near side of that round
// trip. It is deliberately the ALREADY-ADAPTED MediaItem shape rather
// than the backend's CatalogItem: it is what the UI renders directly (no
// mapping pass before first paint), and it drops the `videos` episode
// arrays that make up the bulk of the backend payload — ~2.7k catalog
// items land around 1.8MB this way against roughly 5MB raw.
//
// Everything here is best-effort and never throws: localStorage can be
// absent, partitioned off, or over quota (see SidebarNavigation.tsx,
// which takes the same defensive line for a much smaller preference).
// A missing snapshot just means the app falls back to a skeleton, which
// is the honest thing to show when there is genuinely nothing to show.

import type { ContinueWatchingItem, MediaItem, Recommendation } from '@renderer/types'
import { initialsFromTitle, tintFromSeed } from './tint'

const STORAGE_KEY = 'r3.mediaHub.startupSnapshot.v1'

// Old enough that the titles are more misleading than useful — a month
// of trending-catalog movement, or a Continue Watching row from a
// machine nobody has opened since. Past this the snapshot is dropped and
// the cold-start skeleton takes over.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

// Sanity bound, not a target: the real catalog is ~2.7k items. This only
// exists so a runaway backend response can't try to push tens of
// megabytes through a synchronous localStorage write.
const MAX_CATALOG_ITEMS = 5000

// Long enough that the burst of writes a startup produces (three catalog
// kinds landing separately, then the home feed) coalesces into one
// stringify+store, and late enough that it never lands in the same frame
// as the re-render that new data triggers.
const WRITE_DELAY_MS = 1500

export interface HomeFeedSnapshot {
  featured: MediaItem[]
  recommendations: Recommendation[]
  continueWatching: ContinueWatchingItem[]
  preferredGenres: string[]
  /** The ids in My List as of the last successful home:personalized. See
   *  hooks.ts's fallback for why this is remembered rather than started
   *  empty — an empty set is not the neutral choice it looks like. */
  trackedIds: string[]
}

/**
 * Catalog freshness, per kind. Keyed by `MediaItem.mediaKind`, with
 * UNKINDED for rows that carry none.
 *
 * Not one timestamp for the whole catalog, because the catalog is not
 * fetched as a whole: each kind answers on its own, and a kind that fails
 * has its previous rows carried forward (see mergeRememberedCatalog). A
 * single stamp meant every partial success re-dated those carried rows,
 * so a source that had been down for months still looked a day old and
 * MAX_AGE_MS never reached it.
 */
type CatalogStamps = Record<string, number>

/** Stamp key for rows with no `mediaKind` — mockData's, which are never persisted, and anything a future shape forgets to tag. */
const UNKINDED = '_'

interface StoredSnapshot extends HomeFeedSnapshot {
  /** When this file was last written, for anything. Diagnostics, and the fallback stamp for a snapshot written before the fields below existed. */
  savedAt: number
  catalogSavedAt: CatalogStamps
  // Aged separately from the catalog, because they are refreshed
  // separately: the catalog comes from catalog:list and the home feed
  // from home:personalized, and one can keep succeeding for weeks while
  // the other keeps failing. A single shared timestamp meant any
  // successful write renewed BOTH, so a Continue Watching row could
  // outlive MAX_AGE_MS indefinitely on the strength of catalog writes
  // that never touched it — an app offering to resume something you
  // finished months ago.
  homeSavedAt: number
  catalog: MediaItem[]
}

// The My List ids have no clock at all, and that is deliberate.
//
// Everything else here expires because stale content misrepresents
// itself: a months-old hero pool claims to be this week's. An expired My
// List does something worse — it degrades to a confident "nothing is
// saved", which renders saved titles with an Add control that REMOVES
// them on click. Cosmetic staleness against data loss is not a trade
// worth making, and it is the same asymmetry that made seeding this set
// from the snapshot the fix rather than the bug.
//
// The alternative was per-id confirmation stamps, so an id confirmed on
// day 29 could outlive a set last verified on day 1. That is a third
// clock and a second shape to migrate, in service of an outage that has
// to last a month; not expiring the ids covers the same case and removes
// a clock instead of adding one. They are replaced wholesale the moment
// home:personalized answers, which on any working install is seconds
// into a launch.

const EMPTY: StoredSnapshot = {
  savedAt: 0,
  catalogSavedAt: {},
  homeSavedAt: 0,
  catalog: [],
  featured: [],
  recommendations: [],
  continueWatching: [],
  preferredGenres: [],
  trackedIds: []
}

function stampKey(item: MediaItem): string {
  return item.mediaKind ?? UNKINDED
}

/**
 * Persisted JSON is the one input here this app did not construct during
 * this run — it was written by some previous version of this file, and
 * MediaItem has gained required fields before (artTint/initials among
 * them). An item missing those does not render as a slightly wrong card;
 * it throws on `item.artTint[0]` in FeaturedHero and takes the dashboard
 * with it. So identity is required, and the derived fields are recomputed
 * from the same helpers the live adapter uses rather than trusted.
 */
function reviveMediaItem(value: unknown): MediaItem | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<MediaItem>
  if (typeof item.id !== 'string' || !item.id) return null
  if (typeof item.title !== 'string' || !item.title) return null
  const artTint =
    Array.isArray(item.artTint) && item.artTint.length >= 2
      ? (item.artTint as MediaItem['artTint'])
      : tintFromSeed(item.id)
  return {
    ...(item as MediaItem),
    mediaType: item.mediaType ?? 'movie',
    genres: Array.isArray(item.genres) ? item.genres : [],
    watched: item.watched === true,
    completed: item.completed === true,
    artTint,
    initials: typeof item.initials === 'string' ? item.initials : initialsFromTitle(item.title)
  }
}

function reviveMediaItems(value: unknown): MediaItem[] {
  if (!Array.isArray(value)) return []
  const out: MediaItem[] = []
  for (const entry of value) {
    const item = reviveMediaItem(entry)
    if (item) out.push(item)
  }
  return out
}

/** Recommendation and ContinueWatchingItem are both `{ media: MediaItem, ...rest }` — same revival, one wrapper deep. */
function reviveWrapped<T extends { media: MediaItem }>(value: unknown): T[] {
  if (!Array.isArray(value)) return []
  const out: T[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const media = reviveMediaItem((entry as { media?: unknown }).media)
    if (media) out.push({ ...(entry as T), media })
  }
  return out
}

let current: StoredSnapshot | null = null
let writeTimer: ReturnType<typeof setTimeout> | null = null

function timestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * A stamp from the future (the clock moved backwards since the write) is
 * stale by an unknowable amount, not fresh — hence the absolute
 * difference rather than a one-sided comparison.
 */
function isFresh(savedAt: number): boolean {
  return savedAt > 0 && Math.abs(Date.now() - savedAt) <= MAX_AGE_MS
}

function read(): StoredSnapshot {
  if (current) return current
  current = EMPTY
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return current
    const parsed = JSON.parse(raw) as Partial<StoredSnapshot>
    const savedAt = timestamp(parsed?.savedAt)
    // Snapshots written before these stamps existed carry only `savedAt`,
    // and the version between the two carried a single catalog number —
    // either way one value dates everything, which is exactly as accurate
    // as what that version could record.
    const rawCatalogStamps: unknown = parsed?.catalogSavedAt
    const fallbackStamp = timestamp(rawCatalogStamps) || savedAt
    const stamps: CatalogStamps = {}
    if (rawCatalogStamps && typeof rawCatalogStamps === 'object') {
      for (const [kind, value] of Object.entries(rawCatalogStamps as Record<string, unknown>)) {
        const at = timestamp(value)
        if (at) stamps[kind] = at
      }
    }
    const homeSavedAt = timestamp(parsed?.homeSavedAt) || savedAt
    const homeFresh = isFresh(homeSavedAt)
    // Kept whatever their age — see the note on trackedSavedAt's removal
    // above. A snapshot written when they still had a clock simply ignores
    // it.
    const trackedIds = Array.isArray(parsed.trackedIds)
      ? parsed.trackedIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : []

    // Filtered row by row against its own kind's age, so a kind whose
    // source has been down long enough to expire drops out while the
    // kinds still answering stay.
    const keptStamps: CatalogStamps = {}
    const catalog = reviveMediaItems(parsed.catalog).filter((item) => {
      const key = stampKey(item)
      const at = stamps[key] ?? fallbackStamp
      if (!isFresh(at)) return false
      keptStamps[key] = at
      return true
    })

    if (!catalog.length && !homeFresh && !trackedIds.length) {
      clearStartupSnapshot()
      return EMPTY
    }
    current = {
      savedAt,
      catalogSavedAt: keptStamps,
      homeSavedAt: homeFresh ? homeSavedAt : 0,
      catalog,
      featured: homeFresh ? reviveMediaItems(parsed.featured) : [],
      recommendations: homeFresh ? reviveWrapped<Recommendation>(parsed.recommendations) : [],
      continueWatching: homeFresh
        ? reviveWrapped<ContinueWatchingItem>(parsed.continueWatching)
        : [],
      preferredGenres:
        homeFresh && Array.isArray(parsed.preferredGenres) ? parsed.preferredGenres : [],
      trackedIds
    }
  } catch {
    current = EMPTY
  }
  return current
}

function write(snapshot: StoredSnapshot): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
    return true
  } catch {
    return false
  }
}

function flush(): void {
  writeTimer = null
  const snapshot = read()
  if (write({ ...snapshot, savedAt: Date.now() })) return
  // Over quota (or the payload simply got too large to store). The
  // catalog is by far the biggest part of this and the most replaceable
  // — the home feed is what the first screen is actually made of — so
  // shed the catalog's descriptions first and the catalog itself second,
  // rather than losing the whole snapshot to one oversized field.
  const lean = snapshot.catalog.map((item) => {
    const copy = { ...item }
    delete copy.description
    return copy
  })
  if (write({ ...snapshot, catalog: lean, savedAt: Date.now() })) return
  if (write({ ...snapshot, catalog: [], savedAt: Date.now() })) return
  // Nothing storable at all — leave whatever is already on disk alone
  // rather than clearing a usable older snapshot to record a failure.
}

let unloadHookInstalled = false

function schedule(): void {
  installUnloadFlush()
  if (writeTimer) return
  writeTimer = setTimeout(flush, WRITE_DELAY_MS)
  // A snapshot write must never be the reason a timer holds anything
  // open; this is a convenience for the NEXT launch, not for this one.
  writeTimer.unref?.()
}

/**
 * Writes any pending snapshot immediately instead of at the end of the
 * coalescing window. Closing the app inside that window is not an edge
 * case — the home feed lands seconds after launch, and someone who opens
 * the app, sees what they wanted and quits would otherwise have that
 * session recorded as if it never happened, which is precisely the launch
 * this file exists to improve.
 */
export function flushStartupSnapshot(): void {
  if (writeTimer) {
    clearTimeout(writeTimer)
    flush()
  }
}

function installUnloadFlush(): void {
  if (unloadHookInstalled) return
  unloadHookInstalled = true
  try {
    window.addEventListener('pagehide', flushStartupSnapshot)
  } catch {
    /* no window to hook (a test harness, a non-DOM import) — the timer still covers the normal case */
  }
}

/** The catalog this app last showed for real — empty on a genuine first run. */
export function rememberedCatalog(): MediaItem[] {
  return read().catalog
}

/** The Home feed (hero pool, AI picks, Continue Watching) this app last showed for real. */
export function rememberedHomeFeed(): HomeFeedSnapshot {
  const snapshot = read()
  return {
    featured: snapshot.featured,
    recommendations: snapshot.recommendations,
    continueWatching: snapshot.continueWatching,
    preferredGenres: snapshot.preferredGenres,
    trackedIds: snapshot.trackedIds
  }
}

/**
 * `deliveredAt` maps a kind to the moment its rows were actually fetched
 * this run. Only kinds that really answered appear in it — NOT every kind
 * present in `items`, which also holds the rows carried forward for kinds
 * that failed (see mergeRememberedCatalog). So a source that stays down
 * keeps ageing, and eventually expires, however often its neighbours
 * succeed.
 *
 * The caller supplies those timestamps rather than this reaching for the
 * clock, because this is called far more often than rows are fetched —
 * every badge change rewrites the snapshot too. Stamping with "now" there
 * would have ordinary tracking activity renewing rows nothing re-fetched.
 */
export function rememberCatalog(items: MediaItem[], deliveredAt: CatalogStamps): void {
  if (!items.length) return
  const snapshot = read()
  const next = items.length > MAX_CATALOG_ITEMS ? items.slice(0, MAX_CATALOG_ITEMS) : items
  const stamps: CatalogStamps = { ...snapshot.catalogSavedAt, ...deliveredAt }
  for (const item of next) {
    // A kind in the list that has never been stamped — carried out of a
    // snapshot written before per-kind stamps existed — inherits that
    // snapshot's age rather than today's.
    const key = stampKey(item)
    if (!stamps[key]) stamps[key] = snapshot.savedAt || Date.now()
  }
  current = { ...snapshot, catalog: next, catalogSavedAt: stamps }
  schedule()
}

export function rememberHomeFeed(feed: HomeFeedSnapshot): void {
  current = { ...read(), ...feed, homeSavedAt: Date.now() }
  schedule()
}

/**
 * The tracking state a remembered row is re-checked against. A structural
 * subset of adapters.ts's CatalogItemAdapterContext, declared here so this
 * module stays free of path-aliased imports.
 *
 * An ABSENT set means "this has not been established yet", not "this is
 * empty" — see applyTrackingState. The two are very different claims, and
 * every one of these sets starts out empty while its backend read is
 * still in flight.
 */
export interface TrackingState {
  trackedIds?: Set<string>
  watchedIds?: Set<string>
  dislikedIds?: Set<string>
}

/**
 * Re-applies the CURRENT watched / My List / disliked state to a
 * remembered row.
 *
 * Rows come out of this file with the flags they had when they were
 * persisted, and nothing else re-derives them: the live mapping in
 * hooks.ts only covers rows the backend returned this run. So marking a
 * carried title watched left its badge, its context-menu action and the
 * Hide Watched filter all reading last session's answer.
 *
 * `completed` is the one field this cannot fully restore. MediaItem does
 * not carry `videos`, which is exactly the episode list
 * catalogItemToMediaItem's isSeriesCompleted walks — dropping it is most
 * of why a snapshot fits in localStorage at all. For a movie, completion
 * IS watched, so that case is exact. For a series or anime the previous
 * answer is kept rather than invented, with the one correction that needs
 * no episode data: something not watched at all cannot be complete.
 *
 * A set that is absent leaves its flag alone. tracking:list and
 * disliked:list both start as empty sets and answer later — and
 * tracking:list waits on metadata lookups for tracked series, so "later"
 * is not instant — so treating the initial emptiness as authoritative
 * wiped every remembered badge on startup, left it wiped for the whole
 * session if the read failed, and could persist the wiped state into the
 * next snapshot. Empty-but-established is still authoritative; pass an
 * empty Set to say so.
 *
 * Returns the SAME object when nothing changed. This runs over the whole
 * remembered catalog on every badge change, and a fresh object per row
 * would churn every memo downstream of it.
 */
export function applyTrackingState(item: MediaItem, state: TrackingState = {}): MediaItem {
  const watched = state.watchedIds ? state.watchedIds.has(item.id) : item.watched
  const inMyList = state.trackedIds ? state.trackedIds.has(item.id) : item.inMyList
  const disliked = state.dislikedIds ? state.dislikedIds.has(item.id) : item.disliked
  const isMovie = item.mediaKind ? item.mediaKind === 'movie' : item.mediaType === 'movie'
  const completed = isMovie ? watched : watched && item.completed
  if (
    item.watched === watched &&
    item.inMyList === inMyList &&
    item.disliked === disliked &&
    item.completed === completed
  ) {
    return item
  }
  return { ...item, watched, inMyList, disliked, completed }
}

/** The catalog kinds a MediaItem can carry — `mediaKind`, minus undefined. */
export type ResolvedKind = NonNullable<MediaItem['mediaKind']>

/**
 * Live rows for the catalog kinds that have answered this run, plus the
 * remembered rows for the kinds that have not.
 *
 * catalog:list publishes each kind the moment it lands rather than
 * awaiting all three (see hooks.ts) — the Simkl feeds come back in about
 * a second, the Kitsu crawl takes far longer. Without this merge that
 * improvement actively removes content: as soon as movies landed, the
 * catalog became movies-only and the remembered anime the Anime page was
 * already showing vanished into a skeleton until the crawl finished, which
 * is the "it all disappears a second in" this whole file exists to stop.
 * If that crawl then failed, the remembered anime stayed gone — and,
 * because the merged list is also what gets persisted, was dropped from
 * the next launch's snapshot too.
 *
 * A kind that has answered always wins outright for its own rows, so a
 * title genuinely dropped from the live catalog does not linger. Items
 * with no `mediaKind` (mockData's, in the bridgeless preview build)
 * belong to no kind and are always carried; that build resolves no kinds
 * anyway.
 */
export function mergeRememberedCatalog(
  live: MediaItem[],
  remembered: MediaItem[],
  resolvedKinds: ReadonlySet<ResolvedKind>
): MediaItem[] {
  if (!remembered.length) return live
  const carried = remembered.filter((item) => !item.mediaKind || !resolvedKinds.has(item.mediaKind))
  if (!carried.length) return live
  if (!live.length) return carried

  const seen = new Set(live.map((item) => item.id))
  const merged = live.slice()
  for (const item of carried) {
    // An id already present live is the same title, freshly fetched —
    // keep that one, never the remembered copy with its older badges.
    if (seen.has(item.id)) continue
    seen.add(item.id)
    merged.push(item)
  }
  return merged
}

/**
 * Records one confirmed My List change immediately, without waiting for a
 * home:personalized refresh to carry it.
 *
 * That wait was a real gap: tracking:toggle is a local database write and
 * succeeds during an outage, but home:personalized THROWS when every
 * catalog source is down (tracking.ts's homePersonalized), so the change
 * never reached this file. Restart mid-outage and the title came back
 * showing the opposite action — and pressing it reversed a mutation the
 * backend had already committed.
 *
 * `homeSavedAt` is not touched. A confirmed toggle re-verifies this one
 * id, not the hero pool beside it, and re-dating that on the strength of
 * it is the renewal mistake this file has already made twice. The ids
 * themselves have no clock to renew — see the note above the interface.
 */
export function rememberTrackedId(id: string, tracked: boolean): void {
  if (!id) return
  const snapshot = read()
  const has = snapshot.trackedIds.includes(id)
  if (tracked === has) return
  current = {
    ...snapshot,
    trackedIds: tracked ? [...snapshot.trackedIds, id] : snapshot.trackedIds.filter((x) => x !== id)
  }
  schedule()
}

/**
 * Drops one title from the remembered Continue Watching row, for a
 * removal the backend has already confirmed.
 *
 * There is no dedicated "remove from Continue Watching" channel —
 * untracking is what drops it (see AppStateContext) — and that write is
 * local and succeeds during an outage, while the home:personalized
 * refresh that would otherwise carry it to disk throws. So a removal made
 * mid-outage came back on restart, and pressing Remove a second time
 * toggled tracking the other way and re-added it.
 *
 * `homeSavedAt` is left alone for the same reason rememberTrackedId
 * leaves the clocks alone: one row was re-verified, not the feed.
 */
export function forgetContinueWatching(id: string): void {
  if (!id) return
  const snapshot = read()
  const next = snapshot.continueWatching.filter((entry) => entry.media.id !== id)
  if (next.length === snapshot.continueWatching.length) return
  current = { ...snapshot, continueWatching: next }
  schedule()
}

export function clearStartupSnapshot(): void {
  current = EMPTY
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* nothing to clear, or no storage to clear it from */
  }
}
