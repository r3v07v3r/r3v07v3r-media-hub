import { MediaItem } from '@renderer/types'
import styles from './FeaturedHero.module.css'

export function HeroSlideSelector({
  items,
  activeIndex,
  onSelect
}: {
  items: MediaItem[]
  activeIndex: number
  onSelect: (i: number) => void
}) {
  return (
    <div className={styles.selector} role="tablist" aria-label="Featured titles">
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          className={styles.segmentButton}
          role="tab"
          aria-selected={i === activeIndex}
          aria-label={item.title}
          onClick={() => onSelect(i)}
        >
          <span
            className={`${styles.segment} ${i === activeIndex ? styles.segmentActive : ''}`}
            style={i === activeIndex ? { ['--art-a' as string]: item.artTint[0] } : undefined}
          />
        </button>
      ))}
    </div>
  )
}
