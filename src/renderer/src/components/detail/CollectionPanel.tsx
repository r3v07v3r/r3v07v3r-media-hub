// The rest of the series this film belongs to.
//
// Sits deliberately beside SimilarPanel and answers the opposite question.
// "Similar" is titles in the same vein and goes out of its way to EXCLUDE the
// sequels — using, as it happens, the very collection this panel renders (see
// catalog.ts's similarTitles, which fetched it only to subtract it). So the
// two together finally cover both halves of "what else": more like this, and
// more of this.
//
// Renders nothing when the film is in no collection, which is true of most
// films. A heading over an empty list is worse than no heading.

import { useEffect, useState } from 'react'

import { ArtworkImage } from '@renderer/components/media/ArtworkImage'
import { WatchStatusBadge } from '@renderer/components/media/WatchStatusBadge'
import { useAppState } from '@renderer/context/AppStateContext'
import { catalogItemToMediaItem } from '@renderer/lib/mediaHub/adapters'
import { getWatchStatus } from '@renderer/lib/mediaHub/watchStatus'
import { resolveArtwork } from '@renderer/lib/artwork'
import type { MediaItem } from '@renderer/types'
import type { TitleCollectionResult } from '@shared/media-hub/types'
import styles from './CollectionPanel.module.css'

export function CollectionPanel({ media }: { media: MediaItem }) {
  const { openDetail, myList, dislikedIds, watchedIds, continueWatching } = useAppState()
  // Carries the title it belongs to, like every other keyed fetch on this
  // page: navigating between films reuses this component, and a series listed
  // under the wrong film is a confident, wrong answer.
  const [result, setResult] = useState<{ key: string; value: TitleCollectionResult } | null>(null)

  const kind = media.mediaKind ?? (media.mediaType === 'series' ? 'series' : 'movie')
  // Movies only, and only ones the catalog identifies by IMDb id — TMDB
  // models collections for films, and its lookup takes that id.
  const supported = kind === 'movie' && /^tt\d+$/.test(media.id)

  useEffect(() => {
    const api = window.api?.mediaHub
    if (!api || !supported) return
    let cancelled = false
    api.catalog
      .collection(media.id)
      .then((found) => {
        if (!cancelled) setResult({ key: media.id, value: found })
      })
      .catch(() => {
        if (!cancelled) setResult(null)
      })
    return () => {
      cancelled = true
    }
  }, [supported, media.id])

  if (result?.key !== media.id) return null
  const { name, parts, currentId } = result.value
  // The film on screen is in the list now (marked), so a series is only
  // worth a panel when there is something else in it.
  if (parts.filter((part) => part.id !== currentId).length === 0) return null

  return (
    <section className={`${styles.panel} glass-panel`} aria-label="Rest of the series">
      <h2 className={styles.heading}>{name || 'Rest of the series'}</h2>
      <p className={styles.order}>In release order</p>
      <ul className={styles.list}>
        {parts.map((part, index) => {
          const current = part.id === currentId
          // Converted with the tracking sets so each card shows whether it is
          // saved or set aside — the same flags every other grid carries.
          // watchedIds too, or every other film in the series reads as
          // unwatched: a movie is never in Continue Watching, so its badge
          // has nothing else to come from.
          const item = catalogItemToMediaItem(part, { trackedIds: myList, dislikedIds, watchedIds })
          const artwork = resolveArtwork(item)
          return (
            <li key={part.id}>
              <button
                type="button"
                className={`${styles.entry} ${current ? styles.current : ''}`}
                aria-current={current ? 'true' : undefined}
                disabled={current}
                // The film currently on screen, as the label for the back
                // button on the one about to open. Without it openDetail
                // derives the label from the current route — which is a
                // detail route, whose id it cannot turn into a title — and
                // every sequel opened from here read "Back to Browse".
                onClick={() => openDetail(item, media.title)}
                aria-label={`Open ${item.title}`}
              >
                <span className={styles.art}>
                  <ArtworkImage
                    src={artwork.posterUrl ?? artwork.backdropUrl}
                    alt=""
                    fallbackTitle={item.title}
                    artTint={item.artTint}
                    sizes="52px"
                    className={styles.artImage}
                  />
                  <WatchStatusBadge status={getWatchStatus(item, continueWatching)} />
                </span>
                <span className={styles.ordinal} aria-hidden="true">
                  {index + 1}
                </span>
                <span className={styles.text}>
                  <span className={styles.title}>{item.title}</span>
                  <span className={styles.year}>
                    {part.year || ''}
                    {current ? (part.year ? ' · ' : '') + 'You are here' : ''}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
