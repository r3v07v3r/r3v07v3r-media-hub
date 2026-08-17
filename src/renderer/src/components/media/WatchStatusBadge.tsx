import type { WatchStatus } from '@renderer/lib/mediaHub/watchStatus'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './WatchStatusBadge.module.css'

const BADGE: Record<
  Exclude<WatchStatus['state'], 'unwatched'>,
  { label: string; className: string }
> = {
  'in-progress': { label: 'In Progress', className: styles.inProgress },
  watched: { label: 'Watched', className: styles.watched },
  completed: { label: 'Completed', className: styles.completed }
}

/**
 * Corner badge + bottom progress sliver for any card showing a MediaItem —
 * see lib/mediaHub/watchStatus.ts for how the status itself is derived.
 * Renders nothing for 'unwatched' (no badge is itself the "not started"
 * signal, per the reference design) and no progress bar for a plain
 * 'watched' movie (nothing meaningful to show a fraction of).
 *
 * `compact` drops the text label down to just an icon (a dot for
 * in-progress, a check for watched/completed) and thins the progress bar —
 * for small tiles (MoodBrowser's ~110x66 result cards) where the full
 * "In Progress"/"Completed" pill would be wider than the tile itself.
 */
export function WatchStatusBadge({
  status,
  compact = false
}: {
  status: WatchStatus
  compact?: boolean
}) {
  if (status.state === 'unwatched') return null
  const badge = BADGE[status.state]

  return (
    <>
      <span
        className={`${styles.badge} ${badge.className} ${compact ? styles.badgeCompact : ''}`}
        aria-label={badge.label}
      >
        {status.state === 'in-progress' ? (
          compact ? (
            <span className={styles.dot} aria-hidden="true" />
          ) : null
        ) : (
          <Icon name="check" size={10} />
        )}
        {!compact && badge.label}
      </span>
      {status.state !== 'watched' && (
        <div
          className={`${styles.progressTrack} ${compact ? styles.progressTrackCompact : ''}`}
          role="progressbar"
          aria-label="Watch progress"
          aria-valuenow={status.progressPercentage}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={`${styles.progressFill} ${status.state === 'completed' ? styles.progressFillDone : ''}`}
            style={{ width: `${status.progressPercentage}%` }}
          />
        </div>
      )}
    </>
  )
}
