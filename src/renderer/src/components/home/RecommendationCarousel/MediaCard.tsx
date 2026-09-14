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
import type { PlannedServiceId } from '@shared/media-hub/types'
import { kindOf } from '@renderer/components/mystuff/plannedFilterRules'

const MATCH_CLASS: Record<string, string> = {
  excellent: styles.matchExcellent,
  good: styles.matchGood,
  fair: styles.matchFair,
  low: styles.matchLow
}

/** Films, series and anime as somebody would say them out loud. */
const KIND_LABELS: Record<'movie' | 'series' | 'anime', string> = {
  movie: 'Film',
  series: 'Series',
  anime: 'Anime'
}

/** Their own names, as those services write them. */
const SOURCE_LABELS: Record<PlannedServiceId, string> = {
  simkl: 'Simkl',
  trakt: 'Trakt',
  mal: 'MyAnimeList'
}

export function MediaCard({
  media,
  reason,
  showKind = false,
  showProvenance = false
}: {
  media: MediaItem
  reason?: string
  /** See MediaGrid's own prop — on for mixed lists, off everywhere else. */
  showKind?: boolean
  /** Name the service a planned title came from, in place of the planned
   *  badge — the Planned tab and the lists, where every card is planned
   *  and "which service" is the fact worth reading. */
  showProvenance?: boolean
}) {
  const { plannedSources, myList } = useAppState()
  const { openDetail, startPartyPlayback, openContextMenu, continueWatching, resolvingMedia } =
    useAppState()
  const artwork = resolveArtwork(media)
  const isResolving = resolvingMedia?.id === media.id

  // One label for however many services agree, because three chips in a
  // row on a poster is noise and the useful fact is that it is on a list
  // somewhere else at all. The tooltip carries the detail.
  // A PLANNED TITLE ALWAYS SAYS WHERE IT CAME FROM, including "here".
  //
  // Tagging only the ones pulled from a service left every other row
  // unexplained: a list holding some Simkl chips and some bare cards
  // reads as though the bare ones came from somewhere unnamed. They came
  // from this app, which is worth one word.
  //
  // Only on the mixed lists (showKind — the Planned tab and the lists),
  // where "which service" is a filter: everywhere else the corner badge
  // already says planned, and a second pill saying "Added here" under
  // every title was the noisiest thing on the card.
  const sources = plannedSources[String(media.id)] ?? []
  const plannedTag =
    !showProvenance || !myList.has(media.id)
      ? ''
      : sources.length === 0
        ? 'Added here'
        : sources.length === 1
          ? SOURCE_LABELS[sources[0]]
          : `${sources.length} lists`

  // On the Planned tab every card is planned, so the corner badge would
  // say the same thing forty times; the provenance chip is the fact worth
  // reading there. Everywhere else the badge is how a planned title shows.
  const status = getWatchStatus(media, continueWatching)
  const watchStatus =
    status.state === 'planned' && plannedTag ? { state: 'unwatched' as const } : status

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
          {/* What it is, and where it came from, on one row: the kind for a
              list that holds all three, and — on the Planned tab only — the
              service whose watchlist it arrived from, since a list pulled in
              from three services otherwise looks like one this app invented. */}
          {(showKind || plannedTag) && (
            <span className={styles.chipRow}>
              {showKind && <span className={styles.kindChip}>{KIND_LABELS[kindOf(media)]}</span>}
              {plannedTag && (
                <span className={styles.plannedChip} title={`On your ${plannedTag} watchlist`}>
                  {plannedTag}
                </span>
              )}
            </span>
          )}
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
