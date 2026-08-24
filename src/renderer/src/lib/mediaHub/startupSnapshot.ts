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

interface StoredSnapshot extends HomeFeedSnapshot {
  savedAt: number
  catalog: MediaItem[]
}

const EMPTY: StoredSnapshot = {
  savedAt: 0,
  catalog: [],
  featured: [],
  recommendations: [],
  continueWatching: [],
  preferredGenres: []
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

function read(): StoredSnapshot {
  if (current) return current
  current = EMPTY
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return current
    const parsed = JSON.parse(raw) as Partial<StoredSnapshot>
    const savedAt = typeof parsed?.savedAt === 'number' ? parsed.savedAt : 0
    // A savedAt from the future (the clock moved backwards since the
    // write) is stale by an unknowable amount, not fresh — hence the
    // absolute difference rather than a one-sided comparison.
    if (!savedAt || Math.abs(Date.now() - savedAt) > MAX_AGE_MS) {
      clearStartupSnapshot()
      return EMPTY
    }
    current = {
      savedAt,
      catalog: reviveMediaItems(parsed.catalog),
      featured: reviveMediaItems(parsed.featured),
      recommendations: reviveWrapped<Recommendation>(parsed.recommendations),
      continueWatching: reviveWrapped<ContinueWatchingItem>(parsed.continueWatching),
      preferredGenres: Array.isArray(parsed.preferredGenres) ? parsed.preferredGenres : []
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

export function rememberCatalog(items: MediaItem[]): void {
  if (!items.length) return
  const snapshot = read()
  const next = items.length > MAX_CATALOG_ITEMS ? items.slice(0, MAX_CATALOG_ITEMS) : items
  if (snapshot.catalog === next) return
  current = { ...snapshot, catalog: next }
  schedule()
}

export function rememberHomeFeed(feed: HomeFeedSnapshot): void {
  current = { ...read(), ...feed }
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
