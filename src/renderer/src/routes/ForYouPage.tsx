// The whole ranking, shelved by reason.
//
// Home shows one row of suggestions and cannot scroll (see
// HomeDashboard.module.css: the composition is a fixed grid). Everything
// the ranking had to say beyond that row, the list shelved by the
// evidence behind it ("Because you watched Dune", "With Zendaya", "More
// Sci-Fi"), is here, the way a
// streaming service's front page is a stack of shelves rather than one
// row. The shelves come from main (see groupRecommendationRails in
// catalog-logic.ts) so the page and the row are the same ranking. The
// unfiltered list itself is not repeated here: it is Home's row.

import { useAppState } from '@renderer/context/AppStateContext'
import { RequiresSetup } from '@renderer/components/layout/RequiresSetup'
import { useServiceReadiness } from '@renderer/hooks/useServiceReadiness'
import { useRestoreBrowsingOrigin } from '@renderer/lib/mediaHub/useRestoreBrowsingOrigin'
import { Icon } from '@renderer/components/icons/Icon'
import { MediaCard } from '@renderer/components/home/RecommendationCarousel/MediaCard'
import rail from '@renderer/components/home/RecommendationCarousel/RecommendationCarousel.module.css'
import page from './MyStuff.module.css'
import styles from './ForYouPage.module.css'

export default function ForYouPage() {
  // A common origin for detail pages, like Home and the category pages.
  useRestoreBrowsingOrigin(true)
  const { recommendations, recommendationRails, homeFeedLoading, homeFeedError, refreshHomeFeed } =
    useAppState()
  const picks = recommendations
  const empty = picks.length === 0 && recommendationRails.length === 0
  const ready = useServiceReadiness()

  return (
    <div className={`${page.wrap} ${styles.page}`}>
      <h1 className={page.heading}>For You</h1>
      <p className={styles.description}>
        Everything this app would suggest, shelved by why. The top picks, in order, are the row on
        Home.
      </p>

      {empty && !homeFeedLoading ? (
        <p className={rail.emptyState}>
          {homeFeedError ? (
            <>
              <Icon name="wifi-off" size={15} />
              Couldn&apos;t reach the media hub backend.
              <button type="button" onClick={refreshHomeFeed} className={rail.emptyRetry}>
                <Icon name="refresh" size={13} />
                Retry
              </button>
            </>
          ) : (
            'Watch a few titles and suggestions will show up here.'
          )}
        </p>
      ) : (
        <div className={styles.rails}>
          {recommendationRails.map((shelf) => (
            <section
              key={shelf.id}
              className={`${rail.section} ${styles.rail}`}
              aria-label={shelf.title}
            >
              <h2 className={rail.heading}>
                <Icon name="sparkle" />
                {shelf.title}
              </h2>
              <div className={rail.scrollerWrap}>
                <ul className={`${rail.scroller} thin-scroll`} data-rail-id={`for-you:${shelf.id}`}>
                  {shelf.items.map((media) => (
                    <MediaCard key={media.id} media={media} showKind />
                  ))}
                </ul>
              </div>
            </section>
          ))}
          {/* Reasons come from the background rebuild's credits pass, so a
              fresh install has Home's row before it has the shelves. Say so
              rather than leave an empty page unexplained. */}
          {recommendationRails.length === 0 && picks.length > 0 && ready.loaded && !ready.tmdb && (
            <>
              <RequiresSetup services={['tmdb']} what="Shelves built from cast and crew" plural />
              <p className={styles.note}>In the meantime, the top picks are on Home.</p>
            </>
          )}
          {recommendationRails.length === 0 && picks.length > 0 && ready.loaded && ready.tmdb && (
            <p className={styles.note}>
              Shelves by reason appear once this app has learned what you keep coming back to,
              usually within a few minutes of watching. Until then, the top picks are on Home.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
