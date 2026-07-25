import { useState } from 'react'
import styles from './ArtworkImage.module.css'

type LoadStatus = 'loading' | 'loaded' | 'error'

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
   *  className or inline style on the wrapper). */
  className?: string
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
  const [status, setStatus] = useState<LoadStatus>(src ? 'loading' : 'error')
  // Tracks the src this status was computed for, so a prop change can
  // reset status during render ("adjusting state while rendering", per
  // React's docs) instead of in an effect — avoids the extra render pass
  // an effect-based reset would cause when a component instance is
  // reused in place (e.g. a carousel item whose media swaps) rather than
  // remounted.
  const [statusSrc, setStatusSrc] = useState(src)
  if (statusSrc !== src) {
    setStatusSrc(src)
    setStatus(src ? 'loading' : 'error')
  }

  const showImage = !!src && status !== 'error'
  const showSkeleton = showImage && status === 'loading'
  const showFallback = !showImage

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
          src={src as string}
          alt={alt}
          loading={priority ? 'eager' : 'lazy'}
          onLoad={() => setStatus('loaded')}
          onError={() => setStatus('error')}
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
