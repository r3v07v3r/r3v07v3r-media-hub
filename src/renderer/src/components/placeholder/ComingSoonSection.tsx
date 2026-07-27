import { Icon } from '@renderer/components/icons/Icon'
import styles from './ComingSoonSection.module.css'

interface ComingSoonSectionProps {
  icon: string
  title: string
  description: string
}

/**
 * Shared empty-state placeholder, used as a conditional fallback by pages
 * that have real functionality but nothing to show yet (Downloads when no
 * download client is configured, My Stuff when nothing's been saved) —
 * not a whole-page placeholder itself.
 */
export function ComingSoonSection({ icon, title, description }: ComingSoonSectionProps) {
  return (
    <div className={styles.wrap}>
      <div className={`${styles.card} glass-panel`}>
        <div className={styles.iconWrap} aria-hidden="true">
          <Icon name={icon} size={30} />
        </div>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.description}>{description}</p>
        <span className={styles.badge}>Coming soon</span>
      </div>
    </div>
  )
}
