import { MediaItem } from '@renderer/types'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './FeaturedHero.module.css'

export function FeaturedMetadata({
  item,
  label = 'Featured'
}: {
  item: MediaItem
  /** "Featured" on Home; category pages pass "Featured Movie"/"Featured
   *  Series"/"Featured Anime" so this reads as page-specific rather than
   *  generic. */
  label?: string
}) {
  return (
    <div>
      <span className={styles.label}>{label}</span>
      <h1 className={styles.title}>
        {item.title}
        {item.subtitle && <span className={styles.subtitle}>{item.subtitle}</span>}
      </h1>
      {item.description && <p className={styles.description}>{item.description}</p>}
      <div className={styles.metaRow}>
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
