import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { CatalogItem, MediaKind } from '@shared/media-hub/types'
import { api } from '../lib/api'
import { kindLabel } from '../lib/mediaKind'
import { toPosterItem } from '../lib/posterItem'
import PosterCard from '../components/PosterCard'
import Spinner from '../components/Spinner'
import LoadingNote from '../components/LoadingNote'
import StatusNote from '../components/StatusNote'
import './Search.css'

const KINDS: MediaKind[] = ['movie', 'series', 'anime']
const MIN_QUERY_LENGTH = 2
const DEBOUNCE_MS = 400

export default function Search() {
  const [kind, setKind] = useState<MediaKind>('movie')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CatalogItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)
  // Bumped on every search kicked off; a response is only applied if it's
  // still the most recent one by the time it lands — discards a stale
  // answer from a query the person has already typed past.
  const requestRef = useRef(0)

  const runSearch = useCallback((rawQuery: string, searchKind: MediaKind) => {
    const trimmed = rawQuery.trim()
    if (trimmed.length < MIN_QUERY_LENGTH) {
      requestRef.current += 1
      setResults([])
      setSearched(false)
      setError(null)
      setLoading(false)
      return
    }
    const requestId = ++requestRef.current
    const mediaHub = api()
    if (!mediaHub) {
      setError('Not connected to a backend.')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    mediaHub.catalog
      .search(searchKind, trimmed)
      .then((items) => {
        if (requestRef.current !== requestId) return
        setResults(items)
        setSearched(true)
        setLoading(false)
      })
      .catch((error: unknown) => {
        if (requestRef.current !== requestId) return
        setError(error instanceof Error ? error.message : 'Search failed.')
        setLoading(false)
      })
  }, [])

  // Debounced re-search: fires 400ms after the query or the active tab
  // settles. onSubmit below runs the same search immediately for anyone
  // who presses Enter/Search rather than waiting.
  useEffect(() => {
    const timer = setTimeout(() => runSearch(query, kind), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, kind, runSearch])

  const onSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault()
      runSearch(query, kind)
    },
    [query, kind, runSearch]
  )

  return (
    <div className="search-screen" aria-busy={loading}>
      <h1>Search</h1>
      <form className="search-form" onSubmit={onSubmit}>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search titles"
          aria-label="Search titles"
        />
        <button type="submit">Search</button>
      </form>
      <div className="search-tabs" role="tablist" aria-label="Search category">
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={kind === k}
            className={'search-tabs__item' + (kind === k ? ' is-active' : '')}
            onClick={() => setKind(k)}
          >
            {kindLabel(k)}
          </button>
        ))}
      </div>
      {loading && (
        <div className="search-status">
          <Spinner size="sm" />
          <StatusNote>Searching…</StatusNote>
        </div>
      )}
      <LoadingNote loading={loading} />
      {error && <StatusNote tone="error">{error}</StatusNote>}
      {!loading && !error && searched && !results.length && (
        <StatusNote>{`No results for "${query.trim()}".`}</StatusNote>
      )}
      <div className="poster-grid">
        {results.map((item) => (
          <PosterCard key={item.id} item={toPosterItem(item)} />
        ))}
      </div>
    </div>
  )
}
