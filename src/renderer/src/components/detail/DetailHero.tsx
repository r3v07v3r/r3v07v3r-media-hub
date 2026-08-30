'use client'

import { useMemo, useRef } from 'react'
import type { MediaItem } from '@renderer/types'
import type { ContinueWatchingItem } from '@renderer/types'
import type { Episode, Trailer } from '@shared/media-hub/types'
import type { DetailAdapterConfig } from '@renderer/lib/mediaHub/detailAdapters'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import { resolveArtwork } from '@renderer/lib/artwork'
import { ArtworkImage } from '@renderer/components/media/ArtworkImage'
import { useYoutubeEmbedControls } from '@renderer/hooks/useYoutubeEmbedControls'
import styles from './DetailHero.module.css'

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export interface DetailHeroProps {
  media: MediaItem
  config: DetailAdapterConfig
  continueEntry: ContinueWatchingItem | undefined
  nextEpisode: Episode | null
  trailer: Trailer | undefined
  showTrailer: boolean
  onToggleTrailer: () => void
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
  onPlay
}: DetailHeroProps) {
  const { resolvingMedia } = useAppState()
  const artwork = resolveArtwork(media)
  const hasProgress = !!continueEntry && !continueEntry.media.completed
  const isResolving = resolvingMedia?.id === media.id

  const trailerFrameRef = useRef<HTMLIFrameElement>(null)
  const trailerActive = showTrailer && !!trailer
  const trailerControls = useYoutubeEmbedControls(trailerFrameRef, trailerActive)
  // Fades the title/description/actions out once the trailer is actually
  // playing (not just open — autoplay takes a beat to actually start) and
  // brings them back on pause, not only on close, since a person pausing
  // to read something is exactly the moment they want this text back too.
  // Closing the trailer (trailerActive turning false) always restores it,
  // both directly here and via the hook resetting `playing` to false.
  const contentFaded = trailerActive && trailerControls.playing

  const playLabel = useMemo(() => {
    if (isResolving) {
      return resolvingMedia?.stage === 'resolving' ? 'Searching…' : 'Preparing…'
    }
    if (hasProgress) {
      return config.isEpisodic
        ? `Resume S${continueEntry?.media.seasonNumber} E${continueEntry?.media.episodeNumber}`
        : 'Resume'
    }
    if (config.isEpisodic && nextEpisode) {
      return `Play S${nextEpisode.season} E${nextEpisode.episode}`
    }
    return 'Play'
  }, [
    isResolving,
    resolvingMedia?.stage,
    hasProgress,
    config.isEpisodic,
    continueEntry,
    nextEpisode
  ])

  return (
    <section
      className={`${styles.hero} ${!config.isEpisodic ? styles.heroMovie : ''} ${
        trailerActive ? styles.heroTrailerOpen : ''
      }`}
      aria-label={`${media.title} details`}
    >
      <div
        className={`${styles.artLayer} ${contentFaded ? styles.artLayerUnmasked : ''}`}
        aria-hidden="true"
      >
        {/* controls=0 + our own control bar below (rendered outside this
            aria-hidden layer, since — unlike the backdrop image/raw video
            — those controls are real interactive UI a screen reader needs
            to see). enablejsapi=1 is what makes the embed accept the
            postMessage commands useYoutubeEmbedControls sends; verified
            live against a real embed before wiring this up (see that
            hook's own doc comment). */}
        {showTrailer && trailer ? (
          <iframe
            ref={trailerFrameRef}
            className={styles.trailerFrame}
            src={`https://www.youtube-nocookie.com/embed/${trailer.source}?autoplay=1&enablejsapi=1&controls=0&modestbranding=1&rel=0`}
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

      {trailerActive && (
        <div className={styles.trailerControls}>
          <button
            type="button"
            className={styles.trailerPlayPause}
            onClick={trailerControls.togglePlay}
            disabled={!trailerControls.ready}
            aria-label={trailerControls.playing ? 'Pause trailer' : 'Play trailer'}
          >
            <Icon name={trailerControls.playing ? 'pause' : 'play'} size={15} />
          </button>
          <span className={styles.trailerTime}>{formatTime(trailerControls.currentTime)}</span>
          <input
            type="range"
            className={styles.trailerScrub}
            min={0}
            max={trailerControls.duration || 0}
            step={0.1}
            value={Math.min(trailerControls.currentTime, trailerControls.duration || 0)}
            onChange={(e) => trailerControls.seek(Number(e.target.value))}
            disabled={!trailerControls.ready || !trailerControls.duration}
            aria-label="Seek trailer"
          />
          <span className={`${styles.trailerTime} ${styles.trailerDuration}`}>
            {formatTime(trailerControls.duration)}
          </span>
          {/* .content's own "Close Trailer" button is the only other way
              to exit — but .content gets pointer-events:none while
              contentFaded, so during actual playback that button was
              completely unreachable without first pausing. This control
              bar is never faded (only .content is), so it's the one place
              a close action is guaranteed reachable regardless of
              play/pause state. */}
          <button
            type="button"
            className={styles.trailerClose}
            onClick={onToggleTrailer}
            aria-label="Close trailer"
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      )}

      <div className={`${styles.content} ${contentFaded ? styles.contentFaded : ''}`}>
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
          <button
            type="button"
            className={styles.playButton}
            onClick={onPlay}
            disabled={isResolving}
            aria-busy={isResolving}
          >
            {isResolving ? (
              <span className={styles.playSpinner} aria-hidden="true" />
            ) : (
              <Icon name="play" size={16} />
            )}
            {playLabel}
          </button>
          {trailer && (
            <button type="button" className={styles.secondaryButton} onClick={onToggleTrailer}>
              <Icon name={showTrailer ? 'x' : 'play-outline'} size={15} />
              {showTrailer ? 'Close Trailer' : 'Trailer'}
            </button>
          )}
          {/* The list toggle and Watch together used to sit here.
              The first is the same control the right-hand rail already
              carries, and two buttons doing one thing on one screen is a
              question about which is which rather than a convenience.
              The second goes because rooms are being reworked, and an
              entry point into a thing that is changing shape is worse
              than no entry point. Play and Trailer are what this row is
              for. */}
        </div>
      </div>
    </section>
  )
}
