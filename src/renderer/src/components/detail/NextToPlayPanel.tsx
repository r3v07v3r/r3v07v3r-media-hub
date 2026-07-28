'use client'

import type { MediaItem } from '@renderer/types'
import type { Episode } from '@shared/media-hub/types'
import { Icon } from '@renderer/components/icons/Icon'
import { resolveArtwork } from '@renderer/lib/artwork'
import { ArtworkImage } from '@renderer/components/media/ArtworkImage'
import styles from './NextToPlayPanel.module.css'

export interface NextToPlayPanelProps {
  media: MediaItem
  /** Series/anime only — null for movies (see the movie-specific resume
   *  variant below) and null when every known episode is already
   *  watched. */
  nextEpisode: Episode | null
  allWatched: boolean
  onPlay: (episode?: Episode) => void
}

/**
 * Series/anime: the next unwatched episode (or "you're all caught up").
 * Movies get a resume-focused variant instead of an empty episode card —
 * per spec, never show a fake/empty episode panel for a movie.
 */
export function NextToPlayPanel({ media, nextEpisode, allWatched, onPlay }: NextToPlayPanelProps) {
  const artwork = resolveArtwork(media)

  if (!nextEpisode && !allWatched) {
    // Movie path, or a series/anime this app has no episode data for yet.
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
              <div className={styles.progressTrack} role="progressbar" aria-valuenow={media.progressPercentage} aria-valuemin={0} aria-valuemax={100}>
                <div className={styles.progressFill} style={{ width: `${media.progressPercentage}%` }} />
              </div>
            ) : (
              media.runtimeMinutes && <span className={styles.meta}>{media.runtimeMinutes}m</span>
            )}
          </div>
          <button type="button" className={styles.playNextButton} onClick={() => onPlay()}>
            <Icon name="play" size={14} />
            {media.progressPercentage ? 'Resume' : 'Play'}
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
        <p className={styles.caughtUp}>You&apos;re all caught up — every known episode is watched.</p>
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
          <span className={styles.title}>{nextEpisode.title || `Episode ${nextEpisode.episode}`}</span>
          {nextEpisode.description && <p className={styles.description}>{nextEpisode.description}</p>}
        </div>
        <button type="button" className={styles.playNextButton} onClick={() => onPlay(nextEpisode)}>
          <Icon name="play" size={14} />
          Play Next
        </button>
      </div>
    </section>
  )
}
