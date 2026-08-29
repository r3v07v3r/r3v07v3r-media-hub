// The other films in the same series.
//
// TMDB has modelled this for years and this app already fetched it: the
// similar-titles pass reads a movie's collection purely to SUBTRACT its
// siblings, so that "more like this" does not just list the sequels. The data
// arrives, gets used as an exclusion list, and is thrown away — while the
// question people actually have on a film's page ("what order does this go in,
// and have I seen the others") had no answer anywhere.
//
// Movies only. TMDB models collections for films; a series' "franchise" has no
// equivalent field, and the app's own anime franchise grouping (animeSeasons.ts)
// already answers the same question for the one kind that needed it.

import type { CatalogItem, TitleCollectionResult } from '../../shared/media-hub/types'
import { fetchJson } from './httpClient'
import { getDatabase } from './dbState'
import { logError } from './logger'
import { tmdbCredentials } from './settingsStore'

/**
 * Thirty days. Which films are in a series is about as fixed as facts get —
 * it changes when a sequel is announced, not on any schedule worth polling —
 * and this sits on the path of opening a title page.
 */
const TTL_MS = 30 * 24 * 60 * 60 * 1000

interface RawPart {
  id?: unknown
  title?: unknown
  poster_path?: unknown
  release_date?: unknown
}

const EMPTY: TitleCollectionResult = { name: '', parts: [] }

/**
 * The collection `imdbId` belongs to, with every part resolved back to an
 * IMDb id.
 *
 * The resolution matters more than it looks. TMDB answers in TMDB ids, and
 * this app's movie catalog is keyed by IMDb — so a part left unresolved is a
 * card that cannot be opened, which is worse than not listing it. Parts that
 * carry no IMDb id are dropped rather than shown as dead entries.
 */
export async function titleCollection(imdbId: string): Promise<TitleCollectionResult> {
  if (!/^tt\d+$/.test(imdbId)) return EMPTY
  const { apiKey } = tmdbCredentials()
  if (!apiKey) return EMPTY

  const db = getDatabase()
  // v2, not v1: entries written before the parts below carried a complete
  // CatalogItem are the malformed shape that crashed the detail page, and
  // they live for a month. Bumping the key retires them on first read
  // rather than leaving anyone who already opened a franchise film with a
  // black window until the TTL runs out.
  const cacheKey = `collection:v2:${imdbId}`
  const cached = db.getCache<TitleCollectionResult>(cacheKey)
  if (cached) return cached

  const auth = `api_key=${encodeURIComponent(apiKey)}`
  try {
    const found = await fetchJson<{ movie_results?: { id?: unknown }[] }>(
      `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?${auth}&external_source=imdb_id`
    )
    const sourceId = Number(found.movie_results?.[0]?.id)
    if (!Number.isFinite(sourceId) || sourceId <= 0) {
      // Cached empty: a film TMDB has never heard of will not be there
      // tomorrow either, and this is on a page-open path.
      db.putCache(cacheKey, EMPTY, TTL_MS)
      return EMPTY
    }

    const detail = await fetchJson<{
      belongs_to_collection?: { id?: unknown; name?: unknown } | null
    }>(`https://api.themoviedb.org/3/movie/${sourceId}?${auth}`)
    const collectionId = Number(detail.belongs_to_collection?.id)
    if (!Number.isFinite(collectionId) || collectionId <= 0) {
      // Most films are in no collection at all. That is a real answer and
      // deserves caching just as much as a hit.
      db.putCache(cacheKey, EMPTY, TTL_MS)
      return EMPTY
    }

    const collection = await fetchJson<{ name?: unknown; parts?: RawPart[] }>(
      `https://api.themoviedb.org/3/collection/${collectionId}?${auth}`
    )

    const parts = (
      await Promise.all(
        (collection.parts ?? []).map(async (part): Promise<CatalogItem | null> => {
          const partId = Number(part?.id)
          if (!Number.isFinite(partId) || partId === sourceId) return null
          try {
            const external = await fetchJson<{ imdb_id?: unknown }>(
              `https://api.themoviedb.org/3/movie/${partId}/external_ids?${auth}`
            )
            const partImdb = String(external.imdb_id ?? '')
            if (!/^tt\d+$/.test(partImdb)) return null
            const poster = String(part?.poster_path ?? '')
            const released = String(part?.release_date ?? '')
            // Every field CatalogItem declares, not just the five this
            // panel happens to draw. A part built with a cast over a partial
            // object crossed the IPC boundary as a CatalogItem-shaped lie,
            // and the renderer's catalogItemToMediaItem — which reads
            // `genres` unguarded — threw on the missing array, taking the
            // whole React tree down with it: opening any film that belongs
            // to a TMDB collection blanked the window. The empty strings
            // and arrays are what "TMDB's collection endpoint does not
            // carry this" honestly looks like.
            return {
              id: partImdb,
              type: 'movie',
              title: String(part?.title ?? 'Untitled'),
              poster: poster ? `https://image.tmdb.org/t/p/w342${poster}` : '',
              background: '',
              logo: '',
              year: released.slice(0, 4),
              description: '',
              rating: '',
              runtime: '',
              genres: [],
              videos: [],
              trailers: []
            }
          } catch {
            return null
          }
        })
      )
    ).filter((part): part is CatalogItem => Boolean(part))

    // Release order, which is the order people mean by "what comes next" —
    // TMDB returns parts in its own order and a film with no date sorts last
    // rather than pretending to be the earliest.
    parts.sort((a, b) => (a.year || '9999').localeCompare(b.year || '9999'))

    const result: TitleCollectionResult = {
      name: String(collection.name ?? ''),
      parts
    }
    db.putCache(cacheKey, result, TTL_MS)
    return result
  } catch (error) {
    // Not cached — unlike a genuine "no collection", a failure here is usually
    // the network, and a temporary outage should not be remembered for a
    // month.
    logError('catalog:collection', error)
    return EMPTY
  }
}
