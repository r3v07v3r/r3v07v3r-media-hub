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
  onViewAll: () => void
}

/**
 * Titles in the same vein as this one — genre and style, not the same
 * franchise (see catalog.ts's similarTitles).
 *
 * There used to be a fourth "unsupported" state here explaining that
 * series had no backend support for this. Every kind is supported now, so
 * the honest remaining states are just loading/ready/error plus a real
 * empty result.
 */
export function SimilarPanel({ status, items, config, onSelect, onViewAll }: SimilarPanelProps) {
  if (status === 'loading') {
    return (
      <section className={`${styles.panel} glass-panel`} aria-busy="true" aria-label="Loading similar titles">
        <h2 className={styles.heading}>Similar {config.pluralLabel}</h2>
        <ul className={styles.list}>
          {[0, 1, 2].map((i) => (
            <li key={i} className={styles.skeletonRow} />
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
      <div className={styles.headerRow}>
        <h2 className={styles.heading}>Similar {config.pluralLabel}</h2>
        <button type="button" className={styles.viewAll} onClick={onViewAll}>
          View All
        </button>
      </div>
      <ul className={styles.list}>
        {items.slice(0, 6).map((item) => {
          const artwork = resolveArtwork(item)
          return (
            <li key={item.id}>
              <button
                type="button"
                className={styles.row}
                data-media-id={item.id}
                onClick={() => onSelect(item)}
              >
                <ArtworkImage
                  src={artwork.thumbnailUrl ?? artwork.posterUrl}
                  alt=""
                  fallbackTitle={item.title}
                  artTint={item.artTint}
                  className={styles.thumb}
                />
                <div className={styles.info}>
                  <span className={styles.title}>{item.title}</span>
                  <span className={styles.meta}>
                    {item.releaseYear}
                    {item.communityRating ? ` · ★ ${item.communityRating.toFixed(1)}` : ''}
                  </span>
                </div>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
