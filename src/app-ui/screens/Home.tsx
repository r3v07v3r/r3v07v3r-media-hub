import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { recommendationRailTitle } from '@shared/media-hub/recommendationReason'
import type { HomePersonalizedResult, MediaKind } from '@shared/media-hub/types'
import { api, useAsync } from '../lib/api'
import { toPosterItem, type PosterItem } from '../lib/posterItem'
import PosterRow from '../components/PosterRow'
import PosterSkeleton from '../components/PosterSkeleton'
import LoadingNote from '../components/LoadingNote'
import StatusNote from '../components/StatusNote'
import './Home.css'

/** Stands in for one PosterRow while home:personalized hasn't answered yet
 *  — a heading-shaped bar over four poster-shaped ones, so the page reads
 *  as "loading" rather than as an empty Home with nothing to show. */
function SkeletonRow() {
  return (
    <section className="poster-row" aria-hidden="true">
      <span className="home-skeleton-heading skeleton-bar" />
      <div className="poster-row__track">
        {Array.from({ length: 4 }, (_, index) => (
          <PosterSkeleton key={index} />
        ))}
      </div>
    </section>
  )
}

/** Cards per Home row. A list can run to hundreds (171 planned titles on a
 *  real library), and every card is a DOM node and an image a TV box has to
 *  hold while it scrolls; the full list is a Browse away. */
const ROW_LIMIT = 40

interface Rail {
  id: string
  title: string
  items: PosterItem[]
}

/** The shelved rails home:personalized returns, titled the same way the
 *  desktop app titles them (recommendationRailTitle is shared, reused
 *  rather than re-derived). Falls back to the flat `recommendations`
 *  ranking as one row when nothing has been shelved yet — a fresh library,
 *  or the background rebuild hasn't produced reasons to shelve by. */
function buildRails(data: HomePersonalizedResult | null): Rail[] {
  if (!data) return []
  const shelved = (data.recommendationRails ?? [])
    .map((rail) => ({
      id: rail.id,
      title: recommendationRailTitle(rail.reason),
      items: rail.items.slice(0, ROW_LIMIT).map(toPosterItem)
    }))
    .filter((rail) => rail.title && rail.items.length > 0)
  if (shelved.length) return shelved
  if (data.recommendations.length) {
    return [
      {
        id: 'recommended',
        title: 'Recommended for you',
        items: data.recommendations.slice(0, ROW_LIMIT).map(toPosterItem)
      }
    ]
  }
  return []
}

interface Hero {
  id: string
  kind: MediaKind
  title: string
  art: string
  eyebrow: string
  detail: string
  action: string
}

/**
 * The one title at the top: the most likely next thing to watch. What is
 * already under way first (the next episode of something half-watched), then
 * a new episode of something followed, then the list, then the best pick.
 */
function pickHero(data: HomePersonalizedResult | null): Hero | null {
  if (!data) return null
  const art = (item: { background?: string; poster?: string }) =>
    item.background || item.poster || ''
  const next = data.continueWatching[0]
  if (next) {
    return {
      id: next.id,
      kind: next.type,
      title: next.title,
      art: art(next),
      eyebrow: 'Continue watching',
      detail: `Next: season ${next.continueSeason}, episode ${next.continueEpisode}`,
      action: 'Resume'
    }
  }
  const update = data.updates[0]
  if (update) {
    return {
      id: update.id,
      kind: update.type,
      title: update.title,
      art: art(update),
      eyebrow: 'New episode',
      detail: `Season ${update.latestEpisode.season}, episode ${update.latestEpisode.episode}${update.latestEpisode.title ? ` · ${update.latestEpisode.title}` : ''}`,
      action: 'Watch'
    }
  }
  const planned = data.tracked[0]
  if (planned) {
    return {
      id: planned.id,
      kind: planned.type,
      title: planned.title,
      art: art(planned),
      eyebrow: 'On your list',
      detail: [planned.year, planned.genres.slice(0, 2).join(' · ')].filter(Boolean).join(' · '),
      action: 'Open'
    }
  }
  const pick = data.recommendations[0]
  if (pick) {
    return {
      id: pick.id,
      kind: pick.type,
      title: pick.title,
      art: art(pick),
      eyebrow: 'Picked for you',
      detail: [pick.year, pick.genres.slice(0, 2).join(' · ')].filter(Boolean).join(' · '),
      action: 'Open'
    }
  }
  return null
}

export default function Home() {
  const { data, error, loading } = useAsync(() => {
    const mediaHub = api()
    if (!mediaHub) return Promise.reject(new Error('Not connected to a backend.'))
    return mediaHub.home.personalized()
  }, [])

  const hero = useMemo(() => pickHero(data), [data])
  const continueItems = useMemo(
    () =>
      (data?.continueWatching ?? []).map((entry) => ({
        ...toPosterItem(entry),
        subtitle: `Next: S${entry.continueSeason} · E${entry.continueEpisode}`
      })),
    [data]
  )
  const newEpisodes = useMemo(
    () =>
      (data?.updates ?? []).slice(0, ROW_LIMIT).map((update) => ({
        ...toPosterItem(update),
        subtitle:
          update.newEpisodeCount > 1
            ? `${update.newEpisodeCount} new · S${update.latestEpisode.season} · E${update.latestEpisode.episode}`
            : `New · S${update.latestEpisode.season} · E${update.latestEpisode.episode}`
      })),
    [data]
  )
  const planned = useMemo(() => (data?.tracked ?? []).slice(0, ROW_LIMIT).map(toPosterItem), [data])
  const rails = useMemo(() => buildRails(data), [data])
  const empty =
    !loading && !continueItems.length && !newEpisodes.length && !planned.length && !rails.length
  const firstLoad = loading && !data

  return (
    <div className="home-screen" aria-busy={loading}>
      {firstLoad ? (
        <>
          <div className="home-hero home-hero--skeleton skeleton-bar" aria-hidden="true" />
          <SkeletonRow />
          <SkeletonRow />
          <LoadingNote loading={loading} />
        </>
      ) : (
        <>
          {hero ? (
            <Link to={`/title/${hero.kind}/${hero.id}`} className="home-hero">
              {hero.art && (
                <img className="home-hero__art" src={hero.art} alt="" decoding="async" />
              )}
              <span className="home-hero__text">
                <span className="home-hero__eyebrow">{hero.eyebrow}</span>
                <span className="home-hero__title">{hero.title}</span>
                {hero.detail && <span className="home-hero__detail">{hero.detail}</span>}
                <span className="home-hero__action">▶ {hero.action}</span>
              </span>
            </Link>
          ) : (
            <h1>Home</h1>
          )}
          {error && (
            <StatusNote tone="error">Could not reach the backend for recommendations.</StatusNote>
          )}
          <PosterRow title="Continue Watching" items={continueItems} />
          <PosterRow title="New Episodes" items={newEpisodes} />
          <PosterRow title="Plan to Watch" items={planned} />
          {rails.map((rail) => (
            <PosterRow key={rail.id} title={rail.title} items={rail.items} />
          ))}
          {empty && !error && (
            <StatusNote>
              Nothing to show yet — browse Movies, Series or Anime to get started.
            </StatusNote>
          )}
        </>
      )}
    </div>
  )
}
