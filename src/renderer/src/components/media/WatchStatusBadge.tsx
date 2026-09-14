import type { WatchStatus } from '@renderer/lib/mediaHub/watchStatus'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './WatchStatusBadge.module.css'

const BADGE: Record<
  Exclude<WatchStatus['state'], 'unwatched'>,
  { label: string; className: string; icon: 'check' | 'clock' | null }
> = {
  planned: { label: 'Planned', className: styles.planned, icon: 'clock' },
  'in-progress': { label: 'In Progress', className: styles.inProgress, icon: null },
  watched: { label: 'Watched', className: styles.watched, icon: 'check' },
  completed: { label: 'Completed', className: styles.completed, icon: 'check' }
}

/**
 * Corner badge + bottom progress sliver for any card showing a MediaItem —
 * see lib/mediaHub/watchStatus.ts for how the status itself is derived.
 * Renders nothing for 'unwatched' (no badge is itself the "not started"
 * signal, per the reference design) and no progress bar for a plain
 * 'watched' movie or a 'planned' title (nothing meaningful to show a
 * fraction of).
 *
 * `compact` drops the text label down to just an icon (a dot for
 * in-progress, a clock for planned, a tick for watched/completed) and
 * thins the progress bar — for small tiles (MoodBrowser's ~110x66 result
 * cards, the collection panel's 38px posters) where the full pill would
 * be wider than the tile itself.
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
  const hasProgress = status.state === 'in-progress' || status.state === 'completed'

  return (
    <>
      <span
        className={`${styles.badge} ${badge.className} ${compact ? styles.badgeCompact : ''}`}
        aria-label={badge.label}
      >
        {badge.icon ? (
          <Icon name={badge.icon} size={10} />
        ) : compact ? (
          <span className={styles.dot} aria-hidden="true" />
        ) : null}
        {!compact && badge.label}
      </span>
      {hasProgress && (
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
