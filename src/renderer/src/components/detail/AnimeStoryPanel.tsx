'use client'

import type { AnimeStoryLink } from '@shared/media-hub/types'
import type { MediaItem } from '@renderer/types'
import { Icon } from '@renderer/components/icons/Icon'
import { resolveArtwork } from '@renderer/lib/artwork'
import { ArtworkImage } from '@renderer/components/media/ArtworkImage'
import styles from './AnimeStoryPanel.module.css'

type StoryLink = Omit<AnimeStoryLink, 'item'> & { item: MediaItem }

interface AnimeStoryPanelProps {
  status: 'loading' | 'ready' | 'error'
  checked: boolean
  links: StoryLink[]
  currentStatus?: string
  episodeCount?: number
  onSelect: (item: MediaItem) => void
}

function isFinished(status: string | undefined): boolean {
  return /^(finished|ended|completed|cancelled|canceled)$/i.test(String(status || '').trim())
}

function availability(item: MediaItem): string {
  const status = String(item.status || '')
    .trim()
    .toLowerCase()
  if (['upcoming', 'unreleased', 'not yet released', 'tba'].includes(status)) return 'Upcoming'
  if (['current', 'airing', 'ongoing'].includes(status)) return 'Airing'
  if (['finished', 'ended', 'completed'].includes(status)) return 'Available'
  return item.releaseYear ? String(item.releaseYear) : 'Listed'
}

/** Direct franchise guide. It says a link is "listed" rather than
 * predicting a new season: missing data cannot prove one will not happen. */
export function AnimeStoryPanel({
  status,
  checked,
  links,
  currentStatus,
  episodeCount,
  onSelect
}: AnimeStoryPanelProps) {
  const completed = isFinished(currentStatus)
  const releaseMessage = completed
    ? episodeCount === 1
      ? 'This is a finished one-episode release. Finished applies to this title, not the whole franchise.'
      : 'Finished applies to this title. Check the direct story links before deciding the franchise is over.'
    : 'Direct story links from the anime catalog.'

  if (status === 'loading') {
    return (
      <section
        className={`${styles.panel} glass-panel`}
        aria-busy="true"
        aria-label="Checking story links"
      >
        <div className={styles.header}>
          <Icon name="stack" size={16} className={styles.headerIcon} />
          <div>
            <p className={styles.eyebrow}>Franchise guide</p>
            <h2 className={styles.heading}>Where this story goes</h2>
          </div>
        </div>
        <div className={styles.skeleton} />
      </section>
    )
  }

  if (status === 'error' || !checked) {
    return (
      <section className={`${styles.panel} glass-panel`} aria-label="Story links">
        <div className={styles.header}>
          <Icon name="stack" size={16} className={styles.headerIcon} />
          <div>
            <p className={styles.eyebrow}>Franchise guide</p>
            <h2 className={styles.heading}>Where this story goes</h2>
          </div>
        </div>
        <p className={styles.note}>Couldn&apos;t check sequel and prequel links right now.</p>
      </section>
    )
  }

  const ordered = [...links].sort(
    (a, b) => Number(b.relation === 'sequel') - Number(a.relation === 'sequel')
  )

  return (
    <section className={`${styles.panel} glass-panel`} aria-label="Story links">
      <div className={styles.header}>
        <Icon name="stack" size={16} className={styles.headerIcon} />
        <div>
          <p className={styles.eyebrow}>Franchise guide</p>
          <h2 className={styles.heading}>Where this story goes</h2>
        </div>
      </div>
      <p className={styles.context}>{releaseMessage}</p>

      {ordered.length ? (
        <ul className={styles.list}>
          {ordered.map((link) => {
            const artwork = resolveArtwork(link.item)
            const sequel = link.relation === 'sequel'
            return (
              <li key={`${link.relation}:${link.item.id}`}>
                <button
                  type="button"
                  className={`${styles.storyLink} ${sequel ? styles.sequel : styles.prequel}`}
                  data-media-id={link.item.id}
                  onClick={() => onSelect(link.item)}
                >
                  <ArtworkImage
                    src={artwork.thumbnailUrl ?? artwork.posterUrl}
                    alt=""
                    fallbackTitle={link.item.title}
                    artTint={link.item.artTint}
                    className={styles.thumb}
                  />
                  <span className={styles.info}>
                    <span className={styles.linkType}>
                      {sequel ? 'Continue with' : 'Watch first'}
                    </span>
                    <span className={styles.title}>{link.item.title}</span>
                    <span className={styles.meta}>{availability(link.item)}</span>
                  </span>
                  <Icon name="chevron" size={16} className={styles.chevron} />
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className={styles.empty}>
          No direct sequel or prequel is listed right now. That does not rule out a future
          announcement.
        </p>
      )}
    </section>
  )
}
