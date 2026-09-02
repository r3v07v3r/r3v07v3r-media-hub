// The daemon-side catalog crawl: walk Cinemeta (movies, series) and Kitsu
// (anime) to full depth, once for the whole household, and feed the title
// store. This is the cost the tier exists to move — every device used to
// pay it individually, bounded to a head slice because a per-device crawl
// any deeper would be rude; an always-on box can afford the whole walk.
//
// Normalization is THE APP'S OWN: normalizeMeta / normalizeKitsuAnime from
// src/main/media-hub/core (electron-free, same import pattern fetcher.ts
// uses for playback helpers). Both ends of the wire speak CatalogItem, so
// a row that syncs to a client is byte-for-byte what its own crawl would
// have produced — minus the franchise grouping, which remains a client
// pass and is the stated limit of this tier.
//
// Refresh discipline mirrors the daemon's existing patterns:
//   - coalescing, like jobs.enqueue: a second ask while one runs JOINS it,
//   - throttling, like pairing's attempt window: inside the cooldown the
//     answer is 'throttled' with nextAllowedAt — a normal answer the UI
//     reports, never an error.

import { normalizeKitsuAnime, normalizeMeta, type RawApiPayload } from '../src/main/media-hub/core'
import type { CatalogItem, MediaKind } from '../src/shared/media-hub/types'
import type { TitleStore } from './titles'

export interface RefreshAnswer {
  state: 'started' | 'joined' | 'throttled'
  lastRefreshAt: number | null
  nextAllowedAt: number
}

export interface TitleCrawler {
  /** Answer for POST /api/titles/refresh. Returns immediately; the crawl
   *  itself runs in the background (a full walk is minutes, not a request). */
  refresh(kind?: MediaKind): RefreshAnswer
  /** The scheduled path: crawl every kind, joining any manual run. */
  runScheduled(): Promise<void>
  /** True while any kind is mid-crawl — lets /api/status say so. */
  isCrawling(): boolean
}

/** Manual refreshes per kind no more often than this. The catalog upstream
 *  is a slow-moving top list; 15 minutes is responsiveness for "I just
 *  added this server", not a real data cadence. */
export const REFRESH_COOLDOWN_MS = 15 * 60 * 1000

/** Hard page caps — a runaway upstream that never returns an empty page
 *  must not turn the walk into an infinite loop. Both sit well past the
 *  real catalog sizes observed (Cinemeta top ~15k rows/kind, Kitsu ~22k
 *  anime), so the empty-page stop is the one that fires in practice. */
export const MAX_CINEMETA_PAGES = 400
export const MAX_KITSU_PAGES = 1500

const CINEMETA_PAGE_SIZE = 100
const KITSU_PAGE_SIZE = 20

/** Gap between upstream page fetches. The daemon is nobody's priority
 *  traffic; a full Kitsu walk at this pace is ~4 minutes, which is fine
 *  for a job that runs in the background of an always-on box. */
const PAGE_GAP_MS = 150

const FETCH_TIMEOUT_MS = 20_000

export type PageFetcher = (kind: MediaKind, pageIndex: number) => Promise<CatalogItem[]>

async function fetchJsonWithTimeout(url: string): Promise<RawApiPayload> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' }
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return (await response.json()) as RawApiPayload
  } finally {
    clearTimeout(timer)
  }
}

/** One upstream page, normalized with the app's own normalizers. Fails to
 *  empty — a bad page costs its rows and nothing else, exactly the app's
 *  crawl contract. */
