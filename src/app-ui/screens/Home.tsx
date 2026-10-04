import { useMemo } from 'react'
import { recommendationRailTitle } from '@shared/media-hub/recommendationReason'
import type { HomePersonalizedResult } from '@shared/media-hub/types'
import { api, useAsync } from '../lib/api'
import { useCatchUp, useLibraryRefresh } from '../lib/librarySync'
import { toPosterItem, trackedToPosterItem, type PosterItem } from '../lib/posterItem'
import { useSlowLoad } from '../lib/useSlowLoad'
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

/** Under this long, a catch-up finishes before anybody could read a note
 *  about it, so none is shown and a fast pass never flickers the page. */
const UPDATING_NOTE_DELAY_MS = 1000

export default function Home() {
  const { data, error, loading, refresh } = useAsync(() => {
    const mediaHub = api()
    if (!mediaHub) return Promise.reject(new Error('Not connected to a backend.'))
    return mediaHub.home.personalized()
  }, [])
  // Home is where a catch-up's results show, so it refetches behind what is
  // on screen whenever one lands — never back to the skeleton.
  useLibraryRefresh(refresh)
  const catchUp = useCatchUp()
  const updating = useSlowLoad(catchUp.inFlight, UPDATING_NOTE_DELAY_MS)

  const continueItems = useMemo(
    () =>
      (data?.continueWatching ?? []).map((entry) => ({
        ...toPosterItem(entry),
        subtitle: `S${entry.continueSeason} · E${entry.continueEpisode}`
      })),
    [data]
  )
  // All of it, in one row. Browse already holds hundreds of lazily loaded
  // cards in a row like this, so a long list needs no second screen.
  const plannedItems = useMemo(() => (data?.planned ?? []).map(trackedToPosterItem), [data])
  const rails = useMemo(() => buildRails(data), [data])
  const noPersonalRows = !continueItems.length && !plannedItems.length
  // Not "empty" while a catch-up is still running: on a freshly linked phone
  // the rows are empty precisely because it has not answered yet.
  const empty = !loading && !catchUp.inFlight && noPersonalRows && !rails.length
  const firstLoad = loading && !data
  // A report with no `at` is the backend declining to run (something was
  // playing) before any pass ever has; it knows nothing about what is
  // connected, so it must not be read as "nothing is".
  const report = catchUp.report && catchUp.report.at > 0 ? catchUp.report : null

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
          {updating && <StatusNote>Updating…</StatusNote>}
          {report?.signedOut ? (
            <StatusNote>
              Simkl signed this device out. Link your computer again in Settings.
            </StatusNote>
          ) : (
            report?.connected === false &&
            noPersonalRows && (
              <StatusNote>
                Link your computer in Settings to see what you&apos;re watching and your plan to
                watch list.
              </StatusNote>
            )
          )}
          <PosterRow title="Continue Watching" items={continueItems} />
          <PosterRow title="Plan to Watch" items={plannedItems} />
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
