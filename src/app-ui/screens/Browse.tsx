import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { CatalogItem, MediaKind } from '@shared/media-hub/types'
import { api } from '../lib/api'
import {
  browseEmptyNote,
  browsePagingDone,
  browseWaitStart,
  browseWaitingForIndex,
  indexMayHaveGrown
} from '../lib/browsePaging'
import { isMediaKind, kindLabel } from '../lib/mediaKind'
import { toPosterItem } from '../lib/posterItem'
import PosterCard from '../components/PosterCard'
import PosterSkeleton from '../components/PosterSkeleton'
import Spinner from '../components/Spinner'
import LoadingNote from '../components/LoadingNote'
import StatusNote from '../components/StatusNote'
import './Browse.css'

// How many skeleton tiles stand in for the first page while it loads — see
// the task brief: enough to read as a real grid rather than a couple of
// stray placeholders, without rendering more DOM than the page needs.
const SKELETON_COUNT = 12

// v1 cap on how many posters this screen will ever hold at once. An
// unbounded infinite grid grows the DOM without bound on a device that may
// have far less RAM than the desktop app assumes — 300 is comfortably more
// than anyone pages through in one sitting, and "load more" still feels
// infinite in practice long before it's reached.
const MAX_ITEMS = 300
const PAGE_SIZE = 60

// How long an empty grid waits on the index before it stops saying it is
// still loading — twice the minute LoadingNote promises.
const INDEX_WAIT_LIMIT_MS = 2 * 60 * 1000

interface BrowseState {
  items: CatalogItem[]
  total: number
  loading: boolean
  error: string | null
  done: boolean
}

const INITIAL_STATE: BrowseState = { items: [], total: 0, loading: false, error: null, done: false }

/** One kind's paged slice of the catalog, fetched via catalog:query (never
 *  catalog:list, which triggers a crawl — see preload/api.ts's own doc on
 *  the difference). Resets whenever `kind` changes, and guards in-flight
 *  requests from a kind change with a generation counter so a slow Movies
 *  page can never land its rows into an Anime page the person has already
 *  switched to. */
function useBrowseCatalog(kind: MediaKind) {
  const [state, setState] = useState<BrowseState>(INITIAL_STATE)
  const offsetRef = useRef(0)
  const generationRef = useRef(0)
  /** When this visit's empty grid began waiting on the index — see browseWaitStart. */
  const waitStartRef = useRef<number | null>(null)
  const [waitedTooLong, setWaitedTooLong] = useState(false)

  useEffect(() => {
    generationRef.current += 1
    offsetRef.current = 0
    waitStartRef.current = null
    // A kind change genuinely does start this hook over — see useAsync's
    // identical reasoning for the same disable.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState(INITIAL_STATE)
  }, [kind])

  const loadMore = useCallback(() => {
    if (state.loading || state.done) return
    const mediaHub = api()
    if (!mediaHub) {
      setState((previous) => ({ ...previous, done: true, error: 'Not connected to a backend.' }))
      return
    }
    const generation = generationRef.current
    setState((previous) => ({ ...previous, loading: true, error: null }))
    mediaHub.catalog
      .query({ kind, sort: 'trending', offset: offsetRef.current, limit: PAGE_SIZE })
      .then((result) => {
        if (generationRef.current !== generation) return
        offsetRef.current += result.items.length
        setState((previous) => {
          const items = previous.items.concat(result.items)
          const done = browsePagingDone(items.length, result.items.length, result.total, MAX_ITEMS)
          return { items, total: result.total, loading: false, error: null, done }
        })
      })
      .catch((error: unknown) => {
        if (generationRef.current !== generation) return
        setState((previous) => ({
          ...previous,
          loading: false,
          error: error instanceof Error ? error.message : 'Could not load titles.'
        }))
      })
  }, [kind, state.loading, state.done])

  // An empty grid that has stopped paging is waiting, not finished: on a
  // fresh install the first crawl has not landed when this screen first
  // asks. The backend announces every index write (the crawl, the deep
  // scan, the household sync), and the grid starts over on the first one,
  // rather than saying "Nothing here yet" until the screen is opened again.
  const waitingForIndex = browseWaitingForIndex({ ...state, count: state.items.length })
  useEffect(() => {
    if (!waitingForIndex) return
    return api()?.library.onChanged((event) => {
      if (!indexMayHaveGrown(event)) return
      generationRef.current += 1
      offsetRef.current = 0
      setState(INITIAL_STATE)
    })
  }, [waitingForIndex])

  // A first crawl takes up to a minute. One that has not filled the grid
  // well after that has most likely found nothing for it, and saying it is
  // still loading for ever would be the dead end the other way round. The
  // wait is measured once per visit, not from the last start-over above,
  // which another kind's index write causes as readily as this one's.
  const { done, loading, error } = state
  const count = state.items.length
  useEffect(() => {
    const since = browseWaitStart(waitStartRef.current, { done, loading, error, count }, Date.now())
    waitStartRef.current = since
    if (since === null) {
      // Titles arriving, a failure or a new kind: no wait left to time.
      setWaitedTooLong(false)
      return
    }
    const timer = window.setTimeout(
      () => setWaitedTooLong(true),
      Math.max(0, since + INDEX_WAIT_LIMIT_MS - Date.now())
    )
    return () => window.clearTimeout(timer)
  }, [done, loading, error, count])

  return { ...state, waitedTooLong, loadMore }
}

