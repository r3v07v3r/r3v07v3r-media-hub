import './PosterSkeleton.css'

/**
 * A placeholder the same box as PosterCard (2/3 art, the same radius, one
 * text-line bar beneath) — shown wherever a grid or row's data hasn't
 * arrived yet, so "loading" reads as its own state instead of a grid that
 * is simply empty (see the task brief). Purely decorative: no image, no
 * link, nothing a screen reader or the D-pad nav should ever stop on.
 */
export default function PosterSkeleton() {
  return (
    <span className="poster-skeleton" aria-hidden="true">
      <span className="poster-skeleton__art skeleton-bar" />
      <span className="poster-skeleton__line skeleton-bar" />
    </span>
  )
}
