'use client'

import type { Episode } from '@shared/media-hub/types'
import { Icon } from '@renderer/components/icons/Icon'
import { ArtworkImage } from '@renderer/components/media/ArtworkImage'
import styles from './EpisodesSection.module.css'

export interface EpisodesSectionProps {
  episodes: Episode[]
  seasons: number[]
  selectedSeason: number | null
  onSelectSeason: (season: number) => void
  watchedKeys: Set<string>
  nextEpisode: Episode | null
  onPlay: (episode: Episode) => void
  onMarkWatched: (episode: Episode, watched: boolean) => void
  status: 'loading' | 'ready' | 'error'
}

function key(season: number, episode: number): string {
  return `${season}:${episode}`
}

export function EpisodesSection({
  episodes,
  seasons,
  selectedSeason,
  onSelectSeason,
  watchedKeys,
  nextEpisode,
  onPlay,
  onMarkWatched,
  status
}: EpisodesSectionProps) {
  if (status === 'loading') {
    return (
      <section className={`${styles.section} glass-panel`} aria-busy="true" aria-label="Loading episodes">
        <div className={styles.skeletonSeasonRow}>
          {[0, 1, 2].map((i) => (
            <span key={i} className={styles.skeletonPill} />
          ))}
        </div>
        <ul className={styles.list}>
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className={styles.skeletonRow} />
          ))}
        </ul>
      </section>
    )
  }

  if (episodes.length === 0) {
    return (
      <section className={`${styles.section} glass-panel`} aria-label="Episodes">
        <p className={styles.empty}>
          {status === 'error'
            ? 'Episode list couldn’t be loaded — check your connection and try again.'
            : 'No episode data is available for this title yet.'}
        </p>
      </section>
    )
  }

  const visible = episodes.filter((e) => e.season === selectedSeason)

  return (
    <section className={`${styles.section} glass-panel`} aria-label="Episodes">
      {seasons.length > 1 && (
        <div className={`${styles.seasonRow} thin-scroll`} role="tablist" aria-label="Season">
          {seasons.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={s === selectedSeason}
              className={`${styles.seasonPill} ${s === selectedSeason ? styles.seasonPillActive : ''}`}
              onClick={() => onSelectSeason(s)}
            >
              Season {s}
            </button>
          ))}
        </div>
      )}

      <ul className={styles.list}>
        {visible.map((ep) => {
          const watched = watchedKeys.has(key(ep.season, ep.episode))
          const isNext = nextEpisode?.season === ep.season && nextEpisode?.episode === ep.episode
          return (
            <li
              key={ep.id}
              className={`${styles.row} ${isNext ? styles.rowNext : ''}`}
            >
              <span className={styles.number}>{ep.episode}</span>
              <ArtworkImage
                src={ep.thumbnail}
                alt=""
                fallbackTitle={ep.title || `Episode ${ep.episode}`}
                artTint={['#1c2a45', '#0a1220']}
                className={styles.thumb}
              />
              <div className={styles.info}>
                <span className={styles.title}>{ep.title || `Episode ${ep.episode}`}</span>
                {ep.description && <p className={styles.description}>{ep.description}</p>}
              </div>
              <div className={styles.status}>
                {watched ? (
                  <span className={styles.watchedBadge}>
                    <Icon name="check" size={12} />
                    Watched
                  </span>
                ) : isNext ? (
                  <span className={styles.nextBadge}>Next</span>
                ) : null}
              </div>
              <button
                type="button"
                className={styles.playRowButton}
                onClick={() => onPlay(ep)}
                aria-label={`Play ${ep.title || `episode ${ep.episode}`}`}
              >
                <Icon name="play" size={13} />
              </button>
              <button
                type="button"
                className={styles.watchedToggle}
                onClick={() => onMarkWatched(ep, !watched)}
                aria-label={watched ? `Mark episode ${ep.episode} unwatched` : `Mark episode ${ep.episode} watched`}
              >
                <Icon name={watched ? 'eye-off' : 'eye'} size={13} />
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