/** Fires `onVisible` whenever the returned ref's element is on screen.
 *  IntersectionObserver reports the current state immediately on
 *  `observe()`, so an initially-empty grid's sentinel — which sits right
 *  where the grid will be — fires once on mount for free, loading the
 *  first page without any separate "kick off the fetch" code path. */
function useLoadMoreOnVisible(onVisible: () => void, enabled: boolean) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const node = ref.current
    if (!node || !enabled) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) onVisible()
      },
      { rootMargin: '600px 0px' }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [onVisible, enabled])
  return ref
}

export default function Browse() {
  const params = useParams<{ kind: string }>()
  const kind = isMediaKind(params.kind) ? params.kind : null
  const { items, loading, error, done, waitedTooLong, loadMore } = useBrowseCatalog(kind ?? 'movie')
  // Paused after an error: the observer would otherwise retry the moment it
  // is re-created, over and over. "Try again" clears the error and resumes it.
  const sentinelRef = useLoadMoreOnVisible(loadMore, Boolean(kind) && !done && !error)

  if (!kind) return <StatusNote tone="error">Unknown category.</StatusNote>

  // Distinguished so a fresh page shows full-grid skeletons (nothing to
  // draw yet at all) while paging in more of an already-visible grid only
  // adds a small spinner under it — see the task brief.
  const firstLoad = loading && items.length === 0
  const loadingMore = loading && items.length > 0
  const emptyNote = browseEmptyNote({ done, loading, error, count: items.length }, waitedTooLong)

  return (
    <div className="browse-screen" aria-busy={loading}>
      <h1>{kindLabel(kind)}</h1>
      {error && (
        <div className="browse-error">
          <StatusNote tone="error">{error}</StatusNote>
          <button type="button" onClick={loadMore}>
            Try again
          </button>
        </div>
      )}
      {firstLoad ? (
        <div className="poster-grid">
          {Array.from({ length: SKELETON_COUNT }, (_, index) => (
            <PosterSkeleton key={index} />
          ))}
        </div>
      ) : (
        <div className="poster-grid">
          {items.map((item) => (
            <PosterCard key={item.id} item={toPosterItem(item)} />
          ))}
        </div>
      )}
      {loadingMore && (
        <div className="browse-spinner-row">
          <Spinner />
        </div>
      )}
      {emptyNote === 'nothing' && <StatusNote>Nothing here yet.</StatusNote>}
      {/* An empty grid with nothing failing is still loading, between pages
          as much as during one: the first crawl lands as several index
          writes, and the note must not drop out and wait its delay again
          after each. */}
      <LoadingNote
        loading={loading || emptyNote === 'loading'}
        subject={kind === 'anime' ? 'the anime catalogue' : 'a catalogue'}
      />
      {!done && <div ref={sentinelRef} className="browse-sentinel" aria-hidden="true" />}
      {done && items.length >= MAX_ITEMS && (
        <StatusNote>Showing the first {MAX_ITEMS} titles.</StatusNote>
      )}
    </div>
  )
}
