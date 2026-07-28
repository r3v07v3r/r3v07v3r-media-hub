'use client'

import { useMemo } from 'react'
import type { MediaItem } from '@renderer/types'
import type { ContinueWatchingItem } from '@renderer/types'
import type { Episode, Trailer } from '@shared/media-hub/types'
import type { DetailAdapterConfig } from '@renderer/lib/mediaHub/detailAdapters'
import { Icon } from '@renderer/components/icons/Icon'
import { resolveArtwork } from '@renderer/lib/artwork'
import { ArtworkImage } from '@renderer/components/media/ArtworkImage'
import styles from './DetailHero.module.css'

export interface DetailHeroProps {
  media: MediaItem
  config: DetailAdapterConfig
  continueEntry: ContinueWatchingItem | undefined
  nextEpisode: Episode | null
  trailer: Trailer | undefined
  showTrailer: boolean
  onToggleTrailer: () => void
  inMyList: boolean
  onToggleMyList: () => void
  onPlay: () => void
}

export function DetailHero({
  media,
  config,
  continueEntry,
  nextEpisode,
  trailer,
  showTrailer,
  onToggleTrailer,
  inMyList,
  onToggleMyList,
  onPlay
}: DetailHeroProps) {
  const artwork = resolveArtwork(media)
  const hasProgress = !!continueEntry && !continueEntry.media.completed

  const playLabel = useMemo(() => {
    if (hasProgress) {
      return config.isEpisodic
        ? `Resume S${continueEntry?.media.seasonNumber} E${continueEntry?.media.episodeNumber}`
        : 'Resume'
    }
    if (config.isEpisodic && nextEpisode) {
      return `Play S${nextEpisode.season} E${nextEpisode.episode}`
    }
    return 'Play'
  }, [hasProgress, config.isEpisodic, continueEntry, nextEpisode])

  return (
    <section className={styles.hero} aria-label={`${media.title} details`}>
      <div className={styles.artLayer} aria-hidden="true">
        {showTrailer && trailer ? (
          <iframe
            className={styles.trailerFrame}
            src={`https://www.youtube-nocookie.com/embed/${trailer.source}?autoplay=1`}
            title={`${media.title} trailer`}
            allow="autoplay; encrypted-media"
            allowFullScreen
          />
        ) : (
          <ArtworkImage
            src={artwork.backdropUrl ?? artwork.posterUrl}
            alt=""
            fallbackTitle={media.title}
            artTint={media.artTint}
            priority
            className={styles.artImageWrap}
            imageClassName={styles.artImage}
          />
        )}
        <div className={styles.artScrimLeft} />
        <div className={styles.artScrimBottom} />
      </div>

      <div className={styles.content}>
        <span className={styles.label}>Featured {config.label}</span>
        <h1 className={styles.title}>
          {media.title}
          {media.subtitle && <span className={styles.subtitle}>{media.subtitle}</span>}
        </h1>
        {media.episodeTitle && (
          <p className={styles.tagline}>
            S{media.seasonNumber} · E{media.episodeNumber} — {media.episodeTitle}
          </p>
        )}
        {media.description && <p className={styles.description}>{media.description}</p>}

        <div className={styles.metaRow}>
          {media.releaseYear && <span>{media.releaseYear}</span>}
          {media.status && <span className={styles.statusChip}>{media.status}</span>}
          {config.isEpisodic && media.totalSeasons && (
            <span>
              {media.totalSeasons} Season{media.totalSeasons === 1 ? '' : 's'}
            </span>
          )}
          {config.isEpisodic && media.totalEpisodes && <span>{media.totalEpisodes} Episodes</span>}
          {!config.isEpisodic && media.runtimeMinutes && <span>{media.runtimeMinutes}m</span>}
          {media.genres.slice(0, 3).map((g) => (
            <span key={g}>{g}</span>
          ))}
        </div>

        <div className={styles.actions}>
          <button type="button" className={styles.playButton} onClick={onPlay}>
            <Icon name="play" size={16} />
            {playLabel}
          </button>
          {trailer && (
            <button type="button" className={styles.secondaryButton} onClick={onToggleTrailer}>
              <Icon name={showTrailer ? 'x' : 'play-outline'} size={15} />
              {showTrailer ? 'Close Trailer' : 'Trailer'}
            </button>
          )}
          <button
            type="button"
            className={styles.secondaryButton}
            aria-pressed={inMyList}
            onClick={onToggleMyList}
          >
            <Icon name={inMyList ? 'check' : 'plus'} size={15} />
            {inMyList ? config.trackedLabel : config.trackLabel}
          </button>
        </div>
      </div>
    </section>
  )
}
