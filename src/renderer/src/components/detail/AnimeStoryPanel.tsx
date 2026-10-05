'use client'

import type { AnimeStoryLink, AnimeStoryOrder, AnimeTimelineEntry } from '@shared/media-hub/types'
import type { MediaItem } from '@renderer/types'
import { Icon } from '@renderer/components/icons/Icon'
import { resolveArtwork } from '@renderer/lib/artwork'
import { ArtworkImage } from '@renderer/components/media/ArtworkImage'
import styles from './AnimeStoryPanel.module.css'

/** `kind` is Kitsu's kind of entry (CatalogItem.subtype), which a MediaItem
 *  does not carry. */
type StoryLink = Omit<AnimeStoryLink, 'item'> & { item: MediaItem; kind?: string }
type StoryEntry = Omit<AnimeTimelineEntry, 'item'> & { item: MediaItem; kind?: string }

/** Kitsu's kinds of entry that are not a TV series, as people say them. */
const KIND_LABEL: Record<string, string> = {
  movie: 'Film',
  ova: 'OVA',
  ona: 'ONA',
  special: 'Special',
  music: 'Music video'
}

/** What kind of entry it is, when that is worth saying: anything but a TV
 *  series. Without Kitsu's kind (a link cached before it was read), a
 *  one-episode entry is taken for a film, as it always was. */
function kindLabel(kind: string | undefined, item: MediaItem): string {
  if (kind) return KIND_LABEL[kind] ?? ''
  return item.totalEpisodes === 1 ? 'Film' : ''
}

const ORDER_LABEL: Record<AnimeStoryOrder, string> = {
  release: 'Release order',
  story: 'Story order'
}

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
  /** The franchise in `order` (AnimeStoryResult.timeline). */
  timeline: StoryEntry[]
  order: AnimeStoryOrder
  onOrderChange: (order: AnimeStoryOrder) => void
  currentStatus?: string
  episodeCount?: number
  onSelect: (item: MediaItem) => void
  /** A season of this show picked from the list: its tab is opened. */
  onSelectSeason: (season: number) => void
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
  timeline,
  order,
  onOrderChange,
  currentStatus,
  episodeCount,
  onSelect,
  onSelectSeason
}: AnimeStoryPanelProps) {
  const completed = isFinished(currentStatus)
  const releaseMessage = completed
    ? episodeCount === 1
      ? 'This is a finished one-episode release. Finished applies to this title, not the whole franchise.'
      : 'Finished applies to this title. Check the direct story links before deciding the franchise is over.'
    : 'Direct story links from the anime catalog.'

  // Shown in every state, so a choice that could not be answered (story
  // order needs each part's links) can always be taken back.
  const toggle = (
    <div className={styles.orderToggle} role="group" aria-label="Order">
      {(['release', 'story'] as const).map((value) => (
        <button
          key={value}
          type="button"
          className={`${styles.orderButton} ${order === value ? styles.orderButtonActive : ''}`}
          aria-pressed={order === value}
          onClick={() => onOrderChange(value)}
        >
          {ORDER_LABEL[value]}
        </button>
      ))}
    </div>
  )

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
        {toggle}
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
        {toggle}
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

  /** One row of the guide: a title to open, or a season of this show. */
  const row = (
    key: string,
    item: MediaItem,
    label: string,
    after: boolean,
    onClick: () => void
  ) => {
    const artwork = resolveArtwork(item)
    return (
      <li key={key}>
        <button
          type="button"
          className={`${styles.storyLink} ${after ? styles.sequel : styles.prequel}`}
          data-media-id={item.id}
          onClick={onClick}
        >
          <ArtworkImage
            src={artwork.thumbnailUrl ?? artwork.posterUrl}
            alt=""
            fallbackTitle={item.title}
            artTint={item.artTint}
            className={styles.thumb}
          />
          <span className={styles.info}>
            <span className={styles.linkType}>{label}</span>
            <span className={styles.title}>{item.title}</span>
            <span className={styles.meta}>{availability(item)}</span>
          </span>
          <Icon name="chevron" size={16} className={styles.chevron} />
        </button>
      </li>
    )
  }

  /** A timeline entry: a season of this show opens its tab, anything else
   *  opens as itself. */
  const entryRow = (entry: StoryEntry) => {
    const kind = kindLabel(entry.kind, entry.item)
    if (entry.season !== undefined) {
      const season = entry.season
      return row(`season:${season}`, entry.item, `Season ${season}`, true, () =>
        onSelectSeason(season)
      )
    }
    const label = entry.relation
      ? `${RELATION_LABEL[entry.relation]}${kind ? ` · ${kind}` : ''}`
      : kind || 'Part of this story'
    return row(`entry:${entry.item.id}`, entry.item, label, entry.relation !== 'prequel', () =>
      onSelect(entry.item)
    )
  }

  return (
    <section className={`${styles.panel} glass-panel`} aria-label="Story links">
      <div className={styles.header}>
        <Icon name="stack" size={16} className={styles.headerIcon} />
        <div>
          <p className={styles.eyebrow}>Franchise guide</p>
          <h2 className={styles.heading}>Where this story goes</h2>
        </div>
      </div>
      {toggle}
      <p className={styles.context}>{releaseMessage}</p>

      {order === 'story' ? (
        timeline.length > 1 ? (
          <div>
            {/* Kitsu's prequel and sequel links, in the order they make;
                what they leave unordered goes by air date. */}
            <p className={styles.groupLabel}>In story order</p>
            <ul className={styles.list}>{timeline.map(entryRow)}</ul>
          </div>
        ) : (
          <p className={styles.empty}>
            No prequel or sequel is listed to put this story in order. That does not rule out a
            future announcement.
          </p>
        )
      ) : (
        <>
          {timeline.length > 0 && (
            <div>
              {/* A merged show's seasons, with the films and OVAs between
                  the seasons they came out between. */}
              <p className={styles.groupLabel}>This show, as released</p>
              <ul className={styles.list}>{timeline.map(entryRow)}</ul>
            </div>
          )}
          {groups.length ? (
            groups.map((group) => (
              <div key={group.label}>
                <p className={styles.groupLabel}>{group.label}</p>
                <ul className={styles.list}>
                  {group.links.map((link) => {
                    const kind = kindLabel(link.kind, link.item)
                    return row(
                      `${link.relation}:${link.item.id}`,
                      link.item,
                      `${RELATION_LABEL[link.relation]}${kind ? ` · ${kind}` : ''}`,
                      link.relation === 'sequel',
                      () => onSelect(link.item)
                    )
                  })}
                </ul>
              </div>
            ))
          ) : timeline.length ? null : (
            <p className={styles.empty}>
              No direct sequel or prequel is listed right now. That does not rule out a future
              announcement.
            </p>
          )}
        </>
      )}
    </section>
  )
}
