'use client'

// Generic content-shelf rail shared by the Movies/Series/Anime category
// pages (Trending / New & Popular / Top Rated) — reuses the exact same
// MediaCard used by Home's "AI Picks" row (RecommendationCarousel) rather
// than a second card implementation, and mirrors that row's scroller/
// arrow/skeleton behavior. Deliberately its own component (not a prop
// added to RecommendationCarousel) because that component is hardcoded to
// Home's AI_PICKS/recommendations data source end to end — this one takes
// its items as a plain prop so it can show any MediaItem[] a category page
// hands it (trending/new&popular/top-rated slices — see
// lib/mediaHub/categoryFilters.ts).

import { useEffect, useRef, useState } from 'react'
import { MediaItem } from '@renderer/types'
import { Icon } from '@renderer/components/icons/Icon'
import { MediaCard } from '@renderer/components/home/RecommendationCarousel/MediaCard'
import styles from './MediaRail.module.css'

export interface MediaRailProps {
  title: string
  icon?: string
  items: MediaItem[]
  loading?: boolean
  emptyMessage?: string
}

export function MediaRail({
  title,
  icon = 'sparkle',
  items,
  loading = false,
  emptyMessage = 'Nothing here yet.'
}: MediaRailProps) {
  const [canScrollBack, setCanScrollBack] = useState(false)
  const [canScrollForward, setCanScrollForward] = useState(false)
  const scrollerRef = useRef<HTMLUListElement>(null)

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
  }, [loading, items.length])

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
    <section className={styles.section} aria-label={title}>
      <h2 className={styles.heading}>
        <Icon name={icon} />
        {title}
      </h2>
      {!loading && items.length === 0 ? (
        <p className={styles.emptyState}>{emptyMessage}</p>
      ) : (
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
              : items.map((media) => <MediaCard key={media.id} media={media} />)}
          </ul>
          {!loading && canScrollBack && (
            <button
              type="button"
              className={`${styles.arrow} ${styles.arrowLeft}`}
              aria-label={`Show previous ${title.toLowerCase()}`}
              onClick={() => scrollerRef.current?.scrollBy({ left: -380, behavior: 'smooth' })}
            >
              <Icon name="chevron-left" />
            </button>
          )}
          {!loading && canScrollForward && (
            <button
              type="button"
              className={styles.arrow}
              aria-label={`Show more ${title.toLowerCase()}`}
              onClick={() => scrollerRef.current?.scrollBy({ left: 380, behavior: 'smooth' })}
            >
              <Icon name="chevron" />
            </button>
          )}
        </div>
      )}
    </section>
  )
}
