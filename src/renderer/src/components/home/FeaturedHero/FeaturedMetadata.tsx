import { MediaItem } from '@renderer/types'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './FeaturedHero.module.css'

export function FeaturedMetadata({ item }: { item: MediaItem }) {
  return (
    <div>
      <span className={styles.label}>Featured</span>
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
      </div>
    </div>
  )
}
