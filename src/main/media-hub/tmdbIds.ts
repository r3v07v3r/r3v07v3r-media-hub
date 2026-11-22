/**
 * IMDb id → TMDB id, shared by every TMDB feature.
 *
 * Credits, the collection strip, the content rating and the similar-titles
 * panel each used to run their own `/find` for the same film on the same
 * page open — four identical requests where one answers all of them. One
 * `/find` returns both the movie and the tv match, so both are cached from
 * a single read, and a title TMDB does not have is remembered (-1) so it is
 * not asked again on every page open.
 */
import type { RawApiPayload } from './core'
import { getDatabase } from './dbState'
import { fetchJson } from './httpClient'
import type { TaskPriority } from './taskScheduler'

const TMDB_ID_TTL_MS = 90 * 24 * 60 * 60 * 1000

export type TmdbKind = 'movie' | 'series'

function cacheKey(kind: TmdbKind, imdbId: string): string {
  // Same key credits.ts has always written, so ids already on disk count.
  return `tmdb:id:${kind}:${imdbId}`
}

function idOf(results: unknown): number {
  const id = Number((results as { id?: unknown }[] | undefined)?.[0]?.id)
  return Number.isInteger(id) && id > 0 ? id : -1
}

/** TMDB's id for an IMDb title, or null when TMDB has none. Throws on network failure (not cached). */
export async function tmdbIdForImdb(
  kind: TmdbKind,
  imdbId: string,
  apiKey: string,
  priority: TaskPriority = 'interactive'
): Promise<number | null> {
  if (!/^tt\d+$/.test(imdbId)) return null
  const db = getDatabase()
  const cached = db.getCache<number>(cacheKey(kind, imdbId))
  if (cached !== null) return cached > 0 ? cached : null

  const url = `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?api_key=${encodeURIComponent(apiKey)}&external_source=imdb_id`
  // `key` coalesces the callers that ask at the same moment on one page open.
  const found = await fetchJson<RawApiPayload>(
    url,
    {},
    { priority, label: 'TMDB id lookup', key: url }
  )
  const movie = idOf(found.movie_results)
  const series = idOf(found.tv_results)
  db.putCache(cacheKey('movie', imdbId), movie, TMDB_ID_TTL_MS)
  db.putCache(cacheKey('series', imdbId), series, TMDB_ID_TTL_MS)
  const value = kind === 'series' ? series : movie
  return value > 0 ? value : null
}

/**
 * TMDB id → IMDb id, cached. The similar-titles panel and the collection
 * strip ran one uncached `external_ids` request per card on every open —
 * up to a dozen identical requests each time the same page was reopened.
 * Learning the pair also fills the forward cache, so a card opened from
 * the panel skips its own `/find`. Empty string when TMDB has no IMDb id
 * (cached too); throws on network failure (not cached).
 */
export async function imdbIdForTmdb(
  kind: TmdbKind,
  tmdbId: number,
  apiKey: string,
  priority: TaskPriority = 'interactive'
): Promise<string> {
  const db = getDatabase()
  const key = `tmdb:imdb:${kind}:${tmdbId}`
  const cached = db.getCache<string>(key)
  if (cached !== null) return cached

  const path = kind === 'series' ? 'tv' : 'movie'
  const url = `https://api.themoviedb.org/3/${path}/${tmdbId}/external_ids?api_key=${encodeURIComponent(apiKey)}`
  const external = await fetchJson<RawApiPayload>(
    url,
    {},
    { priority, label: 'TMDB external ids', key: url }
  )
  const imdbId = /^tt\d+$/.test(String(external.imdb_id ?? '')) ? String(external.imdb_id) : ''
  db.putCache(key, imdbId, TMDB_ID_TTL_MS)
  if (imdbId) db.putCache(cacheKey(kind, imdbId), tmdbId, TMDB_ID_TTL_MS)
  return imdbId
}
