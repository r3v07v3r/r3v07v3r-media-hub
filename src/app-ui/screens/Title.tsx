import { useCallback, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { CatalogItem, Episode } from '@shared/media-hub/types'
import { hasAired } from '@shared/media-hub/catalog-logic'
import { episodeToStart } from '@shared/media-hub/nextEpisode'
// Reused rather than re-derived — see that file's own doc comment for
// exactly why series/anime need the season/episode suffix and movies don't.
import { buildMediaId } from '../../renderer/src/lib/mediaHub/streamId'
import { api, useAsync } from '../lib/api'
import { isMediaKind } from '../lib/mediaKind'
import StatusNote from '../components/StatusNote'
import './Title.css'

type PlayStatus =
  | { stage: 'idle' }
  | { stage: 'resolving' }
  | { stage: 'starting' }
  | { stage: 'error'; message: string }

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

export default function Title() {
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
      setPlayStatus({ stage: 'resolving' })
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
          setPlayStatus({ stage: 'starting' })
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

  if (!kind || !id) return <StatusNote tone="error">Title not found.</StatusNote>
  if (loading && !item) return <StatusNote>Loading…</StatusNote>
  if (error) return <StatusNote tone="error">Could not load this title.</StatusNote>
  if (!item) return <StatusNote tone="error">Title not found.</StatusNote>

  const isSeries = kind === 'series' || kind === 'anime'
  const metaLine = [item.year, item.runtime, item.rating ? `★ ${item.rating}` : null]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="title-screen">
      {item.background ? (
        <div
          className="title-screen__backdrop"
          style={{ backgroundImage: `url(${item.background})` }}
        />
      ) : null}
      <div className="title-screen__body">
        <span className="title-screen__poster">
          {item.poster ? <img src={item.poster} alt="" loading="lazy" decoding="async" /> : null}
        </span>
        <div className="title-screen__info">
          <h1>{item.title}</h1>
          {metaLine && <p className="title-screen__meta">{metaLine}</p>}
          {item.genres.length > 0 && (
            <p className="title-screen__genres">{[...new Set(item.genres)].join(', ')}</p>
          )}
          {item.description && <p className="title-screen__overview">{item.description}</p>}
          <button
            type="button"
            className="title-screen__play"
            onClick={() =>
              play(
                isSeries ? startTarget?.season : undefined,
                isSeries ? startTarget?.episode : undefined
              )
            }
          >
            Play
          </button>
          {playStatus.stage === 'resolving' && <StatusNote>Resolving stream…</StatusNote>}
          {playStatus.stage === 'starting' && <StatusNote>Starting playback…</StatusNote>}
          {playStatus.stage === 'error' && (
            <StatusNote tone="error">{playStatus.message}</StatusNote>
          )}
        </div>
      </div>

      {isSeries && seasonNumbers.length > 0 && (
        <div className="title-screen__seasons">
          <div className="title-screen__season-tabs" role="tablist" aria-label="Season">
            {seasonNumbers.map((season) => (
              <button
                key={season}
                type="button"
                role="tab"
                aria-selected={activeSeason === season}
                className={
                  'title-screen__season-tab' + (activeSeason === season ? ' is-active' : '')
                }
                onClick={() => setSelectedSeason(season)}
              >
                {season === 0 ? 'Specials' : `Season ${season}`}
              </button>
            ))}
          </div>
          <ul className="title-screen__episodes">
            {activeEpisodes.map(({ episode, aired }) => (
              <li key={`${episode.season}:${episode.episode}`} className="episode-row">
                <div className="episode-row__info">
                  <span className="episode-row__number">E{episode.episode}</span>
                  <span className="episode-row__title">
                    {episode.title || `Episode ${episode.episode}`}
                  </span>
                  {!aired && (
                    <span className="episode-row__badge">{episode.released || 'TBA'}</span>
                  )}
                </div>
                <button
                  type="button"
                  disabled={!aired}
                  onClick={() => play(episode.season, episode.episode, episode.title)}
                >
                  Play
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
