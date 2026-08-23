'use client'

import type { ContinueWatchingItem, MediaItem } from '@renderer/types'
import type { DetailAdapterConfig } from '@renderer/lib/mediaHub/detailAdapters'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './ProgressPanel.module.css'

export interface ProgressPanelProps {
  config: DetailAdapterConfig
  media: MediaItem
  /** Watched-vs-total over this title's REAL episode list, from the same
   *  tracking:list history the episode grid marks its tiles from (see
   *  MediaDetailPage's episodeStats).
   *
   *  This is the only trustworthy source for the episodic counts below.
   *  The two things this panel used to derive them from both report zero
   *  for most titles: `media.watched`/`media.completed` are
   *  unconditionally false here (catalogItemToMediaItem is called without
   *  watchedIds/history on this page — see MediaDetailPage's own comment
   *  on movieWatched), and `continueEntry` only exists while a show is in
   *  Continue Watching at all, which a fully-watched show — or one whose
   *  episodes were marked from the grid rather than played through — never
   *  is. The visible symptom was a show with a screen full of "Watched"
   *  tiles reading 0 watched / 0% / every episode unwatched.
   *
   *  Null when there's no episode list to count (a movie, or the degraded
   *  no-bridge path), which falls the episodic branch back to the old
   *  continueEntry derivation rather than showing a confident zero. */
  episodeStats: { watchedCount: number; total: number } | null
  continueEntry: ContinueWatchingItem | undefined
  inMyList: boolean
  onToggleMyList: () => void
  onOpenLastWatched: () => void
  /** Used in the config.isEpisodic:false branch only — media.watched/
   *  completed can't be trusted here (see MediaDetailPage's own comment on
   *  why: the catalogItemToMediaItem call that builds `media` never gets
   *  watchedIds/history), so the caller passes the real value (derived
   *  from its own tracking:list fetch) and the toggle handler for it
   *  directly. Still required from every caller (not just movie pages) —
   *  this component has exactly one call site today and keeping both
   *  props unconditional there is simpler than threading an optional
   *  pair through just for a branch this page's other kind never hits. */
  movieWatched: boolean
  onToggleMovieWatched: (watched: boolean) => void
}

/**
 * The three episodic numbers, from the best source available.
 *
 * `episodeStats` (this page's own episode list crossed with its own
 * tracking history) is preferred whenever there IS an episode list, and
 * is the only branch that runs in practice for a series/anime the
 * catalog:meta fetch succeeded for. The continueEntry/media fallback
 * below only covers the degraded case where there's no episode list to
 * count — an aggregate percentage against `media.totalEpisodes`, which
 * is at least directionally right, and an em dash rather than a made-up
 * zero when even that is missing.
 */
function episodicCounts(
  media: MediaItem,
  episodeStats: { watchedCount: number; total: number } | null,
  continueEntry: ContinueWatchingItem | undefined
): { watched: number; unwatched: number | null; percent: number } {
  if (episodeStats) {
    return {
      watched: episodeStats.watchedCount,
      unwatched: episodeStats.total - episodeStats.watchedCount,
      percent: episodeStats.total
        ? Math.round((episodeStats.watchedCount / episodeStats.total) * 100)
        : 0
    }
  }
  const percent = continueEntry?.media.progressPercentage ?? (media.completed ? 100 : 0)
  const total = media.totalEpisodes ?? null
  const watched = total != null ? Math.round((percent * total) / 100) : 0
  return { watched, unwatched: total != null ? Math.max(0, total - watched) : null, percent }
}

/**
 * Series/anime: following state + watched/unwatched episode counts +
 * overall progress + last watched. Movies: watched state + playback
 * percentage + last watched date + remaining runtime — the same panel,
 * config.isEpisodic switches which numbers it shows rather than two
 * separate components, since both variants are "tracked state + progress
 * + last activity" underneath.
 *
 * Not implemented here: "mark all watched" / "reset progress" (the
 * backend has tracking:mark-season-watched for the former, but no bulk
 * reset endpoint at all — building that safely, with a real confirmation
 * step, was out of scope for this pass). Follow/unfollow and "open last
 * watched" are both fully wired to real tracking data.
 */
export function ProgressPanel({
  config,
  media,
  episodeStats,
  continueEntry,
  inMyList,
  onToggleMyList,
  onOpenLastWatched,
  movieWatched,
  onToggleMovieWatched
}: ProgressPanelProps) {
  const episodic = episodicCounts(media, episodeStats, continueEntry)

  return (
    <section className={`${styles.panel} glass-panel`} aria-label="Tracked and progress">
      <div className={styles.headerRow}>
        <h2 className={styles.heading}>Tracked &amp; Progress</h2>
        <button
          type="button"
          className={`${styles.followChip} ${inMyList ? styles.followChipActive : ''}`}
          aria-pressed={inMyList}
          onClick={onToggleMyList}
        >
          {inMyList ? config.trackedLabel : config.trackLabel}
        </button>
      </div>

      {config.isEpisodic ? (
        <>
          <div className={styles.statRow}>
            <div className={styles.stat}>
              <span className={styles.statValue}>{episodic.watched}</span>
              <span className={styles.statLabel}>Watched</span>
            </div>
            <div className={styles.progressCircle}>
              <svg viewBox="0 0 72 72" className={styles.progressSvg}>
                <circle cx="36" cy="36" r="30" className={styles.progressTrack} />
                <circle
                  cx="36"
                  cy="36"
                  r="30"
                  className={styles.progressFill}
                  style={{
                    strokeDasharray: 2 * Math.PI * 30,
                    strokeDashoffset: 2 * Math.PI * 30 * (1 - episodic.percent / 100)
                  }}
                />
              </svg>
              <span className={styles.progressValue}>{episodic.percent}%</span>
              <span className={styles.progressLabel}>Progress</span>
            </div>
            <div className={styles.stat}>
              <span className={styles.statValue}>{episodic.unwatched ?? '—'}</span>
              <span className={styles.statLabel}>Unwatched</span>
            </div>
          </div>
          {continueEntry && (
            <button type="button" className={styles.lastWatchedRow} onClick={onOpenLastWatched}>
              <Icon name="play" size={13} />
              <span>
                S{continueEntry.media.seasonNumber} · E{continueEntry.media.episodeNumber}
                {continueEntry.media.episodeTitle ? ` — ${continueEntry.media.episodeTitle}` : ''}
              </span>
            </button>
          )}
        </>
      ) : (
        <div className={styles.movieStats}>
          <button
            type="button"
            className={`${styles.watchedToggle} ${movieWatched ? styles.watchedToggleActive : ''}`}
            aria-pressed={movieWatched}
            onClick={() => onToggleMovieWatched(!movieWatched)}
          >
            <Icon name={movieWatched ? 'check' : 'eye'} size={13} />
            {movieWatched
              ? 'Watched'
              : media.progressPercentage
                ? `${media.progressPercentage}% watched`
                : 'Not started'}
          </button>
          {media.remainingMinutes != null && !movieWatched && (
            <span className={styles.movieStatLine}>{media.remainingMinutes}m remaining</span>
          )}
          {continueEntry?.lastPlayedAt && (
            <span className={styles.movieStatLine}>
              Last watched {new Date(continueEntry.lastPlayedAt).toLocaleDateString()}
            </span>
          )}
        </div>
      )}
    </section>
  )
}
