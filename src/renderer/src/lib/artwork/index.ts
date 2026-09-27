import type { MediaItem } from '@renderer/types'
import { demoArtworkProvider } from './providers/demoProvider'
import type { ArtworkSet } from './types'

export type { ArtworkProvider, ArtworkSet } from './types'
export { demoArtworkProvider } from './providers/demoProvider'
export { REMOTE_IMAGE_DOMAINS } from './config'

/**
 * The single call site every component should use to get artwork for a
 * MediaItem. There is one provider and it is synchronous: it reads the
 * URLs the catalogue adapter already attached to the item (see
 * providers/demoProvider.ts), so no card has to wait in a loading state.
 */
export function resolveArtwork(item: MediaItem): ArtworkSet {
  return demoArtworkProvider.getArtwork(item) as ArtworkSet
}
