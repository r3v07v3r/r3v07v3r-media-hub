'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Episode } from '@shared/media-hub/types'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import { ArtworkImage } from '@renderer/components/media/ArtworkImage'
import styles from './EpisodesSection.module.css'
import { episodeStillOrShowArt } from '@renderer/components/media/artworkRetry'

/** One episode's resume bookmark, already reduced to what a tile draws:
 *  how far through it is and how much is left. Built by MediaDetailPage
 *  from tracking:list-positions — see EpisodePlaybackPosition's own doc
 *  comment (shared/media-hub/types.ts) for why that's one call for the
 *  whole title rather than one per tile. */
export interface EpisodeResume {
  percent: number
  remainingMinutes: number | null
}

export interface EpisodesSectionProps {
  /** The show's own id — startPlayback's resolvingMedia is keyed on this,
   *  not a per-episode id (only one resolve is ever in flight at a time),
   *  so a locally-tracked pendingKey (see below) narrows that down to
   *  which specific tile's Play button was actually clicked. */
  mediaId: string
  /** Rendered as each tile's eyebrow line, the way the reference design
   *  labels every card with the show it belongs to. */
  showTitle: string
  /** The show's own backdrop (or poster), drawn on any tile whose episode
   *  has no still of its own. Whether a tile had art used to depend on
   *  which metadata path answered — Cinemeta's crawl previews blank the
   *  thumbnail, Kitsu's synthesised episodes never had one — so the same
   *  season could render half-illustrated. See episodeStillOrShowArt. */
  showArtwork?: string
  episodes: Episode[]
  seasons: number[]
  selectedSeason: number | null
  onSelectSeason: (season: number) => void
  watchedKeys: Set<string>
  /** `season:episode` -> resume bookmark, for the episodes that have one.
   *  Absent from the map simply means "never started". */
  resumeByKey: Map<string, EpisodeResume>
  /** The show's own per-episode runtime (MediaItem.runtimeMinutes) —
   *  Episode itself carries no duration from any of the four normalizers,
   *  and for an episodic title this field IS the episode length rather
   *  than a whole-series total, so it's the honest number for a tile's
   *  duration chip. Undefined just omits the chip. */
  runtimeMinutes?: number
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

/** Which menu the single portal below is currently showing. One portal
 *  and one outside-click listener serve both the season pill's menu and
 *  every tile's overflow menu — they can never be open at once, and the
 *  escape hatches the portal exists for (see the comment on `menuAnchor`)
 *  apply identically to both. */
type OpenMenu = { kind: 'season'; season: number } | { kind: 'episode'; episode: Episode }

/** Where the portalled menu goes, plus which of its own edges that point
 *  refers to. A season pill sits at the left of a wide row, so its menu
 *  hangs right from the trigger's left edge; a tile's overflow button is
 *  at the far right of its card — in the rightmost column that's close
 *  enough to the window edge that a left-hung menu would overflow it, so
 *  those hang left from the trigger's right edge instead. */
interface MenuAnchor {
  top: number
  left: number
  align: 'left' | 'right'
  /** Set once the layout effect below has moved the menu above its
   *  trigger because it didn't fit underneath. Also the guard that stops
   *  that effect re-measuring its own result forever. */
  flippedUp?: boolean
}

/** Breathing room kept between a flipped/clamped menu and the window edge. */
const MENU_VIEWPORT_MARGIN = 8

function key(season: number, episode: number): string {
  return `${season}:${episode}`
}

function sameMenu(a: OpenMenu | null, b: OpenMenu): boolean {
  if (!a || a.kind !== b.kind) return false
  if (a.kind === 'season' && b.kind === 'season') return a.season === b.season
  if (a.kind === 'episode' && b.kind === 'episode') return a.episode.id === b.episode.id
  return false
}

// TMDB's own convention for a show's specials/OVAs is a season numbered 0
// (see animeSeasons.ts's buildGroupedAnimeVideos) — labeled distinctly here
// rather than as a literal "Season 0", which would read as a bug.
function seasonLabel(season: number): string {
  return season === 0 ? 'Specials' : `Season ${season}`
}

/** "E97" for a normal episode, "SP4" for a specials-season entry — the
 *  short code the reference design leads every card title with. The season
 *  isn't in it: the grid only ever shows one season at a time, and the
 *  season pills directly above already name which. */
function episodeCode(ep: Episode): string {
  return `${ep.season === 0 ? 'SP' : 'E'}${ep.episode}`
}

/** Air date as a compact "12 Mar 2003". Returns null for the empty or
 *  unparseable `released` values Kitsu's placeholder episodes carry, so
 *  the caller renders nothing rather than "Invalid Date".
 *
 *  A bare YYYY-MM-DD is built from local calendar components rather than
 *  handed to `new Date(string)`, which per spec reads a date-ONLY string
 *  as UTC midnight (a date-TIME string without an offset is read as
 *  local — the inconsistency is the trap). Both real sources for this
 *  field are date-only — Kitsu's `airdate` and TMDB's `air_date`, see
 *  core.ts's normalizeKitsuEpisode and animeSeasons.ts — so west of
 *  Greenwich every tile rendered the day BEFORE the episode aired.
 *  Anything with a time in it still goes through the normal parse. */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

function airDateLabel(released: string | undefined): string | null {
  if (!released) return null
  const parts = DATE_ONLY.exec(released.trim())
  const date = parts
    ? new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
    : new Date(released)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function EpisodesSection({
  mediaId,
  showTitle,
  showArtwork,
  episodes,
  seasons,
  selectedSeason,
  onSelectSeason,
  watchedKeys,
  resumeByKey,
  runtimeMinutes,
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
  // lingers on the tile that was clicked. Adjusted during render (the same
  // "reset state when a prop/value changes" pattern MediaGrid.tsx's own
  // items-reset uses) rather than in an effect, which would cost an extra
  // render pass for what's otherwise a synchronous derivation.
  const [wasShowResolving, setWasShowResolving] = useState(isShowResolving)
  if (wasShowResolving !== isShowResolving) {
    setWasShowResolving(isShowResolving)
    if (!isShowResolving) setPendingKey(null)
  }

  const [openMenu, setOpenMenu] = useState<OpenMenu | null>(null)
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
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null)
  // Whichever button opened the menu that's currently up — only ever one,
  // so a single ref beats the per-season map this used to keep, and it
  // serves a tile's overflow button exactly as well as a season pill's.
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Stable identity so the outside-click/Escape effect below can depend on
  // it without re-binding both document listeners on every render.
  const closeMenu = useCallback(() => {
    setOpenMenu(null)
    setMenuAnchor(null)
    menuTriggerRef.current = null
  }, [])

  function toggleMenu(menu: OpenMenu, trigger: HTMLButtonElement): void {
    if (sameMenu(openMenu, menu)) {
      closeMenu()
      return
    }
    const rect = trigger.getBoundingClientRect()
    const align = menu.kind === 'episode' ? 'right' : 'left'
    setMenuAnchor({
      top: rect.bottom + 6,
      left: align === 'right' ? rect.right : rect.left,
      align
    })
    menuTriggerRef.current = trigger
    setOpenMenu(menu)
  }

  // Flip above the trigger when the menu would run off the bottom of the
  // window. The last grid row is the case that needs it: the page has only
  // 40px of padding under it, so a menu opened from a tile down there
  // extends past the viewport with no further scroll available to reach
  // it. Measured rather than assumed from an item count, so it stays
  // right if either menu ever grows a third item — and done in a layout
  // effect so the correction lands before paint rather than as a visible
  // jump.
  useLayoutEffect(() => {
    const menu = menuRef.current
    const trigger = menuTriggerRef.current
    if (!menu || !trigger || !menuAnchor || menuAnchor.flippedUp) return
    const height = menu.offsetHeight
    if (menuAnchor.top + height <= window.innerHeight - MENU_VIEWPORT_MARGIN) return
    const rect = trigger.getBoundingClientRect()
    setMenuAnchor({
      ...menuAnchor,
      top: Math.max(MENU_VIEWPORT_MARGIN, rect.top - 6 - height),
      flippedUp: true
    })
  }, [menuAnchor])

  useEffect(() => {
    if (!openMenu) return
    function onClick(e: MouseEvent) {
      const target = e.target as Node
      const trigger = menuTriggerRef.current
      if (
        menuRef.current &&
        !menuRef.current.contains(target) &&
        !(trigger && trigger.contains(target))
      ) {
        closeMenu()
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closeMenu()
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [openMenu, closeMenu])

  if (status === 'loading') {
    return (
      <section
        className={`${styles.section} glass-panel`}
        aria-busy="true"
        aria-label="Loading episodes"
      >
        <div className={styles.skeletonSeasonRow}>
          {[0, 1, 2].map((i) => (
            <span key={i} className={styles.skeletonPill} />
          ))}
        </div>
        <ul className={styles.grid}>
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <li key={i} className={styles.skeletonTile} />
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
  const menuEpisode = openMenu?.kind === 'episode' ? openMenu.episode : null
  const menuEpisodeWatched = menuEpisode
    ? watchedKeys.has(key(menuEpisode.season, menuEpisode.episode))
    : false

  return (
    <section className={`${styles.section} glass-panel`} aria-label="Episodes">
      {/* Keep the season actions available for one-season shows too. The
          selected pill is still useful there: its menu contains the
          bulk watched/unwatched controls for the entire season. */}
      {seasons.length > 0 && (
        <div className={`${styles.seasonRow} thin-scroll`} role="tablist" aria-label="Season">
          {seasons.map((s) => {
            const isActive = s === selectedSeason
            const menuOpen = openMenu?.kind === 'season' && openMenu.season === s
            // A season made up entirely of disambiguateVideos' synthetic
            // Specials entries (see core.ts) has nothing "Mark season
            // watched/unwatched" can act on — onMarkSeason's own
            // seasonEpisodes filter now excludes e.unplayable, so calling
            // it here would just silently no-op on an empty list. Hiding
            // the trigger (and so the menu it opens) for that case instead
            // of leaving a dead control, per the same reasoning that hides
            // the per-tile play/actions controls for these entries.
            const hasPlayableEpisodes = episodes.some((e) => e.season === s && !e.unplayable)
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
                {isActive && hasPlayableEpisodes && (
                  <button
                    type="button"
                    className={styles.seasonMenuTrigger}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    aria-label={`${seasonLabel(s)} actions`}
                    onClick={(e) => toggleMenu({ kind: 'season', season: s }, e.currentTarget)}
                  >
                    <Icon name="chevron-down" size={12} />
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {openMenu &&
        menuAnchor &&
        createPortal(
          <div
            ref={menuRef}
            className={`${styles.menu} ${menuAnchor.align === 'right' ? styles.menuRight : ''} glass-panel`}
            role="menu"
            style={{ top: menuAnchor.top, left: menuAnchor.left }}
          >
            {openMenu.kind === 'season' && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  onClick={() => {
                    onMarkSeason(openMenu.season, true)
                    closeMenu()
                  }}
                >
                  <Icon name="check" size={13} />
                  Mark season watched
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  onClick={() => {
                    onMarkSeason(openMenu.season, false)
                    closeMenu()
                  }}
                >
                  <Icon name="eye-off" size={13} />
                  Mark season unwatched
                </button>
              </>
            )}
            {menuEpisode && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  onClick={() => {
                    setPendingKey(key(menuEpisode.season, menuEpisode.episode))
                    onPlay(menuEpisode)
                    closeMenu()
                  }}
                >
                  <Icon name="play" size={13} />
                  Play {episodeCode(menuEpisode)}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  onClick={() => {
                    onMarkWatched(menuEpisode, !menuEpisodeWatched)
                    closeMenu()
                  }}
                >
                  <Icon name={menuEpisodeWatched ? 'eye-off' : 'eye'} size={13} />
                  {menuEpisodeWatched ? 'Mark unwatched' : 'Mark watched'}
                </button>
              </>
            )}
          </div>,
          document.body
        )}

      <ul className={styles.grid}>
        {visible.map((ep) => {
          const epKey = key(ep.season, ep.episode)
          const watched = watchedKeys.has(epKey)
          const isNext = nextEpisode?.season === ep.season && nextEpisode?.episode === ep.episode
          // A watched episode's leftover bookmark is noise, not progress —
          // savePlaybackPosition already clears one past 90%, but marking
          // an episode watched by hand (or a Simkl sync doing it) leaves
          // whatever partial position was there behind.
          const resume = watched ? undefined : resumeByKey.get(epKey)
          const isResolving = isShowResolving && pendingKey === epKey
          const menuOpen = openMenu?.kind === 'episode' && openMenu.episode.id === ep.id
          const title = ep.title || `Episode ${ep.episode}`
          const airDate = airDateLabel(ep.released)
          return (
            <li
              key={ep.id}
              className={`${styles.tile} ${isNext ? styles.tileNext : ''} ${
                watched ? styles.tileWatched : ''
              }`}
            >
              {/* The whole thumbnail is the play target, the way the
                  reference design works — a separate small play button
                  would be a far smaller hit area for the one action a
                  tile is overwhelmingly clicked for. Unplayable entries
                  (disambiguateVideos' synthetic Specials, see core.ts)
                  get a plain non-interactive thumbnail instead. */}
              {ep.unplayable ? (
                <div className={styles.thumbFrame}>
                  <ArtworkImage
                    src={episodeStillOrShowArt(ep, showArtwork)}
                    alt=""
                    fallbackTitle={title}
                    artTint={['#1c2a45', '#0a1220']}
                    className={styles.thumb}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  className={styles.thumbFrame}
                  onClick={() => {
                    setPendingKey(epKey)
                    onPlay(ep)
                  }}
                  disabled={isResolving}
                  aria-busy={isResolving}
                  aria-label={`Play ${title}`}
                >
                  <ArtworkImage
                    src={episodeStillOrShowArt(ep, showArtwork)}
                    alt=""
                    fallbackTitle={title}
                    artTint={['#1c2a45', '#0a1220']}
                    className={styles.thumb}
                  />
                  <span className={styles.playOverlay} aria-hidden="true">
                    {isResolving ? (
                      <span className={styles.playSpinner} />
                    ) : (
                      <Icon name={watched ? 'refresh' : 'play'} size={20} />
                    )}
                  </span>
                  {watched ? (
                    <span className={`${styles.badge} ${styles.badgeWatched}`}>
                      <Icon name="check" size={10} />
                      Watched
                    </span>
                  ) : isNext ? (
                    <span className={`${styles.badge} ${styles.badgeNext}`}>Next</span>
                  ) : resume?.remainingMinutes != null ? (
                    <span className={`${styles.badge} ${styles.badgeResume}`}>
                      {resume.remainingMinutes}m left
                    </span>
                  ) : runtimeMinutes != null ? (
                    <span className={`${styles.badge} ${styles.badgeRuntime}`}>
                      {runtimeMinutes}m
                    </span>
                  ) : null}
                  {resume && (
                    <span
                      className={styles.resumeTrack}
                      role="progressbar"
                      aria-label="Resume progress"
                      aria-valuenow={resume.percent}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <span className={styles.resumeFill} style={{ width: `${resume.percent}%` }} />
                    </span>
                  )}
                </button>
              )}

              <div className={styles.meta}>
                <span className={styles.showName}>{showTitle}</span>
                {/* The description no longer gets a line of its own (the
                    reference's tile caption is deliberately two lines) —
                    it's kept as the title's hover tooltip rather than
                    dropped, since this is the only place an episode
                    synopsis surfaces anywhere in the app. */}
                <h3 className={styles.title} title={ep.description || title}>
                  <span className={styles.code}>{episodeCode(ep)}</span>
                  <span className={styles.titleText}>{title}</span>
                </h3>
                <div className={styles.metaFooter}>
                  <span className={styles.subLabel}>
                    {airDate ?? (ep.unplayable ? 'Extra' : '')}
                  </span>
                  {!ep.unplayable && (
                    <button
                      type="button"
                      className={styles.tileMenuTrigger}
                      aria-haspopup="menu"
                      aria-expanded={menuOpen}
                      aria-label={`${title} actions`}
                      onClick={(e) => toggleMenu({ kind: 'episode', episode: ep }, e.currentTarget)}
                    >
                      <Icon name="more-horizontal" size={14} />
                    </button>
                  )}
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
