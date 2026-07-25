import type { MediaItem } from '@renderer/types'
import { ACTIVE_ARTWORK_PROVIDER } from './config'
import { demoArtworkProvider } from './providers/demoProvider'
import type { ArtworkSet } from './types'

export type { ArtworkProvider, ArtworkSet } from './types'
export { demoArtworkProvider } from './providers/demoProvider'
export { tmdbArtworkProvider } from './providers/tmdbProvider'
export { createSelfHostedArtworkProvider } from './providers/selfHostedProvider'
export { ACTIVE_ARTWORK_PROVIDER, REMOTE_IMAGE_DOMAINS } from './config'

/**
 * The single call site every component should use to get artwork for a
 * MediaItem. Only wires up the synchronous "demo" provider by default —
 * the TMDB provider is async (a real network call) and not enabled
 * unless NEXT_PUBLIC_ARTWORK_PROVIDER=tmdb *and* an API key is present,
 * per config.ts. Components render synchronously off mock data, so this
 * intentionally stays synchronous rather than forcing every card into a
 * loading state for a provider this repo doesn't actually call.
 */
export function resolveArtwork(item: MediaItem): ArtworkSet {
  if (ACTIVE_ARTWORK_PROVIDER === 'demo') {
    return demoArtworkProvider.getArtwork(item) as ArtworkSet
  }
  // Non-demo providers are async (real network calls) — see
  // providers/tmdbProvider.ts for what's required to wire one up. Until
  // then, fall back to whatever's already on the item so the UI still
  // renders something sensible instead of throwing.
  return {
    posterUrl: item.posterUrl,
    backdropUrl: item.backdropUrl,
    thumbnailUrl: item.thumbnailUrl,
    logoUrl: item.logoUrl
  }
}
