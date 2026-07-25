import type { MediaItem } from '@renderer/types'
import type { ArtworkProvider, ArtworkSet } from '../types'

/**
 * Static demo mode (spec section 11). This is the "provider" backing
 * mockData.ts: the URLs already live on each MediaItem (pointing at
 * files under public/media/{posters,backdrops,thumbnails}/ that ship
 * with this repo, or at remote URLs you configure), so resolving
 * artwork is just reading those fields straight off the item.
 *
 * To use your own artwork instead of the bundled originals:
 *   1. Drop legally-obtained image files into public/media/posters/,
 *      public/media/backdrops/, and public/media/thumbnails/.
 *   2. Point the relevant `posterUrl`/`backdropUrl`/`thumbnailUrl` field
 *      in src/data/mockData.ts at "/media/posters/your-file.jpg" (or a
 *      remote https:// URL, once its domain is added to
 *      src/lib/artwork/config.ts's remotePatterns list).
 *   3. Leave a field undefined to see the graceful fallback (dark
 *      gradient + full title, never initials) — useful for confirming
 *      the fallback path still looks right.
 *
 * No image generation is required or expected — this provider does not
 * fetch or synthesize anything, it only reads what's already there.
 */
export const demoArtworkProvider: ArtworkProvider = {
  id: 'demo',
  name: 'Static demo assets',
  getArtwork(item: MediaItem): ArtworkSet {
    return {
      posterUrl: item.posterUrl,
      backdropUrl: item.backdropUrl,
      thumbnailUrl: item.thumbnailUrl,
      logoUrl: item.logoUrl
    }
  }
}
