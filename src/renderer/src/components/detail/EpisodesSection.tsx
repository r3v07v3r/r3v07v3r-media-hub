'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Episode } from '@shared/media-hub/types'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import { ArtworkImage } from '@renderer/components/media/ArtworkImage'
import styles from './EpisodesSection.module.css'

export interface EpisodesSectionProps {
  /** The show's own id — startPlayback's resolvingMedia is keyed on this,
   *  not a per-episode id (only one resolve is ever in flight at a time),
   *  so a locally-tracked pendingKey (see below) narrows that down to
   *  which specific row's Play button was actually clicked. */
  mediaId: string
  episodes: Episode[]
  seasons: number[]
  selectedSeason: number | null
  onSelectSeason: (season: number) => void
  watchedKeys: Set<string>
  nextEpisode: Episode | null
  onPlay: (episode: Episode) => void
  onMarkWatched: (episode: Episode, watched: boolean) => void
  /** Batch-marks every episode in a season watched/unwatched in one go —
   *  see MediaDetailPage's handleMarkSeasonWatched for how "watched" maps
   *  to the real tracking:mark-season-watched batch IPC, while "unwatched"
   *  (no equivalent batch endpoint exists) falls back to one
   *  tracking:unmark-watched call per episode. */
  onMarkSeason: (season: number, watched: boolean) => void
  status: 'loading' | 'ready' | 'error'
}

function key(season: number, episode: number): string {
  return `${season}:${episode}`
}

// TMDB's own convention for a show's specials/OVAs is a season numbered 0
// (see animeSeasons.ts's buildGroupedAnimeVideos) — labeled distinctly here
// rather than as a literal "Season 0", which would read as a bug.
function seasonLabel(season: number): string {
  return season === 0 ? 'Specials' : `Season ${season}`
}

export function EpisodesSection({
  mediaId,
  episodes,
  seasons,
  selectedSeason,
  onSelectSeason,
  watchedKeys,
  nextEpisode,
  onPlay,
  onMarkWatched,
  onMarkSeason,
  status
}: EpisodesSectionProps) {
  const { resolvingMedia } = useAppState()
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const isShowResolving = resolvingMedia?.id === mediaId
  // Cleared as soon as this show is no longer the one resolving —
  // whether that's because it just succeeded (playbackMedia opens) or
  // failed (a notification fired instead) — so a stale spinner never
  // lingers on the row that was clicked. Adjusted during render (the same
  // "reset state when a prop/value changes" pattern MediaGrid.tsx's own
  // items-reset uses) rather than in an effect, which would cost an extra
  // render pass for what's otherwise a synchronous derivation.
  const [wasShowResolving, setWasShowResolving] = useState(isShowResolving)
  if (wasShowResolving !== isShowResolving) {
    setWasShowResolving(isShowResolving)
    if (!isShowResolving) setPendingKey(null)
  }

  const [seasonMenuOpen, setSeasonMenuOpen] = useState<number | null>(null)
  // Two separate escapes needed here, verified live (the menu existed in
  // the DOM at the right z-index and STILL never appeared):
  // 1) `.seasonRow` needs its own horizontal scroll (many seasons), which
  //    — per the CSS overflow spec — silently forces its vertical
  //    overflow to `auto` too as soon as overflow-x isn't `visible`; a
  //    menu positioned relative to a pill inside that row gets clipped
  //    the instant it extends past the row's own box.
  // 2) This section is a `.glass-panel` (backdrop-filter: blur(...)) —
  //    Chromium gives any backdrop-filter element its own containing
  //    block for fixed/absolute descendants, same as `transform`/`filter`
  //    do. A plain `position: fixed` menu still renders relative to THAT
  //    section, not the viewport, so viewport-measured coordinates land
  //    in the wrong place (confirmed by forcing top:100px/left:100px and
  //    seeing it render ~850px/~310px off from the viewport origin).
  // A React portal into document.body sidesteps both: the menu is no
  // longer a descendant of .seasonRow OR this section at all, so neither
  // one's containing-block/overflow behavior can affect it — plain
  // viewport-relative `position: fixed` coordinates just work.
  const [menuAnchor, setMenuAnchor] = useState<{ top: number; left: number } | null>(null)
  const triggerRefs = useRef(new Map<number, HTMLButtonElement>())
  const menuRef = useRef<HTMLDivElement>(null)

  function toggleSeasonMenu(season: number): void {
    if (seasonMenuOpen === season) {
      setSeasonMenuOpen(null)
      setMenuAnchor(null)
      return
    }
    const trigger = triggerRefs.current.get(season)
    if (trigger) {
      const rect = trigger.getBoundingClientRect()
      setMenuAnchor({ top: rect.bottom + 6, left: rect.left })
    }
    setSeasonMenuOpen(season)
  }

  useEffect(() => {
    if (seasonMenuOpen === null) return
    function onClick(e: MouseEvent) {
      const target = e.target as Node
      const trigger = triggerRefs.current.get(seasonMenuOpen as number)
      if (
        menuRef.current &&
        !menuRef.current.contains(target) &&
        !(trigger && trigger.contains(target))
      ) {
        setSeasonMenuOpen(null)
        setMenuAnchor(null)
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setSeasonMenuOpen(null)
        setMenuAnchor(null)
      }
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [seasonMenuOpen])

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
          {seasons.map((s) => {
            const isActive = s === selectedSeason
            const menuOpen = seasonMenuOpen === s
            return (
              <div key={s} className={styles.seasonItem}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={`${styles.seasonPill} ${isActive ? styles.seasonPillActive : ''}`}
                  onClick={() => onSelectSeason(s)}
                >
                  {seasonLabel(s)}
                </button>
                {isActive && (
                  <button
                    type="button"
                    ref={(el) => {
                      if (el) triggerRefs.current.set(s, el)
                      else triggerRefs.current.delete(s)
                    }}
                    className={styles.seasonMenuTrigger}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    aria-label={`${seasonLabel(s)} actions`}
                    onClick={() => toggleSeasonMenu(s)}
                  >
                    <Icon name="chevron-down" size={12} />
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {seasonMenuOpen !== null &&
        menuAnchor &&
        createPortal(
          <div
            ref={menuRef}
            className={`${styles.seasonMenu} glass-panel`}
            role="menu"
            style={{ top: menuAnchor.top, left: menuAnchor.left }}
          >
            <button
              type="button"
              role="menuitem"
              className={styles.seasonMenuItem}
              onClick={() => {
                onMarkSeason(seasonMenuOpen, true)
                setSeasonMenuOpen(null)
                setMenuAnchor(null)
              }}
            >
              <Icon name="check" size={13} />
              Mark season watched
            </button>
            <button
              type="button"
              role="menuitem"
              className={styles.seasonMenuItem}
              onClick={() => {
                onMarkSeason(seasonMenuOpen, false)
                setSeasonMenuOpen(null)
                setMenuAnchor(null)
              }}
            >
              <Icon name="eye-off" size={13} />
              Mark season unwatched
            </button>
          </div>,
          document.body
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
                onClick={() => {
                  setPendingKey(key(ep.season, ep.episode))
                  onPlay(ep)
                }}
                disabled={isShowResolving && pendingKey === key(ep.season, ep.episode)}
                aria-busy={isShowResolving && pendingKey === key(ep.season, ep.episode)}
                aria-label={`Play ${ep.title || `episode ${ep.episode}`}`}
              >
                {isShowResolving && pendingKey === key(ep.season, ep.episode) ? (
                  <span className={styles.playRowSpinner} aria-hidden="true" />
                ) : (
                  <Icon name="play" size={13} />
                )}
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
