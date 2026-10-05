import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import type { CatalogItem, Episode, TitleWatchState } from '@shared/media-hub/types'
import { nativeHost } from '../lib/nativeHost'
import { setNowPlaying } from '../lib/nowPlaying'
import { hasAired } from '@shared/media-hub/catalog-logic'
import { episodeToStart, episodeWatchKey } from '@shared/media-hub/nextEpisode'
// Reused rather than re-derived — see that file's own doc comment for
// exactly why series/anime need the season/episode suffix and movies don't.
import { buildMediaId } from '../../renderer/src/lib/mediaHub/streamId'
import { api, useAsync } from '../lib/api'
import { useLibraryRefresh } from '../lib/librarySync'
import { isMediaKind } from '../lib/mediaKind'
import { releaseCountdown, type ReleaseCountdown } from '../lib/releaseCountdown'
import { timelineExtrasToPosterItems, type PosterItem } from '../lib/posterItem'
import LoadingNote from '../components/LoadingNote'
import PosterRow from '../components/PosterRow'
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
  /** A source was resolved, but this host has no player yet. */
  | { stage: 'found'; message: string }

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

function ThumbsDownIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.7a2 2 0 0 0-2 1.7l-1.4 9A2 2 0 0 0 4.3 15H10z" />
      <path d="M17 2h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3" />
    </svg>
  )
}

/** How long the Undo after Not interested stays, as on the desktop's toast. */
const DISLIKE_UNDO_MS = 8000

/** The small mark beside a watched episode's number — the check from My
 *  List, scaled down to sit inside the row rather than compete with it. */
