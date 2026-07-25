import type { MediaItem } from '@renderer/types'
import type { ArtworkProvider, ArtworkSet } from '../types'

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p'

/**
 * The Movie Database (TMDB) provider — NOT active unless
 * VITE_TMDB_API_KEY is set (see config.ts). Included so the
 * integration shape is real code, not a comment, but this repo never
 * calls out to TMDB on its own: no key ships with it, and
 * getArtwork() below throws instead of silently no-op'ing if it's ever
 * invoked without one, so a misconfiguration fails loudly in
 * development rather than quietly falling back.
 *
 * Wiring this up for real requires:
 *   1. A free TMDB API key (https://www.themoviedb.org/settings/api).
 *   2. VITE_TMDB_API_KEY set in your environment.
 *   3. Resolving each MediaItem to a TMDB id (a `/search/movie` or
 *      `/search/tv` call keyed on title+year — not implemented here,
 *      since that's a real network call this demo repo shouldn't make
 *      on your behalf) and using that id to fetch `/movie/{id}/images`
 *      or `/tv/{id}/images` for the actual poster_path/backdrop_path.
 *   4. `image.tmdb.org` is already in config.ts's remotePatterns, so
 *      next/image will accept the resulting URLs once you wire step 3.
 */
export const tmdbArtworkProvider: ArtworkProvider = {
  id: 'tmdb',
  name: 'TMDB',
  async getArtwork(item: MediaItem): Promise<ArtworkSet> {
    const apiKey = import.meta.env.VITE_TMDB_API_KEY
    if (!apiKey) {
      throw new Error(
        'tmdbArtworkProvider.getArtwork() called without VITE_TMDB_API_KEY set. ' +
          'Set the key or switch VITE_ARTWORK_PROVIDER back to "demo" in your env.'
      )
    }
    // Left unimplemented on purpose — see the module doc comment above
    // for what step 3 (title -> TMDB id -> image paths) requires. The
    // constant below documents the URL shape once you have a path:
    //   `${TMDB_IMAGE_BASE}/w780${backdrop_path}`
    void TMDB_IMAGE_BASE
    void item
    throw new Error(
      'tmdbArtworkProvider is a documented stub — see the doc comment for wiring steps.'
    )
  }
}
