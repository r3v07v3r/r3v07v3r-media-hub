'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAppState } from '@renderer/context/AppStateContext'
import {
  activeHomeRailTab,
  setActiveHomeRailTab,
  type HomeRailTab
} from '@renderer/lib/mediaHub/homeRailTab'
import type { MediaItem } from '@renderer/types'
import { Icon } from '@renderer/components/icons/Icon'
import { MediaCard } from './MediaCard'
import styles from './RecommendationCarousel.module.css'

/** Where the row's own "See all" goes, per tab. */
const SEE_ALL = {
  picks: { to: '/for-you', label: 'See all' },
  planned: { to: '/my-stuff', label: 'See all' }
} as const

/** Enough to browse without turning Home into the whole list. The rest is
 *  one click away, and the link says so rather than the row trailing off. */
const PLANNED_ROW_LIMIT = 20

/** Stable identity for "no Planned rail" — a `?? []` default would build a
 *  fresh array every render and churn the memo/effect deps below. */
const NO_PLANNED: MediaItem[] = []

/**
 * `planned` is Home's second rail. The category pages render this same
 * component for their own picks row and pass none — they have no
 * plan-to-watch shelf of their own, so they get the single-heading form
 * this always had, and they leave the remembered tab (homeRailTab.ts)
 * alone rather than resetting Home's to Recommended in passing.
 */
export function RecommendationCarousel({ planned }: { planned?: MediaItem[] }) {
  const { recommendations, homeFeedLoading, homeFeedError, refreshHomeFeed } = useAppState()
  // home:personalized's recommendations once it resolves; before that,
  // the picks this app last really showed (see lib/mediaHub/
  // startupSnapshot.ts). There is no third tier: the mock AI_PICKS pool
  // this used to fall back to is deleted, preview build included.
  const picks = recommendations
  // `planned` is the other half of this cell, fetched by HomeDashboard
  // (which needs it too — see its restore gate). Home cannot scroll and
  // row 2 is the only place either rail can go, so they share it as tabs
  // rather than as two sections stacked in the same grid area, which is
  // what they were: one heading drawn over the other, for anyone with a
  // non-empty list.
  //
  // Seeded from the module, not from a constant: Home unmounts when a
  // title is opened from it, and coming back to the wrong tab loses the
  // browsing origin — see homeRailTab.ts.
  const tabbed = planned !== undefined
  const plannedItems = planned ?? NO_PLANNED
  const [tab, setTab] = useState<HomeRailTab>(() => (tabbed ? activeHomeRailTab() : 'picks'))
  // A tab with nothing behind it is not offered, and cannot stay selected
  // if the list empties out from under it (unfollowing the last title).
  const activeTab = tab === 'planned' && plannedItems.length === 0 ? 'picks' : tab
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

  // Each rail keeps its own offset. One <ul> serves both, so without this
  // the scroll position simply carried across a tab switch — landing the
  // other rail wherever this one happened to be, or past its end.
  const railOffsets = useRef<Record<HomeRailTab, number>>({ picks: 0, planned: 0 })
  const shownTab = useRef<HomeRailTab>(activeTab)

  function selectTab(next: HomeRailTab): void {
    railOffsets.current[activeTab] = scrollerRef.current?.scrollLeft ?? 0
    setActiveHomeRailTab(next)
    setTab(next)
  }

  // Applied before paint so a switch never shows the outgoing rail's
  // offset for a frame. Deliberately keyed on the tab actually rendered:
  // a fall back to picks (the list emptied) is a switch like any other.
  useLayoutEffect(() => {
    if (shownTab.current === activeTab) return
    shownTab.current = activeTab
    if (scrollerRef.current) scrollerRef.current.scrollLeft = railOffsets.current[activeTab]
  }, [activeTab])

  // Keep the module in step when the fallback above overrides the stored
  // tab, so the next mount does not try Planned again and re-lose a
  // restore against a rail that is not there.
  useEffect(() => {
    if (tabbed && activeTab !== tab) setActiveHomeRailTab(activeTab)
  }, [tabbed, activeTab, tab])

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
    //
    // `activeTab` for the same reason once more: switching tabs replaces
    // the scroller's contents without any loading state in between, and a
    // short Planned list after a long picks row would otherwise keep an
    // arrow pointing at nothing.
  }, [loading, picks, plannedItems, activeTab])

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
      {/* The heading IS the tab strip. With only one rail to show it reads
          as a plain heading — the Planned tab appears when there is a list
          behind it — so the common case looks exactly as it did.
          Home cannot scroll (see HomeDashboard.module.css), so "See all"
          on either tab is where the rest of that list lives. */}
      <h2 className={styles.heading} role="tablist" aria-label="Home rows">
        <button
          type="button"
          role="tab"
          id="home-rail-tab-picks"
          aria-selected={activeTab === 'picks'}
          aria-controls="home-rail-panel"
          className={`${styles.tab} ${activeTab === 'picks' ? styles.tabActive : ''}`}
          onClick={() => selectTab('picks')}
        >
          <Icon name="sparkle" />
          Recommended For You
        </button>
        {plannedItems.length > 0 && (
          <button
            type="button"
            role="tab"
            id="home-rail-tab-planned"
            aria-selected={activeTab === 'planned'}
            aria-controls="home-rail-panel"
            className={`${styles.tab} ${activeTab === 'planned' ? styles.tabActive : ''}`}
            onClick={() => selectTab('planned')}
          >
            <Icon name="tracked" />
            Planned
            <span className={styles.tabCount}>{plannedItems.length}</span>
          </button>
        )}
        {(activeTab === 'planned' || picks.length > 0) && (
          <Link to={SEE_ALL[activeTab].to} className={styles.seeAll}>
            {SEE_ALL[activeTab].label}
          </Link>
        )}
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
      {activeTab === 'picks' && homeFeedError && picks.length > 0 && (
        <p className={styles.staleNotice} role="status">
          <Icon name="wifi-off" size={13} />
          Couldn&apos;t reach the media hub backend — these picks may be out of date.
          <button type="button" onClick={refreshHomeFeed} className={styles.emptyRetry}>
            <Icon name="refresh" size={13} />
            Retry
          </button>
        </p>
      )}
      {activeTab === 'picks' && !loading && picks.length === 0 ? (
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
          {/* `data-rail-id` differs per tab so each rail's scroll offset is
              restored to its own row rather than to whichever was last
              open — see useRestoreBrowsingOrigin. */}
          <ul
            className={`${styles.scroller} thin-scroll`}
            ref={scrollerRef}
            id="home-rail-panel"
            role="tabpanel"
            aria-labelledby={`home-rail-tab-${activeTab}`}
            data-rail-id={activeTab === 'planned' ? 'planned' : 'ai-picks'}
            onKeyDown={handleKeyDown}
          >
            {activeTab === 'planned'
              ? plannedItems
                  .slice(0, PLANNED_ROW_LIMIT)
                  .map((media) => <MediaCard key={media.id} media={media} />)
              : loading
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
