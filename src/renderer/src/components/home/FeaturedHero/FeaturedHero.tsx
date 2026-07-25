'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { FEATURED_ITEMS } from '@renderer/data/mockData'
import { MediaItem } from '@renderer/types'
import { resolveArtwork } from '@renderer/lib/artwork'
import { ArtworkImage } from '@renderer/components/media/ArtworkImage'
import { useReducedMotion } from '@renderer/hooks/useReducedMotion'
import { FeaturedMetadata } from './FeaturedMetadata'
import { HeroActions } from './HeroActions'
import { HeroSlideSelector } from './HeroSlideSelector'
import styles from './FeaturedHero.module.css'

const ROTATE_MS = 7000

/** One backdrop layer — pulled out so both the current slide and a
 *  fading-out previous slide render identical art/scrim/vignette stacks. */
function HeroArtLayer({ item, current }: { item: MediaItem; current: boolean }) {
  const artwork = resolveArtwork(item)
  return (
    <div
      className={`${styles.artLayer} ${current ? styles.artLayerCurrent : styles.artLayerPrevious}`}
      style={{ ['--art-a' as string]: item.artTint[0] }}
    >
      <ArtworkImage
        src={artwork.backdropUrl}
        alt=""
        fallbackTitle={item.title}
        fallbackSubtitle={item.subtitle}
        artTint={item.artTint}
        priority={current}
        sizes="100vw"
        className={styles.artImageWrap}
        imageClassName={styles.artImage}
      />
      <div className={styles.artGlow} aria-hidden="true" />
      <div className={styles.artScrimLeft} aria-hidden="true" />
      <div className={styles.artScrimBottom} aria-hidden="true" />
      <div className={styles.artVignette} aria-hidden="true" />
    </div>
  )
}

export function FeaturedHero() {
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const [prevItem, setPrevItem] = useState<MediaItem | null>(null)
  const reducedMotion = useReducedMotion()
  const touchStartX = useRef<number | null>(null)
  const rootRef = useRef<HTMLElement>(null)
  const prevIndexRef = useRef(index)

  const item = FEATURED_ITEMS[index]

  // Crossfade: keep the outgoing slide mounted (fading out via CSS
  // keyframes) for one transition cycle so slide changes blend rather
  // than cut, per spec section 5 ("crossfade between slides").
  useEffect(() => {
    if (prevIndexRef.current === index) return
    setPrevItem(FEATURED_ITEMS[prevIndexRef.current])
    prevIndexRef.current = index
    const t = setTimeout(() => setPrevItem(null), 900)
    return () => clearTimeout(t)
  }, [index])

  const goTo = useCallback((i: number) => {
    setIndex((i + FEATURED_ITEMS.length) % FEATURED_ITEMS.length)
  }, [])
  const next = useCallback(() => goTo(index + 1), [goTo, index])
  const prev = useCallback(() => goTo(index - 1), [goTo, index])

  // Auto-advance, paused on hover/focus/reduced-motion (spec section 7).
  useEffect(() => {
    if (paused || reducedMotion) return
    const id = setTimeout(() => setIndex((i) => (i + 1) % FEATURED_ITEMS.length), ROTATE_MS)
    return () => clearTimeout(id)
  }, [index, paused, reducedMotion])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      next()
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      prev()
    }
  }

  function handleWheel(e: React.WheelEvent) {
    if (Math.abs(e.deltaY) < 12) return
    if (e.deltaY > 0) next()
    else prev()
  }

  function handleTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0]?.clientX ?? null
  }
  function handleTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current === null) return
    const dx = (e.changedTouches[0]?.clientX ?? 0) - touchStartX.current
    if (Math.abs(dx) > 40) {
      if (dx < 0) next()
      else prev()
    }
    touchStartX.current = null
  }

  return (
    <section
      ref={rootRef}
      className={styles.hero}
      style={{ ['--art-a' as string]: item.artTint[0] }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onKeyDown={handleKeyDown}
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      aria-roledescription="carousel"
      aria-label="Featured content"
    >
      {prevItem && <HeroArtLayer key={`prev-${prevItem.id}`} item={prevItem} current={false} />}
      <HeroArtLayer key={`current-${item.id}`} item={item} current />
      <div className={styles.grainLayer} aria-hidden="true" />

      <div className={styles.content}>
        <FeaturedMetadata item={item} />
        <HeroActions item={item} />
        <div className={styles.selectorWrap}>
          <button
            type="button"
            className={styles.navChevron}
            onClick={prev}
            aria-label="Previous featured title"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M15 5l-7 7 7 7" />
            </svg>
          </button>
          <HeroSlideSelector items={FEATURED_ITEMS} activeIndex={index} onSelect={goTo} />
          <button
            type="button"
            className={styles.navChevron}
            onClick={next}
            aria-label="Next featured title"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>
    </section>
  )
}
