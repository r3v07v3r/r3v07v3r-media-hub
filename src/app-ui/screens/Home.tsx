import { useMemo } from 'react'
import { recommendationRailTitle } from '@shared/media-hub/recommendationReason'
import type { HomePersonalizedResult } from '@shared/media-hub/types'
import { api, useAsync } from '../lib/api'
import { toPosterItem, type PosterItem } from '../lib/posterItem'
import PosterRow from '../components/PosterRow'
import StatusNote from '../components/StatusNote'
import './Home.css'

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

  return (
    <div className="home-screen">
      <h1>Home</h1>
      {loading && !data && <StatusNote>Loading…</StatusNote>}
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
    </div>
  )
}
