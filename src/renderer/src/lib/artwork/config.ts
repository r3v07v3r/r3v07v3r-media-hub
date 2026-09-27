// Single source of truth for artwork-provider configuration (spec
// section 10: "Keep all image-provider configuration in one file").

/**
 * Hostnames a remote-image loader is allowed to fetch from. Self-hosted
 * media servers are deliberately NOT listed here — they're different per
 * deployment.
 */
export const REMOTE_IMAGE_DOMAINS: string[] = [
  // TMDB's image CDN.
  'image.tmdb.org'
]
