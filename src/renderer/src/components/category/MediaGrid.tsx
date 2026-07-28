'use client'

// Flat results grid — the category pages' one and only content view (see
// CategoryPage.tsx): every title matching the current filters, not a
// curated subset under a rail heading. Since that pool can be the kind's
// entire catalog, only a batch of it is actually rendered at a time
// (see visibleCount/BATCH below) — more is revealed as the person
// scrolls near the bottom, rather than mounting every card (and its
// artwork request) up front regardless of whether it's ever scrolled
// into view. Also carries this page's retry-capable error state (spec
// requirement) for the one thing that can genuinely fail here: the
// category-search backend call.

import { useCallback, useEffect, useRef, useState } from 'react'
import { MediaItem } from '@renderer/types'
import { Icon } from '@renderer/components/icons/Icon'
import { MediaCard } from '@renderer/components/home/RecommendationCarousel/MediaCard'
import styles from './MediaGrid.module.css'

const BATCH = 30

export interface MediaGridProps {
  items: MediaItem[]
  loading?: boolean
  error?: boolean
  onRetry?: () => void
  emptyTitle?: string
  emptyMessage?: string
  /** Seeds the initial reveal batch above BATCH — used when restoring a
   *  browsing position (see useRestoreBrowsingOrigin) whose focused card
   *  was further down the list than one batch would normally render, so
   *  it's actually present in the DOM for the restore step to find and
   *  scroll to. Only matters on this component's first mount (a plain
   *  useState initializer, not synced on every prop change) — CategoryPage
   *  computes it once from whatever's in the currently-pending
   *  BrowsingOrigin, which is exactly the mount this needs to affect. */
  initialVisibleCount?: number
}

export function MediaGrid({
  items,
  loading = false,
  error = false,
  onRetry,
  emptyTitle = 'No titles match these filters',
  emptyMessage = 'Try widening a filter or clearing them all.',
  initialVisibleCount
}: MediaGridProps) {
  const [visibleCount, setVisibleCount] = useState(initialVisibleCount ?? BATCH)
  // Read inside the observer callback below instead of closing over
  // `items.length` directly — the callback ref (see sentinelRef) only
  // (re)creates the observer when the sentinel <li> itself mounts or
  // unmounts, which doesn't happen on every items-length change, so a
  // captured `items.length` could go stale between renders. Updated in an
  // effect (not assigned inline during render) — mutating a ref's
  // `.current` mid-render is only safe once React has actually committed
  // this render.
  const itemsLengthRef = useRef(items.length)
  useEffect(() => {
    itemsLengthRef.current = items.length
  }, [items.length])

  // A new `items` array (a filter/sort change, a different search result
  // set) starts back at one batch rather than staying wherever the old
  // list's scroll position had grown to — otherwise switching to a much
  // shorter filtered set could leave visibleCount referencing rows that
  // no longer exist, and switching to a different set entirely should
  // read as a fresh result list, not a continuation of the last one's
  // reveal progress. Adjusted during render (React's own "reset state
  // when a prop changes" pattern — the same one SidebarNavigation.tsx's
  // moreOpenForPathname uses) rather than in an effect, which would cost
  // an extra render pass for what's otherwise a synchronous derivation.
  const [itemsForReset, setItemsForReset] = useState(items)
  if (itemsForReset !== items) {
    setItemsForReset(items)
    setVisibleCount(BATCH)
  }

  // A plain ref + a separate effect keyed on some dependency doesn't
  // reliably work here: the sentinel only exists in the JSX branch at the
  // bottom of this component (past the loading/error/empty early
  // returns), so it can mount on a render that doesn't change whatever
  // that effect's dependency array would list, leaving the observer
  // never attached. A callback ref sidesteps the whole question — it
  // fires exactly when the node itself is attached or detached,
  // regardless of what else did or didn't change that render.
  const observerInstanceRef = useRef<IntersectionObserver | null>(null)
  const sentinelRef = useCallback((node: HTMLLIElement | null) => {
    observerInstanceRef.current?.disconnect()
    observerInstanceRef.current = null
    if (!node) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((count) => Math.min(count + BATCH, itemsLengthRef.current))
        }
      },
      // Triggers the next batch a bit before the sentinel actually
      // scrolls into view, so more cards are already mounted by the time
      // the person reaches them instead of a visible pop-in at the edge.
      { rootMargin: '800px' }
    )
    observer.observe(node)
    observerInstanceRef.current = observer
  }, [])

  if (error) {
    return (
      <div className={styles.state} role="alert">
        <Icon name="wifi-off" size={26} />
        <p className={styles.stateTitle}>Couldn&apos;t reach the search backend</p>
        <p className={styles.stateMessage}>Check your connection and try again.</p>
        {onRetry && (
          <button type="button" className={styles.retryButton} onClick={onRetry}>
            <Icon name="refresh" />
            Retry
          </button>
        )}
      </div>
    )
  }

  if (loading) {
    return (
      <ul className={styles.grid} aria-busy="true" aria-label="Loading titles">
        {Array.from({ length: 10 }).map((_, i) => (
          <li key={i} className={styles.skeletonCard} aria-hidden="true" />
        ))}
      </ul>
    )
  }

  if (items.length === 0) {
    return (
      <div className={styles.state}>
        <Icon name="search" size={26} />
        <p className={styles.stateTitle}>{emptyTitle}</p>
        <p className={styles.stateMessage}>{emptyMessage}</p>
      </div>
    )
  }

  const visibleItems = items.slice(0, visibleCount)
  const hasMore = visibleCount < items.length

  return (
    <ul className={styles.grid}>
      {visibleItems.map((media) => (
        <MediaCard key={media.id} media={media} />
      ))}
      {/* Zero-size marker, not another skeleton card — its only job is
          to give the IntersectionObserver above something to watch near
          the end of what's currently rendered. */}
      {hasMore && (
        <li ref={sentinelRef} aria-hidden="true" style={{ gridColumn: '1 / -1', height: 1 }} />
      )}
    </ul>
  )
}
