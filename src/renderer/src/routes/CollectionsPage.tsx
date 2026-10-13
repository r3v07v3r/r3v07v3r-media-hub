// The big collections — a whole universe, films and series together, in order.
//
// Two pages share this file because they are one feature seen from two
// distances: every universe as a tile with how far through it you are, and
// one universe laid out first to last. What belongs to each and the order its
// story runs in come from the bundled list (shared/media-hub/universes.ts,
// which says why nothing online could supply it); everything else on a card —
// artwork, rating, watched state — is the local library's own.

import { useMemo } from 'react'
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom'

import { Icon } from '@renderer/components/icons/Icon'
import { MediaCard } from '@renderer/components/home/RecommendationCarousel/MediaCard'
import { ArtworkImage } from '@renderer/components/media/ArtworkImage'
import grid from '@renderer/components/category/MediaGrid.module.css'
import { useAppState } from '@renderer/context/AppStateContext'
import { resolveArtwork } from '@renderer/lib/artwork'
import { useRestoreBrowsingOrigin } from '@renderer/lib/mediaHub/useRestoreBrowsingOrigin'
import { useUniverseItems } from '@renderer/lib/mediaHub/useUniverseItems'
import { getWatchStatus } from '@renderer/lib/mediaHub/watchStatus'
import type { ContinueWatchingItem, MediaItem } from '@renderer/types'
import {
  UNIVERSES,
  findUniverse,
  universeEntries,
  universeEntryReleased,
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

/** Every universe, as a tile. */
export default function CollectionsPage() {
  useRestoreBrowsingOrigin(true)
  const { continueWatching } = useAppState()
  const items = useUniverseItems(UNIVERSES)

  return (
    <div className={page.wrap}>
      <h1 className={page.heading}>Collections</h1>
      <p className={styles.description}>
        Whole universes in order — every film and series, with how far through each you are.
      </p>
      <ul className={styles.tiles}>
        {UNIVERSES.map((universe) => {
          const released = universeEntries(universe, 'release')
          const done = released.filter((entry) =>
            isFinished(items.get(entry.id), continueWatching)
          ).length
          // The first three ever released: the faces of the thing, and the
          // same three whatever has been watched since.
          const faces = released
            .slice(0, 3)
            .map((entry) => items.get(entry.id))
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
                      : `${released.length} titles`}
                  </span>
                  <ProgressBar done={done} total={released.length} />
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
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
  const universe = findUniverse(id ?? '')
  const { continueWatching, openDetail } = useAppState()
  // In the address rather than in state: a title opened from here comes back
  // to this route, and should come back to the order it was opened from.
  const [search, setSearch] = useSearchParams()

  const universes = useMemo(() => (universe ? [universe] : []), [universe])
  const items = useUniverseItems(universes)

  if (!universe) return <Navigate to="/collections" replace />

  const order: UniverseOrder =
    universe.hasStoryOrder && search.get('order') !== 'release' ? 'story' : 'release'
  const entries = universeEntries(universe, order)
  const now = today()

  const done = entries.filter((entry) => isFinished(items.get(entry.id), continueWatching)).length
  // The first title that is out and not finished — a series part-way
  // through is exactly where to carry on, so it counts as next.
  const next: UniverseEntry | undefined = entries.find(
    (entry) =>
      universeEntryReleased(entry, now) && !isFinished(items.get(entry.id), continueWatching)
  )
  const nextItem = next ? items.get(next.id) : undefined

  return (
    <div className={page.wrap}>
      <Link to="/collections" className={styles.crumb}>
        <Icon name="chevron-left" size={13} />
        Collections
      </Link>
      <h1 className={page.heading}>{universe.name}</h1>
      <p className={styles.description}>{universe.blurb}</p>

      <div className={styles.summary}>
        <span className={styles.summaryCount}>
          {done} of {entries.length} watched
        </span>
        <ProgressBar done={done} total={entries.length} />
        {nextItem && (
          <button
            type="button"
            className={styles.next}
            onClick={() => openDetail(nextItem, universe.name)}
          >
            <Icon name="play" size={12} />
            {done > 0 ? 'Next' : 'Start with'}: {nextItem.title}
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
              {ORDER_LABELS[choice]}
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
              key={entry.id}
              media={item}
              // The place in the order, where a recommendation says why it
              // was picked: it is the reason this card is where it is.
              reason={`${index + 1} · ${when}`}
              showKind
            />
          )
        })}
      </ol>

      {order === 'story' && (
        <p className={page.footnote}>
          Story order places a series where it begins, so a show that runs alongside several films
          is one stop rather than several.
        </p>
      )}
    </div>
  )
}
