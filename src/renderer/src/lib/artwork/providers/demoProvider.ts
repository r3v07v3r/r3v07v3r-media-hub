import type { MediaItem } from '@renderer/types'
import type { ArtworkProvider, ArtworkSet } from '../types'

/**
 * The default provider, and the one the app actually runs on: every
 * MediaItem already carries the artwork URLs the catalogue resolved for
 * it (see adapters.ts's catalogItemToMediaItem), so "resolving" artwork
 * is reading those fields straight off the item.
 *
 * A field left undefined falls back to the dark gradient + full title
 * (never initials) — see ArtworkImage.
 *
 * No image generation or fetching happens here; this provider does not
 * synthesize anything, it only reads what's already there. The name is
 * historical: it dates from when these URLs were hand-written on a demo
 * catalogue rather than resolved from a real one.
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
