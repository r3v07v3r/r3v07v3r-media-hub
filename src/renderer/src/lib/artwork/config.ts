// Single source of truth for artwork-provider configuration (spec
// section 10: "Keep all image-provider configuration in one file").

/** Which provider is active. "demo" (default) reads the URLs already
 *  already attached to each MediaItem by the catalogue adapter — see
 *  providers/
 *  demoProvider.ts. Switch via VITE_ARTWORK_PROVIDER (a .env file read by
 *  Vite's import.meta.env, the Vite equivalent of Next's NEXT_PUBLIC_*
 *  vars) for local testing; nothing else in the app needs to change. */
export type ArtworkProviderId = 'demo' | 'tmdb'

export const ACTIVE_ARTWORK_PROVIDER: ArtworkProviderId =
  (import.meta.env.VITE_ARTWORK_PROVIDER as ArtworkProviderId | undefined) ?? 'demo'

/**
 * Hostnames a remote-image loader is allowed to fetch from. Self-hosted
 * Jellyfin/Plex servers are deliberately NOT listed here — they're
 * different per deployment, so add your own server's hostname if you wire
 * up createSelfHostedArtworkProvider (see providers/selfHostedProvider.ts).
 */
export const REMOTE_IMAGE_DOMAINS: string[] = [
  // TMDB's image CDN — see providers/tmdbProvider.ts.
  'image.tmdb.org'
]