export async function fetchCatalogPage(kind: MediaKind, pageIndex: number): Promise<CatalogItem[]> {
  try {
    if (kind === 'anime') {
      const offset = pageIndex * KITSU_PAGE_SIZE
      const result = await fetchJsonWithTimeout(
        `https://kitsu.io/api/edge/anime?sort=-userCount&page%5Blimit%5D=20&page%5Boffset%5D=${offset}&include=categories`
      )
      const categories = new Map<string, string | undefined>(
        (result.included || [])
          .filter((x: RawApiPayload) => x.type === 'categories')
          .map((x: RawApiPayload) => [String(x.id), x.attributes?.title])
      )
      return (result.data || [])
        .map((record: RawApiPayload) => ({
          ...record,
          attributes: {
            ...record.attributes,
            genres: (record.relationships?.categories?.data || [])
              .map((x: RawApiPayload) => categories.get(String(x.id)))
              .filter(Boolean)
          }
        }))
        .map((record: RawApiPayload) => normalizeKitsuAnime(record, true))
    }
    const skip = pageIndex * CINEMETA_PAGE_SIZE
    const result = await fetchJsonWithTimeout(
      `https://v3-cinemeta.strem.io/catalog/${kind}/top/skip=${skip}.json`
    )
    return ((result.metas as RawApiPayload[]) || []).map((x) => normalizeMeta(x, kind, true))
  } catch {
    return []
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

export function createTitleCrawler(deps: {
  store: TitleStore
  log: (message: string) => void
  /** Injectable for tests; defaults to the real upstream walk. */
  fetchPage?: PageFetcher
  /** Injectable clock for cooldown tests. */
  now?: () => number
  pageGapMs?: number
}): TitleCrawler {
  const { store, log } = deps
  const fetchPage = deps.fetchPage ?? fetchCatalogPage
  const now = deps.now ?? (() => Date.now())
  const pageGapMs = deps.pageGapMs ?? PAGE_GAP_MS

  const inFlight = new Map<MediaKind, Promise<void>>()

  async function crawlKind(kind: MediaKind): Promise<void> {
    const maxPages = kind === 'anime' ? MAX_KITSU_PAGES : MAX_CINEMETA_PAGES
    const pageSize = kind === 'anime' ? KITSU_PAGE_SIZE : CINEMETA_PAGE_SIZE
    let changed = 0
    let seen = 0
    let emptyStreak = 0
    for (let page = 0; page < maxPages; page++) {
      const items = await fetchPage(kind, page)
      if (!items.length) {
        // One empty page can be a transient fetch failure; two in a row is
        // the end of the catalog (or an outage, in which case stopping is
        // also right — the next scheduled crawl resumes the walk).
        emptyStreak += 1
        if (emptyStreak >= 2) break
        continue
      }
      emptyStreak = 0
      seen += items.length
      changed += await store.upsert(
        kind,
        items.map((item, offset) => ({ rank: page * pageSize + offset, item }))
      )
      if (pageGapMs > 0) await sleep(pageGapMs)
    }
    await store.markRefreshed(kind, now())
    log(`titles: ${kind} crawl saw ${seen} rows, ${changed} changed`)
  }

  function startKind(kind: MediaKind): { joined: boolean } {
    const running = inFlight.get(kind)
    if (running) return { joined: true }
    const task = crawlKind(kind)
      .catch((error) => log(`titles: ${kind} crawl failed: ${(error as Error).message}`))
      .finally(() => inFlight.delete(kind))
    inFlight.set(kind, task)
    return { joined: false }
  }

  return {
    refresh(kind) {
      const kinds: MediaKind[] = kind ? [kind] : ['movie', 'series', 'anime']
      // The cooldown is judged per request against the OLDEST kind asked
      // for — a multi-kind ask is allowed when any of it is stale.
      const last = Math.max(...kinds.map((k) => store.lastRefreshAt(k) ?? 0))
      const nextAllowedAt = last + REFRESH_COOLDOWN_MS
      const anyRunning = kinds.some((k) => inFlight.has(k))
      if (!anyRunning && now() < nextAllowedAt) {
        return {
          state: 'throttled',
          lastRefreshAt: last || null,
          nextAllowedAt
        }
      }
      let joinedAll = true
      for (const k of kinds) {
        const { joined } = startKind(k)
        joinedAll = joinedAll && joined
      }
      return {
        state: joinedAll ? 'joined' : 'started',
        lastRefreshAt: last || null,
        nextAllowedAt: now() + REFRESH_COOLDOWN_MS
      }
    },

    async runScheduled() {
      for (const kind of ['movie', 'series', 'anime'] as MediaKind[]) {
        startKind(kind)
        await inFlight.get(kind)
      }
    },

    isCrawling() {
      return inFlight.size > 0
    }
  }
}
