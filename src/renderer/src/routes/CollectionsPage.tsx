// The big collections — a whole universe, films and series together, in order.
//
// Two pages share this file because they are one feature seen from two
// distances: every universe as a tile with how far through it you are, and
// one universe laid out first to last. What belongs to each and the order its
// story runs in come from the bundled list (shared/media-hub/universes.ts,
// which says why nothing online could supply it); everything else on a card —
// artwork, rating, watched state — is the local library's own.
//
// Past the bundled set, any public Trakt list can be added (Browse for more,
// or a pasted link), and any collection, bundled or added, can be taken off
// the page and restored later (main/media-hub/collections.ts keeps both).

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { Icon } from '@renderer/components/icons/Icon'
import { MediaCard } from '@renderer/components/home/RecommendationCarousel/MediaCard'
import { ArtworkImage } from '@renderer/components/media/ArtworkImage'
import grid from '@renderer/components/category/MediaGrid.module.css'
import { useAppState } from '@renderer/context/AppStateContext'
import { resolveArtwork } from '@renderer/lib/artwork'
import { useRestoreBrowsingOrigin } from '@renderer/lib/mediaHub/useRestoreBrowsingOrigin'
import { useCollections, type Collections } from '@renderer/lib/mediaHub/useCollections'
import { useSeasonHistory, useUniverseItems } from '@renderer/lib/mediaHub/useUniverseItems'
import { getWatchStatus, type WatchStatus } from '@renderer/lib/mediaHub/watchStatus'
import type { ContinueWatchingItem, MediaItem } from '@renderer/types'
import type { HistoryEntry } from '@shared/media-hub/types'
import {
  addedCollectionId,
  parseTraktListLink,
  universeEntries,
  universeEntryKey,
  universeEntryReleased,
  universePartLabel,
  universePartProgress,
  type CollectionCandidate,
  type UniverseEntry,
  type UniverseOrder
} from '@shared/media-hub/universes'
import page from './MyStuff.module.css'
import styles from './CollectionsPage.module.css'

