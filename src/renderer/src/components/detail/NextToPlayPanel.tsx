'use client'

import type { MediaItem } from '@renderer/types'
import type { Episode } from '@shared/media-hub/types'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import { resolveArtwork } from '@renderer/lib/artwork'
import { ArtworkImage } from '@renderer/components/media/ArtworkImage'
import styles from './NextToPlayPanel.module.css'

export interface NextToPlayPanelProps {
  media: MediaItem
  /** Series/anime only — MediaDetailPage no longer renders this panel for
   *  movies at all (its old movie-specific "Ready to Watch"/"Resume
   *  Watching" variant below just duplicated the hero's own Play button).
   *  Null here now means either "every known episode is watched" (see
   *  allWatched) or "no episode data for this title yet." */
  nextEpisode: Episode | null
  allWatched: boolean
  onPlay: (episode?: Episode) => void
}

/**
 * Series/anime only: the next unwatched episode, "you're all caught up,"
 * or — when there's no episode data at all yet — a generic play/resume
 * card for the title itself rather than an empty episode panel.
 */
export function NextToPlayPanel({ media, nextEpisode, allWatched, onPlay }: NextToPlayPanelProps) {
  const artwork = resolveArtwork(media)
  const { resolvingMedia } = useAppState()
  const isResolving = resolvingMedia?.id === media.id
  const resolveLabel = resolvingMedia?.stage === 'buffering' ? 'Preparing…' : 'Searching…'

  if (!nextEpisode && !allWatched) {
    // No episode data available for this series/anime yet.
    return (
      <section className={`${styles.panel} glass-panel`} aria-label="Playback">
        <span className={styles.heading}>
          <Icon name="play" size={14} />
          {media.progressPercentage ? 'Resume Watching' : 'Ready to Watch'}
        </span>
        <div className={styles.movieRow}>
          <ArtworkImage
            src={artwork.thumbnailUrl ?? artwork.posterUrl}
            alt=""
            fallbackTitle={media.title}
            artTint={media.artTint}
            className={styles.thumb}
          />
          <div className={styles.movieInfo}>
            <span className={styles.title}>{media.title}</span>
            {media.progressPercentage ? (
              <div
                className={styles.progressTrack}
                role="progressbar"
                aria-valuenow={media.progressPercentage}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className={styles.progressFill}
                  style={{ width: `${media.progressPercentage}%` }}
                />
              </div>
            ) : (
              media.runtimeMinutes && <span className={styles.meta}>{media.runtimeMinutes}m</span>
            )}
          </div>
          <button
            type="button"
            className={styles.playNextButton}
            onClick={() => onPlay()}
            disabled={isResolving}
            aria-busy={isResolving}
          >
            <Icon name="play" size={14} />
            {isResolving ? resolveLabel : media.progressPercentage ? 'Resume' : 'Play'}
          </button>
        </div>
      </section>
    )
  }

  if (allWatched || !nextEpisode) {
    return (
      <section className={`${styles.panel} glass-panel`} aria-label="Next to play">
        <span className={styles.heading}>
          <Icon name="check" size={14} />
          Next to Play
        </span>
        <p className={styles.caughtUp}>
          You&apos;re all caught up — every known episode is watched.
        </p>
      </section>
    )
  }

  return (
    <section className={`${styles.panel} glass-panel`} aria-label="Next to play">
      <span className={styles.heading}>
        <Icon name="play" size={14} />
        Next to Play · S{nextEpisode.season} E{nextEpisode.episode}
      </span>
      <div className={styles.episodeRow}>
        <ArtworkImage
          src={nextEpisode.thumbnail || artwork.thumbnailUrl}
          alt=""
          fallbackTitle={media.title}
          artTint={media.artTint}
          className={styles.thumb}
        />
        <div className={styles.movieInfo}>
          <span className={styles.title}>
            {nextEpisode.title || `Episode ${nextEpisode.episode}`}
          </span>
          {nextEpisode.description && (
            <p className={styles.description}>{nextEpisode.description}</p>
          )}
        </div>
        <button
          type="button"
          className={styles.playNextButton}
          onClick={() => onPlay(nextEpisode)}
          disabled={isResolving}
          aria-busy={isResolving}
        >
          <Icon name="play" size={14} />
          {isResolving ? resolveLabel : 'Play Next'}
        </button>
      </div>
    </section>
  )
}
