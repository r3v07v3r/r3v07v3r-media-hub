'use client'

// The list, on the way to the sofa.
//
// Plan-to-watch is where somebody has already done the deciding — often
// months ago, often in Trakt or Simkl rather than here. Leaving it two
// clicks away in My Stuff meant the thing they had explicitly said they
// wanted to watch was harder to reach than a row of guesses.
//
// Deliberately not another carousel. RecommendationCarousel owns a good
// deal of machinery for its arrows and paging, and copying it for a
// second row would be two implementations of the same behaviour to keep
// in step. This is a plain scroller with the same cards in it: the same
// artwork, ratings and right-click menu, and the same source tag saying
// which service the title came off.

import { Link } from 'react-router-dom'
import { useAppState } from '@renderer/context/AppStateContext'
import { useCatalogByIds } from '@renderer/lib/mediaHub/useCatalogByIds'
import { Icon } from '@renderer/components/icons/Icon'
import { MediaCard } from './RecommendationCarousel/MediaCard'
import styles from './RecommendationCarousel/RecommendationCarousel.module.css'

/** Enough to browse without turning Home into the whole list. The rest is
 *  one click away, and the link says so rather than the row trailing off. */
const ROW_LIMIT = 20

export function PlannedRow() {
  const { myList, adaptCatalogItems } = useAppState()
  // From the INDEX by id (stage 4): the loaded catalog is a bounded
  // candidate pool now, and a planned title has every right to live
  // outside it — a row that silently dropped those would look like the
  // sync losing titles. Same source My Stuff uses, same
  // adapter — so a title pulled in from a service shows the artwork
  // and ratings this app resolved for it, not the thinner remote record.
  const { items: planned } = useCatalogByIds(myList, adaptCatalogItems)

  // Nothing planned is not a state worth a row. An empty shelf with an
  // explanation is still a shelf somebody has to scroll past every time
  // they open the app, and My Stuff already says how the list gets filled.
  if (planned.length === 0) return null

  return (
    <section className={styles.section} aria-label="Planned to watch">
      <h2 className={styles.heading}>
        <Icon name="tracked" />
        Planned
        <Link to="/my-stuff" className={styles.seeAll}>
          {planned.length > ROW_LIMIT ? `All ${planned.length}` : 'See all'}
        </Link>
      </h2>
      <div className={styles.scrollerWrap}>
        <ul className={`${styles.scroller} thin-scroll`} data-rail-id="planned">
          {planned.slice(0, ROW_LIMIT).map((media) => (
            <MediaCard key={media.id} media={media} />
          ))}
        </ul>
      </div>
    </section>
  )
}
