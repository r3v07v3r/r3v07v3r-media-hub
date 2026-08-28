'use client'

import { useEffect, useRef, useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import { MediaCard } from './MediaCard'
import styles from './RecommendationCarousel.module.css'

export function RecommendationCarousel() {
  const { recommendations, homeFeedLoading, homeFeedError, refreshHomeFeed } = useAppState()
  // home:personalized's recommendations once it resolves; before that,
  // the picks this app last really showed (see lib/mediaHub/
  // startupSnapshot.ts). The mock AI_PICKS pool this used to fall back to
  // now only reaches the bridgeless preview build, and only through that
  // same fallback — see hooks.ts.
  const picks = recommendations
  const [skeletonDone, setSkeletonDone] = useState(false)
  // `loading` is derived, not stored: the fake reveal timer below is one
  // input, whether anything is actually in hand is the other.
  //
  // It is deliberately gated on having NOTHING to show. Running a 900ms
  // skeleton over remembered picks would be the same "wait, then swap the
  // screen out from under you" that this whole change exists to remove —
  // real content that is already here should just be here.
  const loading = picks.length === 0 && (homeFeedLoading || !skeletonDone)
  const [canScrollBack, setCanScrollBack] = useState(false)
  // Whether there's still unrevealed content to the right. On a wide
  // enough window (spec: "scale to show more items... 20+ to cover
  // ultra-wide screens") every pick can fit without scrolling at all, so
  // the "show more" arrow needs to disappear instead of floating over a
  // row that has nothing left to reveal.
  const [canScrollForward, setCanScrollForward] = useState(false)
  const scrollerRef = useRef<HTMLUListElement>(null)

  // Staggered skeleton -> reveal on first mount, standing in for a real
  // "generating recommendations" round trip (spec section 15 / 18) — moot
  // whenever there is anything to show, remembered or live (see the
  // `loading` derivation above).
  useEffect(() => {
    const t = setTimeout(() => setSkeletonDone(true), 900)
    return () => clearTimeout(t)
  }, [])

  // Tracks scroll position against content width, so the "<"/">" arrows
  // (see .arrowLeft / .arrow) only appear when there's actually
  // something to scroll to in that direction — including neither arrow
  // at all once the row is wide enough to show every card at once.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    function update() {
      if (!el) return
      setCanScrollBack(el.scrollLeft > 8)
      setCanScrollForward(el.scrollLeft + el.clientWidth < el.scrollWidth - 8)
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      el.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
    // `picks`, not just `loading`. This used to lean on loading flipping
    // false as the only way the row's contents could change, which stopped
    // being true once a remembered row could be replaced by a live one
    // without ever passing through a loading state (see the derivation
    // above). A short remembered row swapped for a longer live one then
    // left the forward arrow hidden over a scroller that had plenty left
    // to show, until some unrelated resize or scroll re-measured it.
  }, [loading, picks])

  // The arrows used to scroll a flat 380px regardless of how many cards
  // that actually covers — on a row this wide that's a fraction of one
  // card, so repeated clicks crept along almost one frame at a time
  // instead of paging. Measures the real on-screen card width + gap (not
  // a hardcoded constant, so this stays correct across the .card
  // breakpoint in RecommendationCarousel.module.css) and scrolls by
  // (visible cards - 1) of those — a full page, deliberately one card
  // short so the last card still on screen becomes the first card of the
  // next page instead of a card being skipped between clicks.
  function scrollByPage(direction: 1 | -1) {
    const el = scrollerRef.current
    if (!el) return
    const cards = Array.from(el.querySelectorAll<HTMLElement>(':scope > li'))
    if (cards.length < 2) {
      el.scrollBy({ left: direction * el.clientWidth, behavior: 'smooth' })
      return
    }
    const cardStep = cards[1].offsetLeft - cards[0].offsetLeft
    const visibleCount = Math.max(1, Math.floor(el.clientWidth / cardStep))
    const amount = Math.max(cardStep, (visibleCount - 1) * cardStep)
    el.scrollBy({ left: direction * amount, behavior: 'smooth' })
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLUListElement>) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const cards = Array.from(
      scrollerRef.current?.querySelectorAll<HTMLElement>('[role="button"]') ?? []
    )
    const idx = cards.findIndex((c) => c === document.activeElement)
    if (idx === -1) return
    e.preventDefault()
    const nextIdx =
      e.key === 'ArrowRight' ? Math.min(idx + 1, cards.length - 1) : Math.max(idx - 1, 0)
    cards[nextIdx]?.focus()
    cards[nextIdx]?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
  }

  return (
    <section className={styles.section} aria-label="Recommended for you">
      <h2 className={styles.heading}>
        <Icon name="sparkle" />
        Recommended For You
      </h2>
      {/* A populated row can be a failure too, and used to say nothing
          about it: a cold start whose home:personalized threw still has
          the remembered picks to show, so the empty-state branch below is
          skipped and this row presented last session's picks as current
          with no way to ask again. Same situation the category pages
          already banner over their carried rows — see CategoryPage's
          .offlineBanner. The copy covers both routes here (nothing
          fetched this run, or a mid-session refresh that failed) because
          both make the same claim: what you are looking at may have
          moved on. */}
      {homeFeedError && picks.length > 0 && (
        <p className={styles.staleNotice} role="status">
          <Icon name="wifi-off" size={13} />
          Couldn&apos;t reach the media hub backend — these picks may be out of date.
          <button type="button" onClick={refreshHomeFeed} className={styles.emptyRetry}>
            <Icon name="refresh" size={13} />
            Retry
          </button>
        </p>
      )}
      {!loading && picks.length === 0 ? (
        // An empty row has two causes and they are not interchangeable.
        //
        // main ranks recommendations over the WHOLE catalog when it has
        // no watch history to personalise from, and throws outright when
        // every catalog source is down (tracking.ts's homePersonalized) —
        // so in practice an empty row means the fetch failed. Saying
        // "watch a few titles" to someone whose backend is unreachable
        // blames them for a network problem and hides the retry that
        // would actually fix it. The "not enough history" copy is kept
        // for the case it honestly describes.
        <p className={styles.emptyState}>
          {homeFeedError ? (
            <>
              <Icon name="wifi-off" size={15} />
              Couldn&apos;t reach the media hub backend.
              <button type="button" onClick={refreshHomeFeed} className={styles.emptyRetry}>
                <Icon name="refresh" size={13} />
                Retry
              </button>
            </>
          ) : (
            'Watch a few titles and recommendations will show up here.'
          )}
        </p>
      ) : (
        <div className={styles.scrollerWrap}>
          <ul
            className={`${styles.scroller} thin-scroll`}
            ref={scrollerRef}
            data-rail-id="ai-picks"
            onKeyDown={handleKeyDown}
          >
            {loading
              ? Array.from({ length: 6 }).map((_, i) => (
                  <li key={i} className={styles.skeletonCard} aria-hidden="true" />
                ))
              : picks.map((rec) => (
                  <MediaCard key={rec.media.id} media={rec.media} reason={rec.reasons[0]} />
                ))}
          </ul>
          {!loading && canScrollBack && (
            <button
              type="button"
              className={`${styles.arrow} ${styles.arrowLeft}`}
              aria-label="Show previous picks"
              onClick={() => scrollByPage(-1)}
            >
              <Icon name="chevron-left" />
            </button>
          )}
          {!loading && canScrollForward && (
            <button
              type="button"
              className={styles.arrow}
              aria-label="Show more picks"
              onClick={() => scrollByPage(1)}
            >
              <Icon name="chevron" />
            </button>
          )}
        </div>
      )}
    </section>
  )
}
