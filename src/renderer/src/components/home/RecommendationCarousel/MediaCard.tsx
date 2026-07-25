'use client'

import { useAppState } from '@renderer/context/AppStateContext'
import { MediaItem, matchTier } from '@renderer/types'
import { Icon } from '@renderer/components/icons/Icon'
import { resolveArtwork } from '@renderer/lib/artwork'
import { ArtworkImage } from '@renderer/components/media/ArtworkImage'
import styles from './RecommendationCarousel.module.css'

const MATCH_CLASS: Record<string, string> = {
  excellent: styles.matchExcellent,
  good: styles.matchGood,
  fair: styles.matchFair,
  low: styles.matchLow
}

export function MediaCard({ media }: { media: MediaItem }) {
  const { openDetail, startPlayback, openContextMenu } = useAppState()
  const artwork = resolveArtwork(media)

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
        <button
          type="button"
          className={styles.playButton}
          onClick={(e) => {
            e.stopPropagation()
            startPlayback(media)
          }}
          aria-label={`Play ${media.title}`}
        >
          <Icon name="play" />
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
          <span className={styles.cardTitle}>{media.title}</span>
          {/* 10-foot-interface pass: "★ 8.6   IMDb 8.6 / 93% Match" hierarchy
              — star+rating is now the bright primary group, a vertical
              divider visually separates it from the dimmer secondary IMDb
              figure, rather than both reading as one flat, equal-weight
              string. */}
          <div className={styles.cardRatings}>
            {media.communityRating && (
              <span className={styles.ratingStar}>
                <Icon name="star" />
                {media.communityRating.toFixed(1)}
              </span>
            )}
            {media.imdbRating && (
              <>
                {media.communityRating && (
                  <span className={styles.ratingDivider} aria-hidden="true" />
                )}
                <span className={styles.ratingImdb}>IMDb {media.imdbRating.toFixed(1)}</span>
              </>
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
