'use client'

import type { MediaItem } from '@renderer/types'
import type { DetailAdapterConfig } from '@renderer/lib/mediaHub/detailAdapters'
import { resolveArtwork } from '@renderer/lib/artwork'
import { ArtworkImage } from '@renderer/components/media/ArtworkImage'
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
      <ul className={`${styles.scroller} thin-scroll`}>
        {items.map((item) => {
          const artwork = resolveArtwork(item)
          return (
            <li key={item.id} className={styles.cardItem}>
              <button
                type="button"
                className={styles.card}
                data-media-id={item.id}
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
    </section>
  )
}
