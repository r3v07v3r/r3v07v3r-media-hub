'use client'

import { useEffect, useState } from 'react'
import type { MediaItem } from '@renderer/types'
import type { DetailAdapterConfig } from '@renderer/lib/mediaHub/detailAdapters'
import { useAppState } from '@renderer/context/AppStateContext'
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
/**
 * The age certificate for a title, in the person's own region.
 *
 * Fetched here rather than folded into the metadata pipeline: it is one string
 * that only this panel reads, it is region-scoped where the metadata cache is
 * not, and a title page that never scrolls this far should not have paid for
 * it. Keyed to its subject, like every other fetch on this page.
 */
function useContentRating(media: MediaItem): { rating: string; region: string } | null {
  const [result, setResult] = useState<{
    key: string
    value: { rating: string; region: string }
  } | null>(null)
  const kind = media.mediaKind ?? (media.mediaType === 'series' ? 'series' : 'movie')

  useEffect(() => {
    const api = window.api?.mediaHub
    if (!api || kind === 'anime' || !/^tt\d+$/.test(media.id)) return
    let cancelled = false
    api.catalog
      .rating(kind, media.id)
      .then((found) => {
        if (!cancelled) setResult({ key: media.id, value: found })
      })
      .catch(() => {
        if (!cancelled) setResult(null)
      })
    return () => {
      cancelled = true
    }
  }, [kind, media.id])

  if (result?.key !== media.id) return null
  return result.value.rating ? result.value : null
}

export function AboutPanel({ media, config }: { media: MediaItem; config: DetailAdapterConfig }) {
  const certificate = useContentRating(media)
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
        {certificate && (
          <div className={styles.fact}>
            {/* The region is part of the fact, not decoration: certification
                bodies are national, and the same film is PG-13 in one country
                and 12A in another. A bare "12" would be a claim about
                nowhere. */}
            <dt>Rated ({certificate.region})</dt>
            <dd>{certificate.rating}</dd>
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
            <dd>
              <NameList names={media.creators} />
            </dd>
          </div>
        ) : null}
      </dl>
      {media.cast?.length ? (
        <div className={styles.people}>
          <h3 className={styles.subheading}>Cast</h3>
          <NameList names={media.cast} />
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

/**
 * A row of names, each of which opens what else this catalog has of theirs.
 *
 * Buttons rather than links: the destination is a panel over this page, not a
 * route — there is no URL for "everything with Denis Villeneuve in it", and
 * inventing one would mean a route that cannot be shared or reloaded into
 * anything meaningful.
 *
 * The separators are rendered between the names rather than inside them, so a
 * name and its comma never end up as one click target.
 */
function NameList({ names }: { names: string[] }) {
  const { openPerson } = useAppState()
  return (
    <span className={styles.names}>
      {names.map((name, index) => (
        <span key={`${name}-${index}`}>
          {index > 0 ? ', ' : ''}
          <button type="button" className={styles.nameButton} onClick={() => openPerson(name)}>
            {name}
          </button>
        </span>
      ))}
    </span>
  )
}
