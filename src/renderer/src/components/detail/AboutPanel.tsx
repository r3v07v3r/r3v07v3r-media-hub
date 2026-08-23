'use client'

import { useState } from 'react'
import type { MediaItem } from '@renderer/types'
import type { DetailAdapterConfig } from '@renderer/lib/mediaHub/detailAdapters'
import styles from './AboutPanel.module.css'

const COLLAPSE_LENGTH = 320

/**
 * The backend's CatalogItem model (see shared/media-hub/types.ts) only
 * ever carries synopsis/genres/year/runtime/status — no cast, director,
 * writers, studio, language, subtitle-track list, or country fields exist
 * anywhere in it. Rather than inventing plausible-looking values for
 * fields the spec asked for, this panel only ever renders what the
 * backend actually provides — see this component's own field list below.
 */
export function AboutPanel({ media, config }: { media: MediaItem; config: DetailAdapterConfig }) {
  const [expanded, setExpanded] = useState(false)
  const description = media.description ?? ''
  const isLong = description.length > COLLAPSE_LENGTH
  const shown = !isLong || expanded ? description : `${description.slice(0, COLLAPSE_LENGTH)}…`

  return (
    <section
      className={`${styles.panel} glass-panel`}
      aria-label={`About this ${config.label.toLowerCase()}`}
    >
      <h2 className={styles.heading}>About this {config.label}</h2>
      {description ? (
        <p className={styles.synopsis}>
          {shown}{' '}
          {isLong && (
            <button
              type="button"
              className={styles.expandButton}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </p>
      ) : (
        <p className={styles.synopsis}>No synopsis available.</p>
      )}
      <dl className={styles.factList}>
        {media.releaseYear && (
          <div className={styles.fact}>
            <dt>Released</dt>
            <dd>{media.releaseYear}</dd>
          </div>
        )}
        {media.status && (
          <div className={styles.fact}>
            <dt>Status</dt>
            <dd className={styles.capitalize}>{media.status}</dd>
          </div>
        )}
        {!config.isEpisodic && media.runtimeMinutes && (
          <div className={styles.fact}>
            <dt>Runtime</dt>
            <dd>{media.runtimeMinutes} min</dd>
          </div>
        )}
        {config.isEpisodic && media.totalSeasons && (
          <div className={styles.fact}>
            <dt>Seasons</dt>
            <dd>{media.totalSeasons}</dd>
          </div>
        )}
        {config.isEpisodic && media.totalEpisodes && (
          <div className={styles.fact}>
            <dt>Episodes</dt>
            <dd>{media.totalEpisodes}</dd>
          </div>
        )}
      </dl>
    </section>
  )
}
