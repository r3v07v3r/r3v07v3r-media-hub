import type { MediaItem } from '@renderer/types'
import type { ArtworkProvider, ArtworkSet } from '../types'

/**
 * Shape for a self-hosted media server (Jellyfin or Plex). Both expose
 * artwork over HTTP from a server the user runs themselves, so unlike
 * TMDB there's no fixed public hostname to pre-register in
 * config.ts's remotePatterns — the developer's own server URL has to be
 * added there before next/image will load from it.
 *
 * Jellyfin: `${serverUrl}/Items/${itemId}/Images/Primary` (poster) and
 *   `.../Images/Backdrop/0` (backdrop) — see
 *   https://api.jellyfin.org/#tag/Image.
 * Plex: `${serverUrl}/library/metadata/${ratingKey}/thumb` (poster) and
 *   `.../art` (backdrop), both requiring `?X-Plex-Token=...` — see
 *   https://python-plexapi.readthedocs.io/.
 *
 * This is intentionally not implemented against a live server: there is
 * no self-hosted instance reachable from this environment to test
 * against, and shipping a guessed integration untested would be worse
 * than an honest stub. `kind` picks which URL-construction rules to
 * apply once `baseUrl`/credentials are supplied.
 */
export function createSelfHostedArtworkProvider(options: {
  kind: 'jellyfin' | 'plex'
  baseUrl: string
  apiKeyOrToken: string
}): ArtworkProvider {
  const { kind, baseUrl, apiKeyOrToken } = options
  return {
    id: kind,
    name: kind === 'jellyfin' ? 'Jellyfin' : 'Plex',
    getArtwork(item: MediaItem): ArtworkSet {
      // `item.id` here would need to be the *server's* item id, not this
      // repo's mock id scheme (m-1, s-2, ...) — mapping mock catalog
      // entries to real server ids is left to whoever wires this up,
      // since it depends entirely on their library contents.
      if (kind === 'jellyfin') {
        return {
          posterUrl: `${baseUrl}/Items/${item.id}/Images/Primary?api_key=${apiKeyOrToken}`,
          backdropUrl: `${baseUrl}/Items/${item.id}/Images/Backdrop/0?api_key=${apiKeyOrToken}`
        }
      }
      return {
        posterUrl: `${baseUrl}/library/metadata/${item.id}/thumb?X-Plex-Token=${apiKeyOrToken}`,
        backdropUrl: `${baseUrl}/library/metadata/${item.id}/art?X-Plex-Token=${apiKeyOrToken}`
      }
    }
  }
}
