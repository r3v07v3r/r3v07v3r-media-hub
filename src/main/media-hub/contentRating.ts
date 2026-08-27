// How a title is rated for age, where you are.
//
// The app showed critic scores, a community score and its own match figure,
// and never once said whether something was a 12 or an 18. Every competitor
// surfaces it, TMDB carries it, and Phase 5's parental controls cannot be
// built at all without it — a per-profile ceiling needs something to compare
// against.
//
// REGION-SCOPED, like the watch providers beside it and for the same reason:
// certification bodies are national. The same film is PG-13 in the US, 12A in
// the UK and 12 in Germany, and picking one country's answer to show everyone
// would be inventing a fact rather than reporting one.

import type { MediaKind } from '../../shared/media-hub/types'
import { fetchJson } from './httpClient'
import { getDatabase } from './dbState'
import { tmdbCredentials } from './settingsStore'
import { watchRegion } from './watchProviders'

/** Thirty days. A certificate is assigned once and effectively never moves. */
const TTL_MS = 30 * 24 * 60 * 60 * 1000

interface RawMovieRelease {
  iso_3166_1?: unknown
  release_dates?: { certification?: unknown }[]
}

interface RawShowRating {
  iso_3166_1?: unknown
  rating?: unknown
}

/**
 * The certificate for `imdbId` in the current region, or '' when there is
 * none.
 *
 * Empty is a perfectly ordinary answer — plenty of titles are unrated in
 * plenty of countries — and is cached as one. The alternative, falling back to
 * some other country's certificate, would put a US rating under a UK flag and
 * be worse than saying nothing.
 */
export async function contentRating(kind: MediaKind, imdbId: string): Promise<string> {
  // Anime is Kitsu-identified and TMDB's lookup takes an IMDb id — the same
  // reason the providers panel and the Servarr request skip it.
  if (kind === 'anime' || !/^tt\d+$/.test(imdbId)) return ''
  const { apiKey } = tmdbCredentials()
  if (!apiKey) return ''

  const region = watchRegion()
  const db = getDatabase()
  const cacheKey = `certification:v1:${kind}:${imdbId}:${region}`
  const cached = db.getCache<string>(cacheKey)
  if (cached !== null) return cached

  const auth = `api_key=${encodeURIComponent(apiKey)}`
  try {
    const found = await fetchJson<{
      movie_results?: { id?: unknown }[]
      tv_results?: { id?: unknown }[]
    }>(
      `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?${auth}&external_source=imdb_id`
    )
    const results = kind === 'series' ? found.tv_results : found.movie_results
    const tmdbId = Number(results?.[0]?.id)
    if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
      db.putCache(cacheKey, '', TTL_MS)
      return ''
    }

    // The two kinds are on different endpoints with different shapes, which is
    // why this is not one call with a variable path segment.
    let rating = ''
    if (kind === 'series') {
      const payload = await fetchJson<{ results?: RawShowRating[] }>(
        `https://api.themoviedb.org/3/tv/${tmdbId}/content_ratings?${auth}`
      )
      const entry = (payload.results ?? []).find((row) => String(row?.iso_3166_1) === region)
      rating = String(entry?.rating ?? '').trim()
    } else {
      const payload = await fetchJson<{ results?: RawMovieRelease[] }>(
        `https://api.themoviedb.org/3/movie/${tmdbId}/release_dates?${auth}`
      )
      const entry = (payload.results ?? []).find((row) => String(row?.iso_3166_1) === region)
      // A country can list several releases (theatrical, digital, physical)
      // and only some carry a certificate — the first non-empty one is the
      // country's answer.
      rating = String(
        (entry?.release_dates ?? [])
          .map((r) => String(r?.certification ?? '').trim())
          .find(Boolean) ?? ''
      )
    }

    db.putCache(cacheKey, rating, TTL_MS)
    return rating
  } catch {
    // Not cached: a failure here is the network, and a month is far too long
    // to remember one.
    return ''
  }
}