/** Today as YYYY-MM-DD in local time — the form release dates are kept in. */
function today(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function formatDay(day: string): string {
  // Noon, so no timezone can push the date across midnight into the day before.
  const date = new Date(`${day}T12:00:00`)
  return Number.isNaN(date.getTime())
    ? day
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Finished: a film watched, or a series with every aired episode seen. */
function isFinished(item: MediaItem | undefined, continueWatching: ContinueWatchingItem[]) {
  if (!item) return false
  const { state } = getWatchStatus(item, continueWatching)
  return state === 'watched' || state === 'completed'
}

/**
 * Where somebody is with one stop. A whole title goes by its own flags; a
 * season stop by the episodes of that run in tracking history, or — before
 * history has been read — finished only when the whole show is.
 */
function entryStatus(
  entry: UniverseEntry,
  item: MediaItem | undefined,
  continueWatching: ContinueWatchingItem[],
  history: readonly HistoryEntry[] | null
): WatchStatus {
  if (!entry.part || !item) {
    return item ? getWatchStatus(item, continueWatching) : { state: 'unwatched' }
  }
  if (item.completed) return { state: 'completed', progressPercentage: 100 }
  const { watched, total } = universePartProgress({ ...entry, part: entry.part }, history ?? [])
  if (watched >= total) return { state: 'completed', progressPercentage: 100 }
  if (watched > 0) {
    return { state: 'in-progress', progressPercentage: Math.round((watched / total) * 100) }
  }
  return item.inMyList ? { state: 'planned' } : { state: 'unwatched' }
}

function entryFinished(
  entry: UniverseEntry,
  item: MediaItem | undefined,
  continueWatching: ContinueWatchingItem[],
  history: readonly HistoryEntry[] | null
): boolean {
  if (!entry.part) return isFinished(item, continueWatching)
  return entryStatus(entry, item, continueWatching, history).state === 'completed'
}

function ProgressBar({ done, total }: { done: number; total: number }) {
  return (
    <span className={styles.bar} aria-hidden="true">
      <span
        className={styles.barFill}
        style={{ width: `${total > 0 ? Math.round((done / total) * 100) : 0}%` }}
      />
    </span>
  )
}

/** A main-process error as a sentence: Electron wraps the message. */
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/**
 * Browse for more: Trakt's public lists, the most liked first, or the ones
 * matching a search — and below them, a box for a list's link.
 */
function CollectionBrowser({ collections }: { collections: Collections }) {
  const api = window.api?.mediaHub?.collections
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CollectionCandidate[] | null>(null)
  const [searchError, setSearchError] = useState('')
  const [adding, setAdding] = useState<number | 'link' | null>(null)
  const [addError, setAddError] = useState('')
  const [link, setLink] = useState('')
  const [linkError, setLinkError] = useState('')

  // Searched once typing pauses; an empty box is the most liked lists, so
  // the panel opens with something in it.
  useEffect(() => {
    if (!api?.search) return
    let cancelled = false
    const timer = setTimeout(
      () => {
        setSearchError('')
        void api
          .search(query.trim())
          .then((answer) => {
            if (!cancelled) setResults(answer.results)
          })
          .catch((error) => {
            if (!cancelled) {
              setResults([])
              setSearchError(errorText(error))
            }
          })
      },
      query.trim() ? 400 : 0
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [api, query])

  const add = async (from: { listId: number } | { link: string }): Promise<void> => {
    if (!api?.add) return
    setAdding('listId' in from ? from.listId : 'link')
    setAddError('')
    setLinkError('')
    try {
      const answer = await api.add(from)
      if (collections.apply(answer)) navigate(`/collections/${answer.addedId}`)
    } catch (error) {
      if ('link' in from) setLinkError(errorText(error))
      else setAddError(errorText(error))
    } finally {
      setAdding(null)
    }
  }

  const submitLink = (event: FormEvent): void => {
    event.preventDefault()
    if (!parseTraktListLink(link)) {
      setLinkError('Paste a trakt.tv list link: trakt.tv/users/…/lists/… or trakt.tv/lists/….')
      return
    }
    void add({ link })
  }

  return (
    <section className={`${styles.browser} glass-panel`} aria-label="Browse for more">
      <label className={styles.searchField}>
        <Icon name="search" size={14} />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search Trakt lists — Stargate, Bond, Pixar…"
          aria-label="Search Trakt lists"
          autoFocus
        />
      </label>
      <p className={styles.browserNote}>
        {query.trim() ? 'Lists on Trakt matching your search.' : 'The most liked lists on Trakt.'}{' '}
        Anyone can make one, so check the count and the author.
      </p>
      {searchError && <p className={styles.error}>{searchError}</p>}
      {addError && <p className={styles.error}>{addError}</p>}
      {results === null && !searchError && <p className={styles.browserNote}>Looking…</p>}
      {results?.length === 0 && !searchError && (
        <p className={styles.browserNote}>No lists found.</p>
      )}
      {results && results.length > 0 && (
        <ul className={styles.results}>
          {results.map((result) => {
            const id = addedCollectionId(result.listId)
            const held = Boolean(collections.find(id)) && !collections.isRemoved(id)
            return (
              <li key={result.listId} className={styles.result}>
                <span className={styles.resultBody}>
                  <span className={styles.resultName}>{result.name}</span>
                  <span className={styles.resultMeta}>
                    {result.itemCount} titles · by {result.owner}
                    {result.likes > 0 ? ` · ${result.likes} likes` : ''}
                  </span>
                  {result.description && (
                    <span className={styles.resultDescription}>{result.description}</span>
                  )}
                </span>
                {held ? (
                  <Link to={`/collections/${id}`} className={styles.pill}>
                    <Icon name="check" size={12} />
                    Added
                  </Link>
                ) : (
                  <button
                    type="button"
                    className={styles.pill}
                    disabled={adding !== null}
                    onClick={() => void add({ listId: result.listId })}
                  >
                    <Icon name="plus" size={12} />
                    {adding === result.listId ? 'Adding…' : 'Add'}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <form className={styles.linkRow} onSubmit={submitLink}>
        <input
          type="text"
          value={link}
          onChange={(event) => {
            setLink(event.target.value)
            setLinkError('')
          }}
          placeholder="Or paste a Trakt list link"
          aria-label="Trakt list link"
          className={styles.linkInput}
        />
        <button type="submit" className={styles.pill} disabled={!link.trim() || adding !== null}>
          {adding === 'link' ? 'Adding…' : 'Add by link'}
        </button>
      </form>
      {linkError && <p className={styles.error}>{linkError}</p>}
    </section>
  )
}

/** Every universe, as a tile. */
export default function CollectionsPage() {
  useRestoreBrowsingOrigin(true)
  const { continueWatching } = useAppState()
  const collections = useCollections()
  const items = useUniverseItems(collections.shown)
  const history = useSeasonHistory(collections.shown)
  const [browsing, setBrowsing] = useState(false)

  const restore = (id: string): void => {
    void window.api?.mediaHub?.collections
      ?.restore(id)
      .then(collections.apply)
      .catch(() => {
        // Nothing changed; the row stays to be tried again.
      })
  }

  return (
    <div className={page.wrap}>
      <div className={styles.headingRow}>
        <h1 className={page.heading}>Collections</h1>
        {collections.traktReady && (
          <button
            type="button"
            className={styles.pill}
            aria-expanded={browsing}
            onClick={() => setBrowsing((open) => !open)}
          >
            <Icon name={browsing ? 'x' : 'plus'} size={12} />
            {browsing ? 'Close' : 'Browse for more'}
          </button>
        )}
      </div>
      <p className={styles.description}>
        Whole universes in order — every film and series, with how far through each you are.
      </p>
      {collections.loaded && !collections.traktReady && window.api?.mediaHub?.collections && (
        <p className={styles.orderNote}>
          To add more collections from Trakt, save a Trakt app key under{' '}
          <Link to="/settings" className={styles.inlineLink}>
            Settings → Accounts → Tracking
          </Link>
          .
        </p>
      )}
      {browsing && <CollectionBrowser collections={collections} />}
      <ul className={styles.tiles}>
        {collections.shown.map((universe) => {
          const released = universeEntries(universe, 'release')
          const done = released.filter((entry) =>
            entryFinished(entry, items.get(entry.id), continueWatching, history)
          ).length
          // The first three ever released: the faces of the thing, and the
          // same three whatever has been watched since. Three different
          // titles, so a show's first two seasons are not two of them.
          const faces = [...new Set(released.map((entry) => entry.id))]
            .slice(0, 3)
            .map((id) => items.get(id))
            .filter((item): item is MediaItem => Boolean(item))
          return (
            <li key={universe.id}>
              <Link
                to={`/collections/${universe.id}`}
                className={`${styles.tile} glass-panel animated-edge`}
              >
                <span className={styles.faces} aria-hidden="true">
                  {faces.map((item) => (
                    <ArtworkImage
                      key={item.id}
                      src={resolveArtwork(item).posterUrl ?? resolveArtwork(item).backdropUrl}
                      alt=""
                      fallbackTitle={item.title}
                      artTint={item.artTint}
                      sizes="120px"
                      className={styles.face}
                    />
                  ))}
                </span>
                <span className={styles.tileBody}>
                  <span className={styles.tileName}>{universe.name}</span>
                  <span className={styles.tileBlurb}>{universe.blurb}</span>
                  <span className={styles.tileCount}>
                    {done > 0
                      ? `${done} of ${released.length} watched`
                      : `${released.length} ${released.some((entry) => entry.part) ? 'stops' : 'titles'}`}
                  </span>
                  <ProgressBar done={done} total={released.length} />
                </span>
              </Link>
            </li>
          )
        })}
      </ul>

      {collections.removed.length > 0 && (
        <details className={styles.removed}>
          <summary>Removed collections ({collections.removed.length})</summary>
          <ul>
            {collections.removed.map((collection) => (
              <li key={collection.id} className={styles.removedRow}>
                <span>
                  {collection.name}
                  <span className={styles.resultMeta}>
                    {' '}
                    · {collection.entries.length} titles
                    {collection.source ? ` · Trakt list by ${collection.source.owner}` : ''}
                  </span>
                </span>
                <button
                  type="button"
                  className={styles.pill}
                  onClick={() => restore(collection.id)}
                >
                  <Icon name="refresh" size={12} />
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

const ORDER_LABELS: Record<UniverseOrder, string> = {
  story: 'Story order',
  release: 'Release order'
}

/** One universe, first to last. */
export function CollectionPage() {
  useRestoreBrowsingOrigin(true)
  const { id } = useParams<{ id: string }>()
  const collections = useCollections()
  const universe = collections.find(id ?? '')
  const navigate = useNavigate()
  const { continueWatching, openDetail } = useAppState()
  // In the address rather than in state: a title opened from here comes back
  // to this route, and should come back to the order it was opened from.
  const [search, setSearch] = useSearchParams()

  const universes = useMemo(() => (universe ? [universe] : []), [universe])
  const items = useUniverseItems(universes)
  const history = useSeasonHistory(universes)

  // An added list is only known once main has answered.
  if (!universe) return collections.loaded ? <Navigate to="/collections" replace /> : null
  const removed = collections.isRemoved(universe.id)
  const orderLabels: Record<UniverseOrder, string> = universe.source
    ? { ...ORDER_LABELS, story: 'List order' }
    : ORDER_LABELS

  const toggleRemoved = (): void => {
    const api = window.api?.mediaHub?.collections
    if (!api) return
    void (removed ? api.restore(universe.id) : api.remove(universe.id))
      .then((state) => {
        if (collections.apply(state) && !removed) navigate('/collections')
      })
      .catch(() => {
        // Nothing changed; the button stays to be pressed again.
      })
  }

  const order: UniverseOrder =
    universe.hasStoryOrder && search.get('order') !== 'release' ? 'story' : 'release'
  const entries = universeEntries(universe, order)
  const now = today()

  const finished = (entry: UniverseEntry): boolean =>
    entryFinished(entry, items.get(entry.id), continueWatching, history)
  const done = entries.filter(finished).length
  // The first title that is out and not finished — a series part-way
  // through is exactly where to carry on, so it counts as next.
  const next: UniverseEntry | undefined = entries.find(
    (entry) => universeEntryReleased(entry, now) && !finished(entry)
  )
  const nextItem = next ? items.get(next.id) : undefined

  return (
    <div className={page.wrap}>
      <Link to="/collections" className={styles.crumb}>
        <Icon name="chevron-left" size={13} />
        Collections
      </Link>
      <h1 className={page.heading}>{universe.name}</h1>
      <p className={styles.description}>
        {universe.blurb}
        {universe.source && (
          <span className={styles.sourceNote}>
            {' '}
            A Trakt list by {universe.source.owner}, read again each day.
          </span>
        )}
      </p>

      <div className={styles.summary}>
        <span className={styles.summaryCount}>
          {done} of {entries.length} watched
        </span>
        <ProgressBar done={done} total={entries.length} />
        {nextItem && (
          <button
            type="button"
            className={styles.next}
            onClick={() => openDetail(nextItem, universe.name, next?.part?.season)}
          >
            <Icon name="play" size={12} />
            {done > 0 ? 'Next' : 'Start with'}: {nextItem.title}
            {next?.part && `, ${universePartLabel(next.part)}`}
          </button>
        )}
        {window.api?.mediaHub?.collections && (
          <button type="button" className={styles.quiet} onClick={toggleRemoved}>
            <Icon name={removed ? 'refresh' : 'trash'} size={12} />
            {removed ? 'Restore to Collections' : 'Remove from Collections'}
          </button>
        )}
      </div>

      {universe.hasStoryOrder && (
        <div className={page.tabs} role="tablist" aria-label="Order">
          {(['story', 'release'] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              role="tab"
              aria-selected={order === choice}
              className={`${page.tab} ${order === choice ? page.tabActive : ''}`}
              onClick={() =>
                setSearch(choice === 'release' ? { order: 'release' } : {}, { replace: true })
              }
            >
              {orderLabels[choice]}
            </button>
          ))}
        </div>
      )}
      {!universe.hasStoryOrder && <p className={styles.orderNote}>In release order</p>}

      <ol className={grid.grid}>
        {entries.map((entry, index) => {
          const item = items.get(entry.id)
          if (!item) return null
          const out = universeEntryReleased(entry, now)
          const when = out
            ? entry.year
            : entry.released
              ? `Coming ${formatDay(entry.released)}`
              : `Coming ${entry.year}`
          return (
            <MediaCard
              key={universeEntryKey(entry)}
              media={item}
              // The place in the order, where a recommendation says why it
              // was picked: it is the reason this card is where it is.
              reason={`${index + 1} · ${when}`}
              showKind
              originLabel={universe.name}
              part={
                entry.part && {
                  label: universePartLabel(entry.part),
                  season: entry.part.season,
                  episode: universePartProgress({ ...entry, part: entry.part }, history ?? []).next,
                  status: entryStatus(entry, item, continueWatching, history)
                }
              }
            />
          )
        })}
      </ol>

      {order === 'story' && !universe.source && (
        <p className={page.footnote}>
          Story order places a short series where it begins. A longer one is a stop per season, and
          where a film lands part-way through a season, the season is split at that film.
        </p>
      )}
    </div>
  )
}
