'use client'

import { useEffect, useRef, useState } from 'react'
import { AI_PICKS } from '@renderer/data/mockData'
import { Icon } from '@renderer/components/icons/Icon'
import { MediaCard } from './MediaCard'
import styles from './RecommendationCarousel.module.css'

export function RecommendationCarousel() {
  const [loading, setLoading] = useState(true)
  const [canScrollBack, setCanScrollBack] = useState(false)
  // Whether there's still unrevealed content to the right. On a wide
  // enough window (spec: "scale to show more items... 20+ to cover
  // ultra-wide screens") every card in AI_PICKS can fit without
  // scrolling at all, so the "show more" arrow needs to disappear
  // instead of floating over a row that has nothing left to reveal.
  const [canScrollForward, setCanScrollForward] = useState(false)
  const scrollerRef = useRef<HTMLUListElement>(null)

  // Staggered skeleton -> reveal on first mount, standing in for a real
  // "generating recommendations" round trip (spec section 15 / 18).
  useEffect(() => {
    const t = setTimeout(() => setLoading(false), 900)
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
  }, [loading])

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
    <section className={styles.section} aria-label="AI picks for you">
      <h2 className={styles.heading}>
        <Icon name="sparkle" />
        AI Picks For You
      </h2>
      <div className={styles.scrollerWrap}>
        <ul
          className={`${styles.scroller} thin-scroll`}
          ref={scrollerRef}
          onKeyDown={handleKeyDown}
        >
          {loading
            ? Array.from({ length: 6 }).map((_, i) => (
                <li key={i} className={styles.skeletonCard} aria-hidden="true" />
              ))
            : AI_PICKS.map((rec) => <MediaCard key={rec.media.id} media={rec.media} />)}
        </ul>
        {!loading && canScrollBack && (
          <button
            type="button"
            className={`${styles.arrow} ${styles.arrowLeft}`}
            aria-label="Show previous picks"
            onClick={() => scrollerRef.current?.scrollBy({ left: -380, behavior: 'smooth' })}
          >
            <Icon name="chevron-left" />
          </button>
        )}
        {!loading && canScrollForward && (
          <button
            type="button"
            className={styles.arrow}
            aria-label="Show more picks"
            onClick={() => scrollerRef.current?.scrollBy({ left: 380, behavior: 'smooth' })}
          >
            <Icon name="chevron" />
          </button>
        )}
      </div>
    </section>
  )
}
