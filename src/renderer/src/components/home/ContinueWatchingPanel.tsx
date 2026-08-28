'use client'

import { useMemo } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { matchesCategoryKind, CategoryKind } from '@renderer/lib/mediaHub/categoryFilters'
import { Icon } from '@renderer/components/icons/Icon'
import { resolveArtwork } from '@renderer/lib/artwork'
import { ArtworkImage } from '@renderer/components/media/ArtworkImage'
import styles from './ContinueWatchingPanel.module.css'

export interface ContinueWatchingPanelProps {
  /** Restricts the row to one kind — used by the Movies/Series/Anime
   *  category pages so "Continue Watching" on the Movies page doesn't show
   *  an in-progress series. Home omits this (unchanged: every kind mixed
   *  together, matching the reference composition). */
  kindFilter?: CategoryKind
  /** Appended after styles.panel, so callers can override max-height (or
   *  anything else) without this component needing to know why. Added for
   *  CategoryPage.module.css's .continuePanel — see its own comment for
   *  the real bug (unbounded panel height) this exists to fix. */
  className?: string
}

export function ContinueWatchingPanel({ kindFilter, className }: ContinueWatchingPanelProps = {}) {
  const {
    continueWatching: allContinueWatching,
    startPartyPlayback,
    markContinueWatching,
    removeContinueWatching,
    openDetail
  } = useAppState()

  const continueWatching = useMemo(
    () =>
      kindFilter
        ? allContinueWatching.filter((c) => matchesCategoryKind(c.media, kindFilter))
        : allContinueWatching,
    [allContinueWatching, kindFilter]
  )
  const isEmpty = continueWatching.length === 0

  return (
    <aside
      className={`${styles.panel} ${isEmpty ? styles.panelEmpty : ''}${className ? ` ${className}` : ''}`}
      aria-label="Continue watching"
    >
      <div className={styles.panelGlow} aria-hidden="true" />

      {isEmpty ? (
        <div className={styles.empty}>
          <Icon name="tracked" size={18} />
          Finished Everything? <span aria-hidden="true">😱</span>
        </div>
      ) : (
        <>
          <h2 className={styles.heading}>
            <Icon name="clock" />
            Continue Watching
          </h2>
          <ul className={styles.list}>
            {continueWatching.map((c) => {
              const m = c.media
              const isDone = m.completed
              const artwork = resolveArtwork(m)
              return (
                <li key={m.id} className={styles.item}>
                  <button
                    type="button"
                    className={`${styles.thumbButton} animated-edge`}
                    data-media-id={m.id}
                    onClick={() => (isDone ? openDetail(m) : startPartyPlayback(m))}
                    aria-label={isDone ? `Open details for ${m.title}` : `Resume ${m.title}`}
                  >
                    <ArtworkImage
                      src={artwork.thumbnailUrl ?? artwork.posterUrl ?? artwork.backdropUrl}
                      alt=""
                      fallbackTitle={m.title}
                      artTint={m.artTint}
                      sizes="88px"
                      className={styles.thumbImage}
                    />
                    {isDone && (
                      <span className={styles.thumbCheck} aria-hidden="true">
                        <Icon name="check" strokeWidth={2.4} />
                      </span>
                    )}
                  </button>
                  <div className={styles.info}>
                    <span className={styles.title}>{m.title}</span>
                    {isDone ? (
                      <span className={styles.meta}>Completed</span>
                    ) : (
                      <>
                        <span className={styles.meta}>
                          {m.seasonNumber && `S${m.seasonNumber} · Ep ${m.episodeNumber}`}
                        </span>
                        <div className={styles.progressRow}>
                          <div
                            className={styles.progressTrack}
                            role="progressbar"
                            aria-label={`${m.title} watch progress`}
                            aria-valuenow={m.progressPercentage ?? 0}
                            aria-valuemin={0}
                            aria-valuemax={100}
                          >
                            <div
                              className={styles.progressFill}
                              style={{ width: `${m.progressPercentage ?? 0}%` }}
                            />
                          </div>
                          <span className={styles.progressPct}>
                            {m.remainingMinutes
                              ? `${m.remainingMinutes}m left`
                              : `${m.progressPercentage}%`}
                          </span>
                        </div>
                      </>
                    )}
                    <div className={styles.ratings}>
                      {m.communityRating && (
                        <span className={styles.ratingStar}>
                          <Icon name="star" />
                          {m.communityRating.toFixed(1)}
                        </span>
                      )}
                      {m.imdbRating && (
                        <>
                          {m.communityRating && (
                            <span className={styles.ratingDivider} aria-hidden="true" />
                          )}
                          <span className={styles.ratingImdb}>IMDb {m.imdbRating.toFixed(1)}</span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className={styles.hoverActions}>
                    {!isDone && (
                      <button
                        type="button"
                        className={styles.hoverActionButton}
                        onClick={() => startPartyPlayback(m)}
                        aria-label={`Resume ${m.title}`}
                      >
                        <Icon name="play" />
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.hoverActionButton}
                      onClick={() => startPartyPlayback({ ...m, progressPercentage: 0 })}
                      aria-label={`Restart ${m.title}`}
                    >
                      <Icon name="refresh" />
                    </button>
                    <button
                      type="button"
                      className={styles.hoverActionButton}
                      onClick={() => markContinueWatching(m.id, !m.watched)}
                      aria-label={
                        m.watched ? `Mark ${m.title} unwatched` : `Mark ${m.title} watched`
                      }
                    >
                      <Icon name={m.watched ? 'eye-off' : 'eye'} />
                    </button>
                    <button
                      type="button"
                      className={styles.hoverActionButton}
                      onClick={() => removeContinueWatching(m.id)}
                      aria-label={`Remove ${m.title} from Continue Watching`}
                    >
                      <Icon name="trash" />
                    </button>
                    <button
                      type="button"
                      className={styles.hoverActionButton}
                      onClick={() => openDetail(m)}
                      aria-label={`More information about ${m.title}`}
                    >
                      <Icon name="info" />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </aside>
  )
}
