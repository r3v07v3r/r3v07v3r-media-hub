'use client'

// Flat results grid — replaces the curated Trending/New & Popular/Top
// Rated rails on a category page whenever the user has an active filter,
// a non-default sort, or a live top-bar search running (see
// CategoryPage.tsx). Showing the same narrowed set under three separate
// rail headings once it's been filtered down would be redundant; one grid
// of results (same MediaCard as the rails, just wrapped instead of
// horizontally scrolling) is the honest representation of "here's what
// matches." Also carries this page's retry-capable error state (spec
// requirement) for the one thing that can genuinely fail here: the
// category-search backend call.

import { MediaItem } from '@renderer/types'
import { Icon } from '@renderer/components/icons/Icon'
import { MediaCard } from '@renderer/components/home/RecommendationCarousel/MediaCard'
import styles from './MediaGrid.module.css'

export interface MediaGridProps {
  items: MediaItem[]
  loading?: boolean
  error?: boolean
  onRetry?: () => void
  emptyTitle?: string
  emptyMessage?: string
}

export function MediaGrid({
  items,
  loading = false,
  error = false,
  onRetry,
  emptyTitle = 'No titles match these filters',
  emptyMessage = 'Try widening a filter or clearing them all.'
}: MediaGridProps) {
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

  return (
    <ul className={styles.grid}>
      {items.map((media) => (
        <MediaCard key={media.id} media={media} />
      ))}
    </ul>
  )
}
