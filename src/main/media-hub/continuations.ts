// What comes next after what was just watched.
//
// The ranking used to guess this from titles alone — "John Wick" and "John
// Wick: Chapter 4" share a stem, so one follows the other — and the guess
// was flat: the sequel to something finished two years ago scored level with
// the sequel to last night's film, so the Home row filled with every
// franchise ever started. This module answers the question from the
// catalogue instead, for the titles that matter most: the ones watched in
// the last couple of weeks.
//
//   - films: the TMDB collection the film belongs to, in release order
//     (collection.ts — the same data the film's own page lists);
//   - anime: Kitsu's own "sequel" relationship (animeStory.ts).
//
// One answer per series, from its most recently watched part, and only the
// SINGLE next part — not everything after it. A rewatch counts: markWatched
// moves the date, and somebody two films into a marathon wants the third
// even though they saw it years ago (see Continuation in catalog-logic.ts
// for how the ranking and the stored list treat that).

import type {
  AnimeStoryResult,
  CatalogItem,
  HistoryEntry,
  TitleCollectionResult
} from '../../shared/media-hub/types'
import type { Continuation } from '../../shared/media-hub/catalog-logic'
import { getDatabase } from './dbState'
import { logError } from './logger'

/** How far back a watch still says "I am in the middle of this". */
export const RECENT_WATCH_WINDOW_MS = 14 * 24 * 60 * 60 * 1000

/** How many recent titles are asked. Each film is up to four TMDB requests
 *  the first time (cached for a month after), so this is a network cap as
 *  much as a relevance one. */
export const RECENT_WATCH_LIMIT = 12

/** A found continuation, with the catalogue record to rank. */
export interface FoundContinuation extends Continuation {
  item: CatalogItem
}

export interface ContinuationSources {
  /** The film's collection, or an empty one. */
  collection: (imdbId: string) => Promise<TitleCollectionResult>
  /** The anime's story links. */
  story: (kitsuId: string) => Promise<AnimeStoryResult>
  /** Full records for ids the pool does not hold. */
  lookup: (ids: string[]) => CatalogItem[]
}

export interface RecentWatch {
  id: string
  type: HistoryEntry['type']
  title: string
  watchedAt: string
}

/**
 * The most recent distinct titles in `history` (which is newest-first, see
 * database.ts history()), within the window and the cap. A series watched
 * sixty episodes deep is one entry, dated by its latest episode.
 */
export function recentWatches(
  history: readonly HistoryEntry[],
  now = Date.now(),
  {
    windowMs = RECENT_WATCH_WINDOW_MS,
    limit = RECENT_WATCH_LIMIT
  }: { windowMs?: number; limit?: number } = {}
): RecentWatch[] {
  const seen = new Set<string>()
  const recent: RecentWatch[] = []
  for (const entry of history) {
    const id = String(entry?.id ?? '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    const watchedAt = entry.watchedAt ?? ''
    const at = Date.parse(watchedAt)
    if (!Number.isFinite(at) || now - at > windowMs) continue
    recent.push({ id, type: entry.type, title: String(entry.title ?? ''), watchedAt })
    if (recent.length >= limit) break
  }
  return recent
}

/** When each title was last watched, by id — the first row wins because history is newest-first. */
function latestWatchById(history: readonly HistoryEntry[]): Map<string, number> {
  const latest = new Map<string, number>()
  for (const entry of history) {
    const id = String(entry?.id ?? '')
    if (!id || latest.has(id)) continue
    latest.set(id, Date.parse(entry.watchedAt ?? '') || 0)
  }
  return latest
}

/**
 * Whether `nextId` is worth suggesting after a watch at `sourceAt`.
 *
 * Unwatched: always. Watched: only if it was watched BEFORE the source's
 * latest viewing — that is a series being gone through again in order, and
 * the next part is exactly what they are about to look for. Watched after
 * it means they already continued; the newer watch is the one asking.
 */
function worthSuggesting(nextId: string, sourceAt: number, latest: Map<string, number>): boolean {
  const nextAt = latest.get(nextId)
  return nextAt === undefined || nextAt < sourceAt
}

const defaultSources = (): ContinuationSources => ({
  // Both imported late, for the reason recommendations.ts gives about
  // electron: the anime story module registers an IPC handler at import
  // time, which throws wherever the Electron binary is absent, and the
  // collection lookup reaches the settings store for its TMDB key.
  collection: async (imdbId) => (await import('./collection')).titleCollection(imdbId),
  story: async (kitsuId) => (await import('./animeStory')).storyForAnime(kitsuId),
  lookup: (ids) => getDatabase().indexByIds(ids).items
})

/**
 * The next instalment after each recently watched title, keyed by the next
 * title's id. `pool` is what the ranking is choosing from; a next part the
 * pool does not hold is looked up in the index, and failing that the
 * collection's own record is used — a poster and a year are enough to put a
 * card on the row, and a card that cannot be shown is the one failure this
 * feature must not have.
 */
export async function continuationsFor(
  history: readonly HistoryEntry[],
  pool: ReadonlyMap<string, CatalogItem>,
  now = Date.now(),
  sources: ContinuationSources = defaultSources()
): Promise<Map<string, FoundContinuation>> {
  const found = new Map<string, FoundContinuation>()
  const latest = latestWatchById(history)
  const handledSeries = new Set<string>()

  const resolveItem = (id: string, fallback?: CatalogItem): CatalogItem | undefined => {
    const inPool = pool.get(id)
    if (inPool) return inPool
    try {
      const indexed = sources.lookup([id])[0]
      if (indexed) return indexed
    } catch (error) {
      logError('continuations:lookup', error)
    }
    return fallback
  }

  for (const watch of recentWatches(history, now)) {
    const sourceAt = Date.parse(watch.watchedAt) || 0
    try {
      if (watch.type === 'movie' && /^tt\d+$/.test(watch.id)) {
        const collection = await sources.collection(watch.id)
        const parts = collection?.parts ?? []
        if (parts.length < 2) continue
        // One answer per series, from its most recently watched part — the
        // watches are newest-first, so the first part seen wins.
        const seriesKey = collection.name || parts.map((part) => part.id).join(',')
        if (handledSeries.has(seriesKey)) continue
        handledSeries.add(seriesKey)
        const index = parts.findIndex((part) => String(part.id) === watch.id)
        const next = index >= 0 ? parts[index + 1] : undefined
        if (!next || !worthSuggesting(String(next.id), sourceAt, latest)) continue
        const item = resolveItem(String(next.id), next)
        if (!item || found.has(String(item.id))) continue
        found.set(String(item.id), { item, from: watch.title, watchedAt: watch.watchedAt })
      } else if (watch.type === 'anime' && /^kitsu:\d+$/.test(watch.id)) {
        const story = await sources.story(watch.id)
        const sequel = story?.links?.find((link) => link.relation === 'sequel')
        if (!sequel?.item?.id) continue
        const nextId = String(sequel.item.id)
        // A season folded into the same tile is not a different title to
        // suggest — the show's own page already plays straight on.
        const source = pool.get(watch.id)
        if (source?.groupedIds?.includes(nextId)) continue
        if (!worthSuggesting(nextId, sourceAt, latest)) continue
        const item = resolveItem(nextId, sequel.item)
        if (!item || found.has(String(item.id))) continue
        found.set(String(item.id), { item, from: watch.title, watchedAt: watch.watchedAt })
      }
    } catch (error) {
      // One title's lookup failing must not cost the others theirs.
      logError('continuations:source', error)
    }
  }
  return found
}
