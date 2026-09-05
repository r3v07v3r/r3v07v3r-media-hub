import { useEffect, useState } from 'react'
import styles from './ArtworkImage.module.css'
import {
  nextArtworkState,
  initialArtworkState,
  ARTWORK_RETRY_MS,
  type ArtworkLoadState
} from './artworkRetry'

export interface ArtworkImageProps {
  /** Resolved artwork URL (poster/backdrop/thumbnail/logo). Pass through
   *  resolveArtwork() from src/lib/artwork — never read *Url fields off a
   *  MediaItem directly, so a future provider swap only touches that one
   *  file. Undefined/empty renders the fallback immediately, no skeleton
   *  flash. */
  src?: string
  alt: string
  /** Full title (or subtitle line), rendered as the fallback when there's
   *  no src or the image fails to load. Never initials — per spec, a
   *  1-2 letter mark reads as broken/unfinished for primary artwork. */
  fallbackTitle: string
  fallbackSubtitle?: string
  /** Loading/error-only gradient — see MediaItem.artTint doc comment. */
  artTint: [string, string]
  /** Above-the-fold images (hero backdrop) should set priority so
   *  next/image skips lazy-loading and fetches eagerly. Everything else
   *  (cards, thumbnails, rails) should leave this false/unset. */
  priority?: boolean
  sizes?: string
  /** Wrapper element className — set the sized/aspect-ratio box here
   *  (the component itself is fill-based and inherits its box from this
   *  className or inline style on the wrapper). Required, not optional:
   *  every child is absolutely positioned, so a call site that forgets it
   *  renders a zero-height box and nothing at all — which is exactly how
   *  the calendar's day cells and the planned cards stayed empty. */
  className: string
  /** Extra className applied to the <img> itself, e.g. to tweak
   *  object-position for off-center source art. */
  imageClassName?: string
  objectPosition?: string
  quality?: number
}

/**
 * Shared artwork renderer used everywhere a MediaItem's image shows up
 * (hero backdrop, recommendation cards, continue-watching thumbnails,
 * detail modal, playback overlay). Handles the full lifecycle spec
 * section 9 asked for: skeleton while loading, fade-in on load,
 * lazy-loading by default / eager+priority when asked, and a graceful
 * fallback (tint gradient + full title, never initials) when there's no
 * URL or the image 404s/fails to decode.
 */
export function ArtworkImage({
  src,
  alt,
  fallbackTitle,
  fallbackSubtitle,
  artTint,
  priority = false,
  className,
  imageClassName,
  objectPosition
}: ArtworkImageProps) {
  const [load, setLoad] = useState<ArtworkLoadState>(() => initialArtworkState(src))
  // Tracks the src this status was computed for, so a prop change can
  // reset status during render ("adjusting state while rendering", per
  // React's docs) instead of in an effect — avoids the extra render pass
  // an effect-based reset would cause when a component instance is
  // reused in place (e.g. a carousel item whose media swaps) rather than
  // remounted.
  const [statusSrc, setStatusSrc] = useState(src)
  if (statusSrc !== src) {
    setStatusSrc(src)
    setLoad(initialArtworkState(src))
  }
  // One retry before the fallback. A single failed load used to be
  // terminal for the session: an episode still that 404'd once — a CDN
  // hiccup, a rate limit, a request cancelled by a fast scroll — stayed a
  // tinted placeholder however many times the grid re-rendered, which is
  // most of why episode tiles "loaded inconsistently". The rule lives in
  // artworkRetry.ts so it can be tested; the timer here is the only
  // stateful part, and it is cleared on unmount.
  useEffect(() => {
    if (load.status !== 'retrying') return
    const timer = setTimeout(() => setLoad((s) => nextArtworkState(s, 'retry')), ARTWORK_RETRY_MS)
    return () => clearTimeout(timer)
  }, [load.status])
  const status = load.status

  const showImage = !!src && status !== 'error' && status !== 'retrying'
  const showSkeleton = (showImage && status === 'loading') || status === 'retrying'
  const showFallback = !src || status === 'error'

  return (
    <div className={`${styles.wrap} ${className ?? ''}`}>
      {showSkeleton && (
        <div className={styles.skeleton} aria-hidden="true">
          <span className={styles.skeletonSweep} />
        </div>
      )}
      {showImage && (
        // Plain <img> — next/image's optimization pipeline (remote loader,
        // quality param) doesn't apply outside Next.js. `sizes`/`quality`
        // are accepted as props for call-site compatibility but unused;
        // priority still maps onto eager vs. lazy loading.
        <img
          // Keyed by attempt so the retry mounts a fresh <img>: the browser
          // does not re-request a URL an existing element already failed.
          key={load.attempts}
          src={src as string}
          alt={alt}
          loading={priority ? 'eager' : 'lazy'}
          onLoad={() => setLoad((s) => nextArtworkState(s, 'load'))}
          onError={() => setLoad((s) => nextArtworkState(s, 'error'))}
          className={`${styles.img} ${status === 'loaded' ? styles.imgLoaded : ''} ${imageClassName ?? ''}`}
          style={objectPosition ? { objectPosition } : undefined}
        />
      )}
      {showFallback && (
        <div
          className={styles.fallback}
          style={{ background: `linear-gradient(150deg, ${artTint[0]}, ${artTint[1]})` }}
        >
          <div className={styles.fallbackScrim} />
          <span className={styles.fallbackTitle}>
            {fallbackTitle}
            {fallbackSubtitle && (
              <span className={styles.fallbackSubtitle}>{fallbackSubtitle}</span>
            )}
          </span>
        </div>
      )}
    </div>
  )
}
