'use client'

import { useState } from 'react'
import type { MediaItem } from '@renderer/types'
import type { DetailAdapterConfig } from '@renderer/lib/mediaHub/detailAdapters'
import styles from './AboutPanel.module.css'

const COLLAPSE_LENGTH = 320

/**
 * Renders only what the backend actually provides, never a plausible-
 * looking stand-in for a field the spec asked for and the data cannot
 * support.
 *
 * That constraint used to rule out cast and director entirely: the
 * CatalogItem model carried synopsis/genres/year/runtime/status and
 * nothing else. It now carries cast, creators and story-type labels for
 * titles a source could supply them for (see main/media-hub/credits.ts),
 * so those are rendered — and still only when actually present. Language,
 * subtitle-track list and country remain absent from the model, so they
 * remain absent here.
 *
 * Every one of these is optional at the item level, not just at the field
 * level: a grid card never carries them (they are resolved per title, on
 * the detail page), anime has no cast, and a title TMDB has never heard of
 * has none of them.
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
        {media.creators?.length ? (
          <div className={styles.fact}>
            <dt>{config.isEpisodic ? 'Created by' : 'Director'}</dt>
            <dd>{media.creators.join(', ')}</dd>
          </div>
        ) : null}
      </dl>
      {media.cast?.length ? (
        <div className={styles.people}>
          <h3 className={styles.subheading}>Cast</h3>
          <p className={styles.names}>{media.cast.join(', ')}</p>
        </div>
      ) : null}
      {media.storyTags?.length ? (
        <div className={styles.people}>
          <h3 className={styles.subheading}>Story</h3>
          <ul className={styles.tags}>
            {media.storyTags.map((tag) => (
              <li key={tag} className={styles.tag}>
                {tag}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
