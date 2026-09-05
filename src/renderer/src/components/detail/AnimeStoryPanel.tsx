'use client'

import type { AnimeStoryLink } from '@shared/media-hub/types'
import type { MediaItem } from '@renderer/types'
import { Icon } from '@renderer/components/icons/Icon'
import { resolveArtwork } from '@renderer/lib/artwork'
import { ArtworkImage } from '@renderer/components/media/ArtworkImage'
import styles from './AnimeStoryPanel.module.css'

type StoryLink = Omit<AnimeStoryLink, 'item'> & { item: MediaItem }

/** What each relation means to somebody deciding what to watch next. */
const RELATION_LABEL: Record<AnimeStoryLink['relation'], string> = {
  prequel: 'Watch first',
  parent_story: 'The main story',
  full_story: 'The full story',
  side_story: 'Side story',
  spin_off: 'Spin-off',
  summary: 'Recap',
  sequel: 'Continue with'
}

/** Before / alongside / after — the three questions a franchise raises. */
const STORY_GROUPS: ReadonlyArray<{ label: string; relations: AnimeStoryLink['relation'][] }> = [
  { label: 'Watch before', relations: ['prequel', 'parent_story', 'full_story'] },
  { label: 'Alongside', relations: ['side_story', 'spin_off', 'summary'] },
  { label: 'Watch after', relations: ['sequel'] }
]

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

  // Already in before / alongside / after order from main (animeStoryLinks);
  // grouped here under a heading each so the order reads as an order.
  const groups = STORY_GROUPS.map((group) => ({
    ...group,
    links: links.filter((link) => group.relations.includes(link.relation))
  })).filter((group) => group.links.length)

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

      {groups.length ? (
        groups.map((group) => (
          <div key={group.label}>
            <p className={styles.groupLabel}>{group.label}</p>
            <ul className={styles.list}>
              {group.links.map((link) => {
                const artwork = resolveArtwork(link.item)
                const after = link.relation === 'sequel'
                // A one-episode entry in a franchise is a film (or an OVA):
                // the thing people most want pointed out between seasons.
                const film = link.item.totalEpisodes === 1
                return (
                  <li key={`${link.relation}:${link.item.id}`}>
                    <button
                      type="button"
                      className={`${styles.storyLink} ${after ? styles.sequel : styles.prequel}`}
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
                          {RELATION_LABEL[link.relation]}
                          {film ? ' · Film' : ''}
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
          </div>
        ))
      ) : (
        <p className={styles.empty}>
          No direct sequel or prequel is listed right now. That does not rule out a future
          announcement.
        </p>
      )}
    </section>
  )
}
