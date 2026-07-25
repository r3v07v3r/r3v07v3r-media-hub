// Artwork provider abstraction. Every component that needs an image for
// a MediaItem goes through `resolveArtwork()` (see index.ts) rather than
// reading `.posterUrl`/`.backdropUrl` off the item directly — that's
// what makes it possible to later swap the demo static-asset provider
// for TMDB, a self-hosted Jellyfin/Plex server, or a local media scanner
// without touching any component.

import type { MediaItem } from '@renderer/types'

/** The set of image URLs a provider can resolve for one item. All
 *  optional — a provider is free to only know about posters, say, and
 *  leave backdrop/thumbnail/logo undefined; the caller (ArtworkImage)
 *  falls back to the tint+title treatment for whichever one is missing. */
export interface ArtworkSet {
  posterUrl?: string
  backdropUrl?: string
  thumbnailUrl?: string
  logoUrl?: string
}

export interface ArtworkProvider {
  /** Short id used in logs/config, e.g. "demo", "tmdb", "jellyfin". */
  readonly id: string
  /** Human-readable name for settings/about screens. */
  readonly name: string
  /** Resolve whatever artwork this provider has for the given item.
   *  Synchronous providers (static demo assets already attached to the
   *  MediaItem) can just return the value; network providers return a
   *  Promise. Components that render synchronously (SSR-safe mock data)
   *  should prefer `resolveArtworkSync`, which only works with providers
   *  that don't need to await anything. */
  getArtwork(item: MediaItem): ArtworkSet | Promise<ArtworkSet>
}
