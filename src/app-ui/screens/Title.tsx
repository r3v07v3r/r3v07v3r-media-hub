import { useCallback, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { CatalogItem, Episode } from '@shared/media-hub/types'
import { hasAired } from '@shared/media-hub/catalog-logic'
import { episodeToStart } from '@shared/media-hub/nextEpisode'
// Reused rather than re-derived — see that file's own doc comment for
// exactly why series/anime need the season/episode suffix and movies don't.
import { buildMediaId } from '../../renderer/src/lib/mediaHub/streamId'
import { api, useAsync } from '../lib/api'
import { isMediaKind } from '../lib/mediaKind'
import { releaseCountdown, type ReleaseCountdown } from '../lib/releaseCountdown'
import LoadingNote from '../components/LoadingNote'
import Spinner from '../components/Spinner'
import StatusNote from '../components/StatusNote'
import './Title.css'

// `season`/`episode` ride along on the busy stages so a specific episode
// row can show its own spinner instead of every control in the page
// looking busy at once — see busyTargetOf below.
type PlayStatus =
  | { stage: 'idle' }
  | { stage: 'resolving'; season?: number; episode?: number }
  | { stage: 'starting'; season?: number; episode?: number }
  | { stage: 'error'; message: string }

/** The (season, episode) a play request in flight targets, or null when
 *  nothing is resolving/starting right now. */
function busyTargetOf(status: PlayStatus): { season?: number; episode?: number } | null {
  if (status.stage === 'resolving' || status.stage === 'starting') {
    return { season: status.season, episode: status.episode }
  }
  return null
}

/** Episodes grouped by season, in a Map keyed by season number (0 =
 *  specials) so the season tabs and the active season's list can both read
 *  it without re-scanning `videos`. Synthetic no-coordinate entries
 *  (Episode.unplayable) are dropped — see that field's own doc comment. */
function groupBySeason(videos: Episode[] | undefined): Map<number, Episode[]> {
  const seasons = new Map<number, Episode[]>()
  for (const episode of videos ?? []) {
    if (episode.unplayable) continue
    const list = seasons.get(episode.season) ?? []
    list.push(episode)
    seasons.set(episode.season, list)
  }
  for (const list of seasons.values()) list.sort((a, b) => a.episode - b.episode)
  return seasons
}

// No watch history is read here — this app has no continue-watching
// wiring yet (browse-first; see the task brief) — so episodeToStart always
// lands on the first playable episode, which is exactly what it falls
// back to internally once every episode is treated as unwatched.
const NO_WATCHED_KEYS = new Set<string>()

// Above this many characters the overview gets clamped with a More/Less
// toggle; below it, the full text already fits in the clamp's own line
// count and a toggle that does nothing would just be clutter.
const OVERVIEW_CLAMP_LENGTH = 220

/** The unreleased-movie Play button reads as a full sentence ("Releases in
 *  5 days") even though releaseCountdown's own near-term wording is bare
 *  ("In 5 days") for the meta line beside it — a bare countdown works
 *  there because "Releases"/"Airs" is already implied by context, but a
 *  button needs to stand on its own. The >30-day fallback already carries
 *  its own verb, so it is left untouched rather than double-prefixed. */
function asButtonLabel(countdown: ReleaseCountdown): string {
  if (countdown.label.startsWith('Releases') || countdown.label.startsWith('Airs')) {
    return countdown.label
  }
  return `Releases ${countdown.label.charAt(0).toLowerCase()}${countdown.label.slice(1)}`
}

function BackIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function PlayGlyph() {
  return (
    <svg
      className="episode-row__glyph"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8 5v14l11-7z" />
    </svg>
  )
}

export default function Title() {
  const navigate = useNavigate()
  const params = useParams<{ kind: string; id: string }>()
  const kind = isMediaKind(params.kind) ? params.kind : null
  const id = params.id ?? null

  const {
    data: item,
    error,
    loading
  } = useAsync<CatalogItem | null>(() => {
    if (!kind || !id) return Promise.resolve(null)
    const mediaHub = api()
    if (!mediaHub) return Promise.reject(new Error('Not connected to a backend.'))
    return mediaHub.catalog.meta(kind, id)
  }, [kind, id])

  const seasons = useMemo(() => groupBySeason(item?.videos), [item])
  const seasonNumbers = useMemo(() => Array.from(seasons.keys()).sort((a, b) => a - b), [seasons])
  const startTarget = useMemo(
    () => (item ? episodeToStart(item.videos, NO_WATCHED_KEYS) : null),
    [item]
  )

  const [selectedSeason, setSelectedSeason] = useState<number | null>(null)
  const activeSeason = selectedSeason ?? startTarget?.season ?? seasonNumbers[0] ?? null
  const activeEpisodes = useMemo(() => {
    const list = seasons.get(activeSeason ?? -1) ?? []
    return list.map((episode) => ({ episode, aired: hasAired(episode) }))
  }, [seasons, activeSeason])

  const [playStatus, setPlayStatus] = useState<PlayStatus>({ stage: 'idle' })
  const playRequestRef = useRef(0)

  const play = useCallback(
    (season?: number, episode?: number, episodeTitle?: string) => {
      if (!kind || !item) return
      const mediaHub = api()
      const requestId = ++playRequestRef.current
      if (!mediaHub) {
        setPlayStatus({
          stage: 'error',
          message: 'Playback is not available outside the desktop app.'
        })
        return
      }
      setPlayStatus({ stage: 'resolving', season, episode })
      // Mirrors AppStateContext's runPlayback exactly (see its own comment
      // on why anime's resolve id drops the season segment that
      // buildMediaId's own `mediaId` keeps).
      const mediaId = buildMediaId(kind, item.id, season, episode)
      const resolveId = kind === 'anime' ? `${item.id}:${episode ?? 1}` : mediaId
      mediaHub.stream
        .resolve(
          kind,
          resolveId,
          item.title,
          { catalogId: item.id, seasonNumber: season, episodeNumber: episode },
          item.originalTitle ? [item.originalTitle] : undefined
        )
        .then((resolved) => {
          if (playRequestRef.current !== requestId) return null
          const best = resolved.best
          if (!best) {
            setPlayStatus({
              stage: 'error',
              message: resolved.queued
                ? "This title wasn't cached yet — TorBox has started downloading it. Try again shortly."
                : 'No sources were found for this title yet.'
            })
            return null
          }
          setPlayStatus({ stage: 'starting', season, episode })
          return mediaHub.stream.play(best, mediaId, kind, resolveId, {
            catalogId: item.id,
            title: item.title,
            posterUrl: item.poster,
            mediaKind: kind,
            seasonNumber: season,
            episodeNumber: episode,
            episodeTitle
          })
        })
        .then((result) => {
          if (!result || playRequestRef.current !== requestId) return
          // Nothing more to show here yet — an embedded player isn't wired
          // into this UI in this step (see the task brief); a successful
          // stream:play just means the backend genuinely started one.
          setPlayStatus({ stage: 'idle' })
        })
        .catch((error: unknown) => {
          if (playRequestRef.current !== requestId) return
          setPlayStatus({
            stage: 'error',
            message: error instanceof Error ? error.message : 'Playback unavailable.'
          })
        })
    },
    [kind, item]
  )

  // "My List" — a plain binary state read once from the whole tracked list
  // (see the task brief: this is deliberately NOT the desktop's tri-state
  // TitleStatusButton, just tracked/not), with an optimistic local override
  // keyed to the current item so the button flips the instant it's pressed
  // rather than waiting on the round trip, and reverts if the call fails.
  const tracking = useAsync(() => {
    const mediaHub = api()
    if (!mediaHub) return Promise.reject(new Error('Not connected to a backend.'))
    return mediaHub.tracking.list()
  }, [])
  const [pendingTracked, setPendingTracked] = useState<{ id: string; tracked: boolean } | null>(
    null
  )
  const trackedFromList = Boolean(
    item && tracking.data?.tracked.some((entry) => entry.id === item.id)
  )
  const isTracked =
    item && pendingTracked?.id === item.id ? pendingTracked.tracked : trackedFromList
  const toggleTracked = useCallback(() => {
    if (!item) return
    const mediaHub = api()
    if (!mediaHub) return
    const next = !isTracked
    setPendingTracked({ id: item.id, tracked: next })
    mediaHub.tracking.toggle(item).then(
      (result) => setPendingTracked({ id: item.id, tracked: result.tracked }),
      () => setPendingTracked({ id: item.id, tracked: !next })
    )
  }, [item, isTracked])

  const [overviewExpanded, setOverviewExpanded] = useState(false)

  if (!kind || !id) return <StatusNote tone="error">Title not found.</StatusNote>
  if (loading && !item) {
    // A skeleton shaped like the real hero + header rather than a bare
    // "Loading…" line, so nothing jumps around when catalog.meta answers
    // — see the task brief.
    return (
      <div className="title-screen" aria-busy="true">
        <div className="title-screen__hero-skeleton skeleton-bar" aria-hidden="true" />
        <div className="title-screen__skeleton-body" aria-hidden="true">
          <span className="title-screen__poster skeleton-bar" />
          <div className="title-screen__skeleton-lines">
            <span className="skeleton-bar title-screen__skeleton-line title-screen__skeleton-line--title" />
            <span className="skeleton-bar title-screen__skeleton-line title-screen__skeleton-line--meta" />
            <span className="skeleton-bar title-screen__skeleton-line title-screen__skeleton-line--overview" />
          </div>
        </div>
        <LoadingNote loading={loading} />
      </div>
    )
  }
  if (error) return <StatusNote tone="error">Could not load this title.</StatusNote>
  if (!item) return <StatusNote tone="error">Title not found.</StatusNote>

  const isSeries = kind === 'series' || kind === 'anime'

  // A movie whose release date is still ahead gets the countdown wherever
  // a date would normally show, and a disabled Play — see the task brief.
  // Series/anime convey the same idea per-episode instead (hasAired above
  // already gates each episode row), so this only ever applies to a movie.
  const movieCountdown = kind === 'movie' ? releaseCountdown(item.releaseDate, 'Releases') : null
  const isUnreleasedMovie = movieCountdown !== null && !movieCountdown.released

  let metaLine: string
  let playLabel: string
  if (isUnreleasedMovie && movieCountdown) {
    metaLine = movieCountdown.label
    playLabel = asButtonLabel(movieCountdown)
  } else {
    metaLine = [item.year, item.runtime, item.rating ? `★ ${item.rating}` : null]
      .filter(Boolean)
      .join(' · ')
    playLabel =
      isSeries && startTarget ? `Play S${startTarget.season} · E${startTarget.episode}` : 'Play'
  }

  const overview = item.description ?? ''
  const overviewIsLong = overview.length > OVERVIEW_CLAMP_LENGTH

  // Which (season, episode) a play request is resolving/starting for, if
  // any — every Play control is disabled while one is in flight (no
  // double taps), and the one that was actually pressed shows a spinner.
  const busyTarget = busyTargetOf(playStatus)
  const mainPlayTarget = {
    season: isSeries ? startTarget?.season : undefined,
    episode: isSeries ? startTarget?.episode : undefined
  }
  const isMainPlayBusy =
    busyTarget !== null &&
    busyTarget.season === mainPlayTarget.season &&
    busyTarget.episode === mainPlayTarget.episode

  return (
    <div className="title-screen" aria-busy={loading}>
      <div className="title-screen__hero">
        {item.background ? (
          <img
            className="title-screen__hero-img"
            src={item.background}
            alt=""
            loading="eager"
            decoding="async"
          />
        ) : (
          <div className="title-screen__hero-fallback" aria-hidden="true" />
        )}
        <div className="title-screen__scrim" aria-hidden="true" />
        <button
          type="button"
          className="title-screen__back"
          aria-label="Back"
          onClick={() => navigate(-1)}
        >
          <BackIcon />
        </button>
      </div>

      <div className="title-screen__content">
        <span className="title-screen__poster">
          {item.poster ? <img src={item.poster} alt="" loading="eager" decoding="async" /> : null}
        </span>

        <div className="title-screen__heading">
          <h1>{item.title}</h1>
          {metaLine && <p className="title-screen__meta">{metaLine}</p>}
        </div>

        {item.genres.length > 0 && (
          <div className="title-screen__chips">
            {[...new Set(item.genres)].map((genre) => (
              <span key={genre} className="title-screen__chip">
                {genre}
              </span>
            ))}
          </div>
        )}

        <div className="title-screen__actions">
          <div className="title-screen__actions-row">
            <button
              type="button"
              className="title-screen__play"
              disabled={isUnreleasedMovie || busyTarget !== null}
              aria-busy={isMainPlayBusy}
              onClick={() => play(mainPlayTarget.season, mainPlayTarget.episode)}
            >
              {isMainPlayBusy && <Spinner size="sm" />}
              {playLabel}
            </button>
            <button
              type="button"
              className="title-screen__mylist"
              aria-pressed={isTracked}
              aria-label={isTracked ? 'Remove from My List' : 'Add to My List'}
              onClick={toggleTracked}
            >
              {isTracked ? <CheckIcon /> : <PlusIcon />}
            </button>
          </div>
          {playStatus.stage === 'resolving' && <StatusNote>Resolving stream…</StatusNote>}
          {playStatus.stage === 'starting' && <StatusNote>Starting playback…</StatusNote>}
          {playStatus.stage === 'error' && (
            <StatusNote tone="error">{playStatus.message}</StatusNote>
          )}
        </div>

        {overview && (
          <div className="title-screen__overview">
            <p className={'title-screen__overview-text' + (overviewExpanded ? ' is-expanded' : '')}>
              {overview}
            </p>
            {overviewIsLong && (
              <button
                type="button"
                className="title-screen__overview-toggle"
                onClick={() => setOverviewExpanded((expanded) => !expanded)}
              >
                {overviewExpanded ? 'Less' : 'More'}
              </button>
            )}
          </div>
        )}

        {isSeries && seasonNumbers.length > 0 && (
          <section className="title-screen__seasons">
            <h2>Episodes</h2>
            <div className="title-screen__season-tabs">
              {seasonNumbers.map((season) => (
                <button
                  key={season}
                  type="button"
                  aria-pressed={activeSeason === season}
                  className="title-screen__season-tab"
                  onClick={() => setSelectedSeason(season)}
                >
                  {season === 0 ? 'Specials' : `Season ${season}`}
                </button>
              ))}
            </div>
            <ul className="title-screen__episodes">
              {activeEpisodes.map(({ episode, aired }) => {
                // Already aired -> a short readable date. Not yet -> the
                // countdown, or "TBA" when even the source doesn't know
                // when — see releaseCountdown and the task brief.
                const countdown = releaseCountdown(episode.released, 'Airs')
                const secondaryLine = countdown ? countdown.label : aired ? null : 'TBA'
                const isBusyHere =
                  busyTarget !== null &&
                  busyTarget.season === episode.season &&
                  busyTarget.episode === episode.episode
                return (
                  <li key={`${episode.season}:${episode.episode}`}>
                    <button
                      type="button"
                      className="episode-row"
                      disabled={!aired || busyTarget !== null}
                      aria-busy={isBusyHere}
                      onClick={() => play(episode.season, episode.episode, episode.title)}
                    >
                      <span className="episode-row__number">E{episode.episode}</span>
                      <span className="episode-row__body">
                        <span className="episode-row__title">
                          {episode.title || `Episode ${episode.episode}`}
                        </span>
                        {secondaryLine && (
                          <span className="episode-row__date">{secondaryLine}</span>
                        )}
                      </span>
                      {isBusyHere ? <Spinner size="sm" /> : aired && <PlayGlyph />}
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}
