'use client'

// Planned titles that are not out yet.
//
// A watchlist collects things you cannot watch — a film announced for next
// year sits in Planned looking exactly like one you could start tonight,
// and the only way to tell was to open it. This pulls those to the top and
// says when.
//
// YEAR GRANULARITY, AND THAT IS DELIBERATE. Nothing in this app's catalog
// carries a release DATE — CatalogItem has `year` and `status`, and that
// is what every source fills in. A real countdown would mean a per-title
// lookup against TMDB on a list that can run to hundreds, which is exactly
// the kind of round trip that got the "where to watch" panel deleted. So
// this says "2026" where 2026 is all anybody actually knows, and the
// calendar handles episodes, where real air dates do exist.

import { useMemo } from 'react'
import type { MediaItem } from '@renderer/types'
import { useAppState } from '@renderer/context/AppStateContext'
import { ArtworkImage } from '@renderer/components/media/ArtworkImage'
import { resolveArtwork } from '@renderer/lib/artwork'
import styles from './UpcomingPlanned.module.css'

/** Statuses that mean "announced but not out", as the catalog sources
 *  write them. Matched loosely because three backends supply this field
 *  and none of them agreed on a vocabulary. */
const UNRELEASED_STATUS = /upcoming|announced|in\s*production|post[\s-]*production|planned/i

/**
 * Whether a title has not come out yet.
 *
 * A year later than this one is the reliable signal and the one almost
 * everything carries. Status is a second chance for the cases where the
 * year is missing or is the year it was announced in rather than the year
 * it arrives.
 */
function isUnreleased(media: MediaItem, thisYear: number): boolean {
  if (media.releaseYear !== undefined && media.releaseYear > thisYear) return true
  return typeof media.status === 'string' && UNRELEASED_STATUS.test(media.status)
}

export function UpcomingPlanned({ items }: { items: MediaItem[] }) {
  const { openDetail } = useAppState()
  const thisYear = new Date().getFullYear()

  const upcoming = useMemo(
    () =>
      items
        .filter((media) => isUnreleased(media, thisYear))
        // Soonest first, and anything with no year at all last: an
        // unknown date is not the same as a near one, and sorting it to
        // the front would put the vaguest entries where the most
        // imminent ones belong.
        .sort((a, b) => (a.releaseYear ?? Infinity) - (b.releaseYear ?? Infinity)),
    [items, thisYear]
  )

  // Nothing pending is the ordinary state and does not need a heading
  // saying so.
  if (upcoming.length === 0) return null

  return (
    <section className={styles.band} aria-label="Planned but not yet released">
      <div className={styles.head}>
        <h3>Not out yet</h3>
        <span className={styles.count}>
          {upcoming.length} {upcoming.length === 1 ? 'title' : 'titles'} on your list
        </span>
      </div>
      <ul className={styles.row}>
        {upcoming.map((media) => {
          const artwork = resolveArtwork(media)
          return (
            <li key={media.id}>
              <button
                type="button"
                className={styles.card}
                onClick={() => openDetail(media)}
                title={media.title}
              >
                <ArtworkImage
                  src={artwork.posterUrl ?? artwork.backdropUrl}
                  alt=""
                  fallbackTitle={media.title}
                  artTint={media.artTint}
                  className={styles.cardArt}
                />
                <span className={styles.when}>
                  {media.releaseYear ?? (media.status || 'Announced')}
                </span>
                <span className={styles.name}>{media.title}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
