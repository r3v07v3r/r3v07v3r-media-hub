import { useMemo } from 'react'
import { recommendationRailTitle } from '@shared/media-hub/recommendationReason'
import type { HomePersonalizedResult } from '@shared/media-hub/types'
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
      items: rail.items.map(toPosterItem)
    }))
    .filter((rail) => rail.title && rail.items.length > 0)
  if (shelved.length) return shelved
  if (data.recommendations.length) {
    return [
      {
        id: 'recommended',
        title: 'Recommended for you',
        items: data.recommendations.map(toPosterItem)
      }
    ]
  }
  return []
}

export default function Home() {
  const { data, error, loading } = useAsync(() => {
    const mediaHub = api()
    if (!mediaHub) return Promise.reject(new Error('Not connected to a backend.'))
    return mediaHub.home.personalized()
  }, [])

  const continueItems = useMemo(
    () =>
      (data?.continueWatching ?? []).map((entry) => ({
        ...toPosterItem(entry),
        subtitle: `S${entry.continueSeason} · E${entry.continueEpisode}`
      })),
    [data]
  )
  const rails = useMemo(() => buildRails(data), [data])
  const empty = !loading && !continueItems.length && !rails.length
  const firstLoad = loading && !data

  return (
    <div className="home-screen" aria-busy={loading}>
      <h1>Home</h1>
      {firstLoad ? (
        <>
          <SkeletonRow />
          <SkeletonRow />
          <LoadingNote loading={loading} />
        </>
      ) : (
        <>
          {error && (
            <StatusNote tone="error">Could not reach the backend for recommendations.</StatusNote>
          )}
          <PosterRow title="Continue Watching" items={continueItems} />
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
