// The load-state rule behind ArtworkImage, kept out of the .tsx so it can
// be tested without a DOM: tests/artworkRetry.test.ts.
//
// A failed image load gets ONE retry before the tinted fallback. That is
// enough to absorb the transient failures that made episode tiles render
// inconsistently — a CDN hiccup, a rate limit, a request the browser
// cancelled during a fast scroll — without turning a genuinely dead URL
// into a request loop.

export type ArtworkLoadStatus = 'loading' | 'retrying' | 'loaded' | 'error'

export interface ArtworkLoadState {
  status: ArtworkLoadStatus
  /** How many loads have been started for this src. Also the <img> key, so a
   *  retry mounts a fresh element the browser will actually re-request. */
  attempts: number
}

/** How long a retry waits: long enough for a burst of failures to pass. */
export const ARTWORK_RETRY_MS = 1200

/** One retry, then the fallback. */
export const ARTWORK_MAX_RETRIES = 1

export function initialArtworkState(src: string | undefined | null): ArtworkLoadState {
  return { status: src ? 'loading' : 'error', attempts: 0 }
}

/**
 * The next state for one event.
 *
 *  - 'error' while attempts are left: 'retrying' (the caller waits
 *    ARTWORK_RETRY_MS, then sends 'retry'); with none left: 'error'.
 *  - 'retry': back to 'loading' with a new attempt number, which remounts
 *    the image.
 *  - 'load': 'loaded'.
 */
export function nextArtworkState(
  state: ArtworkLoadState,
  event: 'error' | 'load' | 'retry'
): ArtworkLoadState {
  switch (event) {
    case 'load':
      return state.status === 'loaded' ? state : { ...state, status: 'loaded' }
    case 'error':
      return state.attempts < ARTWORK_MAX_RETRIES
        ? { ...state, status: 'retrying' }
        : { ...state, status: 'error' }
    case 'retry':
      return state.status === 'retrying'
        ? { status: 'loading', attempts: state.attempts + 1 }
        : state
    default:
      return state
  }
}

/**
 * Which picture an episode tile shows: the episode's own still when the
 * source supplied one, else the show's art, else nothing (the tinted
 * fallback). Pure, so tests/artworkRetry.test.ts pins it beside the retry.
 */
export function episodeStillOrShowArt(
  episode: { thumbnail?: string | null } | null | undefined,
  showArtwork: string | undefined
): string | undefined {
  const still = String(episode?.thumbnail ?? '').trim()
  if (still) return still
  const art = String(showArtwork ?? '').trim()
  return art || undefined
}