function WatchedTick() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
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
    data: fetched,
    error,
    loading: fetching
  } = useAsync<CatalogItem | null>(() => {
    if (!kind || !id) return Promise.resolve(null)
    const mediaHub = api()
    if (!mediaHub) return Promise.reject(new Error('Not connected to a backend.'))
    return mediaHub.catalog.meta(kind, id)
  }, [kind, id])

  // A later season of a merged anime, opened by its own id (a plan card the
  // watchlist pull added): the show's page, at that season. A merged season
  // has no page of its own — anything played from one was saved under an id
  // the show never read. In place of this entry, so Back still leaves the
  // title; and the page stays on its loading state until the show arrives,
  // rather than offering a Play button for a title about to be replaced.
  const seasonOf = fetched?.seasonOf ?? null
  const item = seasonOf ? null : fetched
  const loading = fetching || seasonOf !== null
  useEffect(() => {
    // Not again once the route is the show's: the answer for the id that
    // was asked can still be in hand while the show's is on its way.
    if (!kind || !seasonOf || seasonOf.id === id) return
    navigate(`/title/${kind}/${seasonOf.id}`, { replace: true, state: { season: seasonOf.season } })
  }, [kind, id, seasonOf, navigate])
  // The season such a link asked for, left in the navigation state above.
  const location = useLocation()
  const openedSeason = (location.state as { season?: number } | null)?.season ?? null

  // What the local record says about this title: on the list or not, and
  // which episodes are watched. Asked by the id catalog.meta RETURNED, not
  // the route's — that is the id history is kept under, and the two differ
  // whenever a link names a title by another of its ids. The answer carries
  // the id it is for, so a page that has moved on to another title can tell
  // a stale answer from a current one.
  const itemId = item?.id ?? null
  const watchState = useAsync<{ id: string; state: TitleWatchState } | null>(() => {
    if (!itemId) return Promise.resolve(null)
    const mediaHub = api()
    if (!mediaHub) return Promise.reject(new Error('Not connected to a backend.'))
    return mediaHub.tracking.titleState(itemId).then((state) => ({ id: itemId, state }))
  }, [itemId])
  // A catch-up or the watchlist pull can change either half while the page
  // is open; refetched behind the page, so nothing on it blinks.
  useLibraryRefresh(watchState.refresh)

  // A merged anime's films, OVAs and specials are titles of their own, not
  // seasons: listed under the episodes, each placed among the seasons it
  // came out between (catalog.story's release-order timeline).
  const mergedAnimeId = kind === 'anime' && item?.groupedIds?.length ? item.id : null
  const extras = useAsync<PosterItem[]>(() => {
    const mediaHub = api()
    if (!mergedAnimeId || !mediaHub) return Promise.resolve([])
    return mediaHub.catalog
      .story('anime', mergedAnimeId, 'release')
      .then((result) => timelineExtrasToPosterItems(result.timeline ?? []))
  }, [mergedAnimeId])
  const stateForItem = itemId && watchState.data?.id === itemId ? watchState.data.state : null
  // Answered, or failed — failing falls back to "nothing watched", which is
  // exactly what Play did before this screen read any history.
  const watchStateSettled =
    stateForItem !== null || (!watchState.loading && watchState.error !== null)

  const watchedKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const row of stateForItem?.watched ?? []) {
      if (Number.isFinite(row.season) && Number.isFinite(row.episode)) {
        keys.add(episodeWatchKey(row.season, row.episode))
      }
    }
    return keys
  }, [stateForItem])

  const seasons = useMemo(() => groupBySeason(item?.videos), [item])
  const seasonNumbers = useMemo(() => Array.from(seasons.keys()).sort((a, b) => a - b), [seasons])
  const startTarget = useMemo(
    () => (item ? episodeToStart(item.videos, watchedKeys) : null),
    [item, watchedKeys]
  )

  const [selectedSeason, setSelectedSeason] = useState<number | null>(null)
  const activeSeason =
    selectedSeason ??
    (openedSeason != null && seasons.has(openedSeason) ? openedSeason : null) ??
    startTarget?.season ??
    seasonNumbers[0] ??
    null
  const activeEpisodes = useMemo(() => {
    const list = seasons.get(activeSeason ?? -1) ?? []
    return list.map((episode) => ({ episode, aired: hasAired(episode) }))
  }, [seasons, activeSeason])

  const [playStatus, setPlayStatus] = useState<PlayStatus>({ stage: 'idle' })
  const playRequestRef = useRef(0)
  // Leaving the title (or moving to another one) abandons a request still
  // resolving, so it cannot land on a page nobody is looking at.
  useEffect(() => {
    const requests = playRequestRef
    return () => {
      requests.current += 1
    }
  }, [kind, id])

  const play = useCallback(
    (season?: number, episode?: number) => {
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
          // Only the Android app can show video: it runs the player under this
          // page (main/media-hub/hostPlayer.ts). In a plain browser against a
          // headless backend there is nothing to show it in, so resolving is
          // as far as it goes — it still answers "can this be played".
          if (!nativeHost()) {
            setPlayStatus({
              stage: 'found',
              message: 'A source is ready. Playback needs the R3 Media Hub app.'
            })
            return null
          }
          setPlayStatus({ stage: 'starting', season, episode })
          setNowPlaying({ kind, item, season, episode })
          return mediaHub.stream
            .play(best, mediaId, kind, resolveId, {
              catalogId: item.id,
              title: item.title,
              posterUrl: item.poster,
              mediaKind: kind,
              seasonNumber: season,
              episodeNumber: episode
            })
            .then(() => {
              if (playRequestRef.current !== requestId) return
              setPlayStatus({ stage: 'idle' })
              navigate('/player')
            })
        })
        .catch((error: unknown) => {
          if (playRequestRef.current !== requestId) return
          setPlayStatus({
            stage: 'error',
            message: error instanceof Error ? error.message : 'Playback unavailable.'
          })
        })
    },
    [kind, item, navigate]
  )

  // "My List" — a plain binary state from the title's own watch state above
  // (see the task brief: this is deliberately NOT the desktop's tri-state
  // TitleStatusButton, just tracked/not), with an optimistic local override
  // keyed to the current item so the button flips the instant it's pressed
  // rather than waiting on the round trip, and reverts if the call fails.
  //
  // The override stands only against the watch state it was made over
  // (`basis`). That state refreshes behind the page now — a catch-up or a
  // watchlist pull can put a title back on the list, or take one off —
  // and an override that outlived a newer answer would leave the button
  // saying "add" over a title that is already on the list: toggle() flips
  // whatever the backend holds, so the press would remove it.
  const [pendingTracked, setPendingTracked] = useState<{
    id: string
    tracked: boolean
    basis: TitleWatchState | null
  } | null>(null)
  const trackedLoaded = stateForItem !== null
  const isTracked =
    item && pendingTracked?.id === item.id && pendingTracked.basis === stateForItem
      ? pendingTracked.tracked
      : Boolean(stateForItem?.tracked)
  const refreshWatchState = watchState.refresh
  const toggleTracked = useCallback(() => {
    // toggle() flips whatever the backend holds, so pressing it before the
    // state has loaded could remove a title the button offered to add.
    if (!item || !trackedLoaded) return
    const mediaHub = api()
    if (!mediaHub) return
    const next = !isTracked
    const basis = stateForItem
    setPendingTracked({ id: item.id, tracked: next, basis })
    mediaHub.tracking.toggle(item).then(
      (result) => {
        setPendingTracked({ id: item.id, tracked: result.tracked, basis })
        // Read back what the backend now holds, so the override is retired
        // by a real answer rather than standing for the life of the page.
        // refresh() queues behind a fetch already running, so this one is
        // certain to land after the write.
        refreshWatchState()
      },
      () => setPendingTracked({ id: item.id, tracked: !next, basis })
    )
  }, [item, isTracked, trackedLoaded, stateForItem, refreshWatchState])

  // Not interested: the same local dislike the desktop's card menu sets
  // (disliked:add / disliked:remove on this device's own database). It
  // keeps the title out of this device's recommendations; nothing is sent
  // to the tracking services, and the desktop keeps its own. Read from the
  // disliked list for this title, with an optimistic override held against
  // the answer it was made over, the same way My List's is above.
  const dislikedState = useAsync<{ id: string; disliked: boolean } | null>(() => {
    if (!itemId) return Promise.resolve(null)
    const mediaHub = api()
    if (!mediaHub) return Promise.reject(new Error('Not connected to a backend.'))
    return mediaHub.disliked
      .list()
      .then(({ disliked }) => ({ id: itemId, disliked: disliked.some((row) => row.id === itemId) }))
  }, [itemId])
  const dislikedForItem = itemId && dislikedState.data?.id === itemId ? dislikedState.data : null
  const [pendingDisliked, setPendingDisliked] = useState<{
    id: string
    disliked: boolean
    basis: typeof dislikedForItem
  } | null>(null)
  const isDisliked =
    item && pendingDisliked?.id === item.id && pendingDisliked.basis === dislikedForItem
      ? pendingDisliked.disliked
      : Boolean(dislikedForItem?.disliked)
  // The one-tap way back after Not interested, for a few seconds. The
  // button itself also takes it back, but the line says what happened.
  const [dislikeUndoFor, setDislikeUndoFor] = useState<string | null>(null)
  useEffect(() => {
    if (!dislikeUndoFor) return
    const timer = setTimeout(() => setDislikeUndoFor(null), DISLIKE_UNDO_MS)
    return () => clearTimeout(timer)
  }, [dislikeUndoFor])
  const refreshDisliked = dislikedState.refresh
  const setDisliked = useCallback(
    (disliked: boolean) => {
      if (!item || !dislikedForItem) return
      const mediaHub = api()
      if (!mediaHub) return
      const basis = dislikedForItem
      setPendingDisliked({ id: item.id, disliked, basis })
      setDislikeUndoFor(disliked ? item.id : null)
      const write = disliked ? mediaHub.disliked.add(item) : mediaHub.disliked.remove(item.id)
      write.then(
        (result) => {
          setPendingDisliked({ id: item.id, disliked: result.disliked, basis })
          refreshDisliked()
        },
        () => {
          setPendingDisliked({ id: item.id, disliked: !disliked, basis })
          setDislikeUndoFor(null)
        }
      )
    },
    [item, dislikedForItem, refreshDisliked]
  )

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
  // A series' main Play waits for the watch state: pressed any sooner it
  // would start S1E1 for somebody halfway through the show. It reads as busy
  // (the spinner) rather than broken while it waits. Episode rows are not
  // held back — choosing one is explicit — and a film has nothing to wait for.
  const waitingForWatchState = isSeries && !watchStateSettled

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
              disabled={isUnreleasedMovie || busyTarget !== null || waitingForWatchState}
              aria-busy={isMainPlayBusy || waitingForWatchState}
              onClick={() => play(mainPlayTarget.season, mainPlayTarget.episode)}
            >
              {(isMainPlayBusy || waitingForWatchState) && <Spinner size="sm" />}
              {waitingForWatchState ? 'Play' : playLabel}
            </button>
            <button
              type="button"
              className="title-screen__mylist"
              aria-pressed={isTracked}
              aria-label={isTracked ? 'Remove from My List' : 'Add to My List'}
              onClick={toggleTracked}
              disabled={!trackedLoaded}
            >
              {isTracked ? <CheckIcon /> : <PlusIcon />}
            </button>
            <button
              type="button"
              className="title-screen__mylist title-screen__dislike"
              aria-pressed={isDisliked}
              aria-label={isDisliked ? 'Remove Not interested' : 'Not interested'}
              onClick={() => setDisliked(!isDisliked)}
              disabled={!dislikedForItem}
            >
              <ThumbsDownIcon />
            </button>
          </div>
          {isDisliked && item && dislikeUndoFor === item.id && (
            <p className="status-note title-screen__undo" role="status">
              Marked Not interested. It won&apos;t be recommended here.
              <button type="button" onClick={() => setDisliked(false)}>
                Undo
              </button>
            </p>
          )}
          {playStatus.stage === 'resolving' && <StatusNote>Resolving stream…</StatusNote>}
          {playStatus.stage === 'starting' && <StatusNote>Starting playback…</StatusNote>}
          {playStatus.stage === 'found' && <StatusNote>{playStatus.message}</StatusNote>}
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
                const watched = watchedKeys.has(episodeWatchKey(episode.season, episode.episode))
                return (
                  <li key={`${episode.season}:${episode.episode}`}>
                    <button
                      type="button"
                      className="episode-row"
                      disabled={!aired || busyTarget !== null}
                      aria-busy={isBusyHere}
                      onClick={() => play(episode.season, episode.episode)}
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
                      {/* Its own flex item at the row's end, beside the play
                          glyph, so a watched row's title starts where every
                          other row's does. */}
                      {watched && (
                        <span className="episode-row__watched">
                          <WatchedTick />
                          <span className="visually-hidden">Watched</span>
                        </span>
                      )}
                      {isBusyHere ? <Spinner size="sm" /> : aired && <PlayGlyph />}
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {extras.data && <PosterRow title="Films and specials" items={extras.data} />}
      </div>
    </div>
  )
}
