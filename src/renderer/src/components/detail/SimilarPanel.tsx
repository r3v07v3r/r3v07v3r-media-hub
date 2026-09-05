'use client'

import { useEffect, useRef, useState } from 'react'
import type { MediaItem } from '@renderer/types'
import type { DetailAdapterConfig } from '@renderer/lib/mediaHub/detailAdapters'
import { resolveArtwork } from '@renderer/lib/artwork'
import { ArtworkImage } from '@renderer/components/media/ArtworkImage'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './SimilarPanel.module.css'

export interface SimilarPanelProps {
  status: 'loading' | 'ready' | 'error'
  items: MediaItem[]
  config: DetailAdapterConfig
  onSelect: (item: MediaItem) => void
}

/**
 * Titles in the same vein as this one — genre and style, not the same
 * franchise (see catalog.ts's similarTitles). Lives in the main content
 * column (below About) rather than the sidebar, so it renders as a wide
 * poster carousel instead of a cramped vertical list — every item is
 * already reachable by scrolling, so there's no separate "show all"
 * control the way the old sidebar list needed one.
 *
 * There used to be a fourth "unsupported" state here explaining that
 * series had no backend support for this. Every kind is supported now, so
 * the honest remaining states are just loading/ready/error plus a real
 * empty result.
 */
export function SimilarPanel({ status, items, config, onSelect }: SimilarPanelProps) {
  const scrollerRef = useRef<HTMLUListElement>(null)
  const [canScrollBack, setCanScrollBack] = useState(false)
  const [canScrollForward, setCanScrollForward] = useState(false)

  // The global stylesheet hides this rail's scrollbar (see .thin-scroll),
  // and it's overflow-x only — a plain vertical-wheel mouse (no trackpad,
  // no shift+scroll habit) would otherwise have no discoverable way to
  // reach cards past the fold. Same "<"/">" affordance
  // RecommendationCarousel uses, plus a wheel translation for the mouse
  // case that carousel doesn't need (it also gets keyboard tabbing, but a
  // sighted mouse-only user won't discover that on their own).
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
  }, [items])

  function handleWheel(e: React.WheelEvent<HTMLUListElement>) {
    const el = scrollerRef.current
    if (!el || e.deltaY === 0) return
    // Only take over when there's nowhere left to scroll vertically inside
    // this rail (there never is — it has no vertical overflow of its own)
    // and horizontal movement is actually possible, so this never fights a
    // trackpad's native diagonal/horizontal gesture.
    if (el.scrollWidth <= el.clientWidth) return
    el.scrollLeft += e.deltaY
    e.preventDefault()
  }

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

  if (status === 'loading') {
    return (
      <section
        className={`${styles.panel} glass-panel`}
        aria-busy="true"
        aria-label="Loading similar titles"
      >
        <h2 className={styles.heading}>Similar {config.pluralLabel}</h2>
        <ul className={`${styles.scroller} thin-scroll`}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <li key={i} className={styles.skeletonCard} aria-hidden="true" />
          ))}
        </ul>
      </section>
    )
  }

  if (status === 'error') {
    return (
      <section className={`${styles.panel} glass-panel`} aria-label="Similar titles">
        <h2 className={styles.heading}>Similar {config.pluralLabel}</h2>
        <p className={styles.note}>Couldn&apos;t load suggestions right now.</p>
      </section>
    )
  }

  if (items.length === 0) {
    return (
      <section className={`${styles.panel} glass-panel`} aria-label="Similar titles">
        <h2 className={styles.heading}>Similar {config.pluralLabel}</h2>
        <p className={styles.note}>No similar titles found.</p>
      </section>
    )
  }

  return (
    <section className={`${styles.panel} glass-panel`} aria-label="Similar titles">
      <h2 className={styles.heading}>Similar {config.pluralLabel}</h2>
      <div className={styles.scrollerWrap}>
        <ul
          className={`${styles.scroller} thin-scroll`}
          ref={scrollerRef}
          onWheel={handleWheel}
        >
          {items.map((item) => {
            const artwork = resolveArtwork(item)
            return (
              <li key={item.id} className={styles.cardItem}>
                <button
                  type="button"
                  className={styles.card}
                  data-media-id={item.id}
                  aria-label={item.title}
                  onClick={() => onSelect(item)}
                >
                  <ArtworkImage
                    src={artwork.posterUrl ?? artwork.thumbnailUrl}
                    alt=""
                    fallbackTitle={item.title}
                    artTint={item.artTint}
                    className={styles.poster}
                  />
                </button>
                <span className={styles.title}>{item.title}</span>
                <span className={styles.meta}>
                  {item.releaseYear}
                  {item.communityRating ? ` · ★ ${item.communityRating.toFixed(1)}` : ''}
                </span>
              </li>
            )
          })}
        </ul>
        {canScrollBack && (
          <button
            type="button"
            className={`${styles.arrow} ${styles.arrowLeft}`}
            aria-label={`Show previous ${config.pluralLabel.toLowerCase()}`}
            onClick={() => scrollByPage(-1)}
          >
            <Icon name="chevron-left" />
          </button>
        )}
        {canScrollForward && (
          <button
            type="button"
            className={styles.arrow}
            aria-label={`Show more ${config.pluralLabel.toLowerCase()}`}
            onClick={() => scrollByPage(1)}
          >
            <Icon name="chevron" />
          </button>
        )}
      </div>
    </section>
  )
}
