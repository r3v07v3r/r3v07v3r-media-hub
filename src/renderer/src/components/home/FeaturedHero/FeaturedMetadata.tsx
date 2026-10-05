import { MediaItem } from '@renderer/types'
import { Icon } from '@renderer/components/icons/Icon'
import { useAppState } from '@renderer/context/AppStateContext'
import styles from './FeaturedHero.module.css'

export function FeaturedMetadata({ item }: { item: MediaItem }) {
  // A title marked Not interested from Home stays on the hero until the
  // page is left (heldFeed.ts), and Hide Disliked switched off on a library
  // page leaves it in that page's hero pool. Either way it is named here.
  const { dislikedIds } = useAppState()
  const disliked = dislikedIds.has(item.id)
  return (
    <div>
      <h1 className={styles.title}>
        {item.title}
        {item.subtitle && <span className={styles.subtitle}>{item.subtitle}</span>}
      </h1>
      {item.description && <p className={styles.description}>{item.description}</p>}
      <div className={styles.metaRow}>
        {disliked && (
          <span className={styles.dislikedChip}>
            <Icon name="thumbs-down" /> Not interested
          </span>
        )}
        {item.releaseYear && <span>{item.releaseYear}</span>}
        {item.communityRating && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Icon name="star" /> {item.communityRating.toFixed(1)}
          </span>
        )}
        {item.imdbRating && <span>IMDb {item.imdbRating.toFixed(1)}</span>}
        {item.genres.slice(0, 2).map((g) => (
          <span key={g}>{g}</span>
        ))}
        {/* Series/anime only — totalSeasons/totalEpisodes/status are only
            ever populated from the backend's own CatalogItem.videos/status
            (see adapters.ts's seasonEpisodeCounts), never guessed, so
            these chips simply don't render for movies or for any item the
            backend didn't supply episode data for. */}
        {item.totalSeasons != null && (
          <span>
            {item.totalSeasons} Season{item.totalSeasons === 1 ? '' : 's'}
          </span>
        )}
        {item.totalEpisodes != null && <span>{item.totalEpisodes} Episodes</span>}
        {item.status && <span className={styles.statusChip}>{item.status}</span>}
      </div>
    </div>
  )
}
