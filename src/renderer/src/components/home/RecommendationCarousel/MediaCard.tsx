'use client'

import { useAppState } from '@renderer/context/AppStateContext'
import { MediaItem, matchTier } from '@renderer/types'
import { Icon } from '@renderer/components/icons/Icon'
import { resolveArtwork } from '@renderer/lib/artwork'
import { ArtworkImage } from '@renderer/components/media/ArtworkImage'
import { WatchStatusBadge } from '@renderer/components/media/WatchStatusBadge'
import { getWatchStatus } from '@renderer/lib/mediaHub/watchStatus'
import styles from './RecommendationCarousel.module.css'
import { RatingBadge } from '@renderer/components/detail/RatingBadge'
import { ratingSourceFor } from '@renderer/components/detail/ratingSource'

const MATCH_CLASS: Record<string, string> = {
  excellent: styles.matchExcellent,
  good: styles.matchGood,
  fair: styles.matchFair,
  low: styles.matchLow
}

export function MediaCard({ media, reason }: { media: MediaItem; reason?: string }) {
  const { openDetail, startPartyPlayback, openContextMenu, continueWatching, resolvingMedia } =
    useAppState()
  const artwork = resolveArtwork(media)
  const watchStatus = getWatchStatus(media, continueWatching)
  const isResolving = resolvingMedia?.id === media.id

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault()
    openContextMenu(e.clientX, e.clientY, media)
  }

  return (
    <li>
      {/* Reference target: one wide cinematic tile — backdrop-style key
          art with title/ratings/match% overlaid directly on the image
          via a bottom scrim, not a separate poster + text-block-below
          "data card." Everything lives inside .card now; there's no
          .cardBody. */}
      <div
        className={`${styles.card} animated-edge light-sweep`}
        role="button"
        tabIndex={0}
        data-media-id={media.id}
        onClick={() => openDetail(media)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') openDetail(media)
        }}
        onContextMenu={handleContextMenu}
        aria-label={`${media.title}, ${media.matchPercentage ?? 0} percent match`}
      >
        <ArtworkImage
          src={artwork.backdropUrl ?? artwork.posterUrl}
          alt=""
          fallbackTitle={media.title}
          artTint={media.artTint}
          sizes="240px"
          className={styles.cardArtImage}
        />
        <div className={styles.cardScrim} aria-hidden="true" />
        <WatchStatusBadge status={watchStatus} />
        <button
          type="button"
          className={styles.playButton}
          onClick={(e) => {
            e.stopPropagation()
            startPartyPlayback(media)
          }}
          disabled={isResolving}
          aria-busy={isResolving}
          aria-label={
            isResolving
              ? `${resolvingMedia?.stage === 'resolving' ? 'Searching' : 'Preparing'} ${media.title}`
              : `Play ${media.title}`
          }
        >
          {isResolving ? (
            <span className={styles.playButtonSpinner} aria-hidden="true" />
          ) : (
            <Icon name="play" />
          )}
        </button>
        <button
          type="button"
          className={styles.moreButton}
          onClick={(e) => {
            e.stopPropagation()
            const rect = (e.target as HTMLElement).getBoundingClientRect()
            openContextMenu(rect.left, rect.bottom, media)
          }}
          aria-label={`More actions for ${media.title}`}
        >
          <Icon name="more-horizontal" />
        </button>
        <div className={styles.cardOverlay}>
          {/* Why this title is in the row at all — the signal the ranker
              actually scored it on, not a caption over the result (see
              shared/media-hub/recommendationReason.ts). Above the title
              rather than below the match%, because it is the thing that
              answers "why am I being shown this", and it should be read
              before the title rather than after the numbers.

              Absent whenever the ranker had nothing to point at, which is
              ordinary: a title carried by its own rating alone gets no
              chip rather than a chip that says nothing. */}
          {reason && (
            <span className={styles.reasonChip} title={reason}>
              {reason}
            </span>
          )}
          <span className={styles.cardTitle}>{media.title}</span>
          {/* This used to read "★ 8.6 | IMDb 8.6" and was described as a
              hierarchy of two figures. It was one figure: communityRating
              and imdbRating come from the same field. Now it is shown once,
              with the source that actually produced it. */}
          <div className={styles.cardRatings}>
            {(media.imdbRating ?? media.communityRating) && (
              <RatingBadge
                compact
                source={ratingSourceFor(media.mediaKind)}
                value={(media.imdbRating ?? media.communityRating ?? 0).toFixed(1)}
              />
            )}
          </div>
          {media.matchPercentage !== undefined && (
            <span
              className={`${styles.matchText} ${MATCH_CLASS[matchTier(media.matchPercentage)]}`}
            >
              {media.matchPercentage}% Match
            </span>
          )}
        </div>
      </div>
    </li>
  )
}
