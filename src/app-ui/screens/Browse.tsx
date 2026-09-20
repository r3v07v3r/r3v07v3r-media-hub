import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { CatalogItem, MediaKind } from '@shared/media-hub/types'
import { api } from '../lib/api'
import { isMediaKind, kindLabel } from '../lib/mediaKind'
import { toPosterItem } from '../lib/posterItem'
import PosterCard from '../components/PosterCard'
import StatusNote from '../components/StatusNote'
import './Browse.css'

// v1 cap on how many posters this screen will ever hold at once. An
// unbounded infinite grid grows the DOM without bound on a device that may
// have far less RAM than the desktop app assumes — 300 is comfortably more
// than anyone pages through in one sitting, and "load more" still feels
// infinite in practice long before it's reached.
const MAX_ITEMS = 300
const PAGE_SIZE = 60

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

  useEffect(() => {
    generationRef.current += 1
    offsetRef.current = 0
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
          const done =
            result.items.length === 0 || items.length >= result.total || items.length >= MAX_ITEMS
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

  return { ...state, loadMore }
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
  const { items, loading, error, done, loadMore } = useBrowseCatalog(kind ?? 'movie')
  const sentinelRef = useLoadMoreOnVisible(loadMore, Boolean(kind) && !done)

  if (!kind) return <StatusNote tone="error">Unknown category.</StatusNote>

  return (
    <div className="browse-screen">
      <h1>{kindLabel(kind)}</h1>
      {error && <StatusNote tone="error">{error}</StatusNote>}
      <div className="poster-grid">
        {items.map((item) => (
          <PosterCard key={item.id} item={toPosterItem(item)} />
        ))}
      </div>
      {loading && <StatusNote>Loading…</StatusNote>}
      {!loading && !items.length && !error && <StatusNote>No titles found.</StatusNote>}
      {!done && <div ref={sentinelRef} className="browse-sentinel" aria-hidden="true" />}
      {done && items.length >= MAX_ITEMS && (
        <StatusNote>Showing the first {MAX_ITEMS} titles.</StatusNote>
      )}
    </div>
  )
}
