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

const EMPTY: StoredSnapshot = {
  savedAt: 0,
  catalogSavedAt: {},
  homeSavedAt: 0,
  catalog: [],
  featured: [],
  recommendations: [],
  continueWatching: [],
  preferredGenres: []
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

    if (!catalog.length && !homeFresh) {
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
        homeFresh && Array.isArray(parsed.preferredGenres) ? parsed.preferredGenres : []
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
    preferredGenres: snapshot.preferredGenres
  }
}

/**
 * `liveKinds` is the kinds that actually returned rows this run — NOT
 * every kind present in `items`, which also holds the rows carried
 * forward for kinds that failed (see mergeRememberedCatalog). Only what
 * was really re-fetched gets re-dated, so a source that stays down keeps
 * ageing and eventually expires however often its neighbours succeed.
 */
export function rememberCatalog(items: MediaItem[], liveKinds: Iterable<string>): void {
  if (!items.length) return
  const snapshot = read()
  const next = items.length > MAX_CATALOG_ITEMS ? items.slice(0, MAX_CATALOG_ITEMS) : items
  // Stamped here rather than at flush time: this is the moment the data
  // was actually known to be current, and flushes are coalesced across
  // every section.
  const now = Date.now()
  const stamps: CatalogStamps = { ...snapshot.catalogSavedAt }
  for (const kind of liveKinds) stamps[kind] = now
  for (const item of next) {
    // A kind in the list that has never been stamped — carried out of a
    // snapshot written before per-kind stamps existed — inherits that
    // snapshot's age rather than today's.
    const key = stampKey(item)
    if (!stamps[key]) stamps[key] = snapshot.savedAt || now
  }
  current = { ...snapshot, catalog: next, catalogSavedAt: stamps }
  schedule()
}

export function rememberHomeFeed(feed: HomeFeedSnapshot): void {
  current = { ...read(), ...feed, homeSavedAt: Date.now() }
  schedule()
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
