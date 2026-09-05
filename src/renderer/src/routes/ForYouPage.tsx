// The whole ranking, shelved by reason.
//
// Home shows one row of suggestions and cannot scroll (see
// HomeDashboard.module.css: the composition is a fixed grid). Everything
// the ranking had to say beyond that row — the rest of the served list,
// and the same list shelved by the evidence behind it ("Because you
// watched Dune", "With Zendaya", "More Sci-Fi") — is here, the way a
// streaming service's front page is a stack of shelves rather than one
// row. The shelves come from main (see groupRecommendationRails in
// catalog-logic.ts) so the page and the row are the same ranking.

import { useAppState } from '@renderer/context/AppStateContext'
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

  return (
    <div className={`${page.wrap} ${styles.page}`}>
      <h1 className={page.heading}>For You</h1>
      <p className={styles.description}>
        Everything this app would suggest, shelved by why. The row on Home is the top of this list.
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
          {picks.length > 0 && (
            <section className={`${rail.section} ${styles.rail}`} aria-label="Recommended for you">
              <h2 className={rail.heading}>
                <Icon name="sparkle" />
                Recommended For You
              </h2>
              <div className={rail.scrollerWrap}>
                <ul className={`${rail.scroller} thin-scroll`} data-rail-id="for-you:all">
                  {picks.map((rec) => (
                    <MediaCard
                      key={rec.media.id}
                      media={rec.media}
                      reason={rec.reasons[0]}
                      showKind
                    />
                  ))}
                </ul>
              </div>
            </section>
          )}
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
              fresh install has the row before it has the shelves. Say so
              rather than leave a page that is one row long unexplained. */}
          {recommendationRails.length === 0 && picks.length > 0 && (
            <p className={styles.note}>
              Shelves by reason appear once this app has learned what you keep coming back to —
              usually within a few minutes of watching.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
