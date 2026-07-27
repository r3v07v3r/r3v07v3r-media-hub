import { Icon } from '@renderer/components/icons/Icon'
import styles from './ComingSoonSection.module.css'

interface ComingSoonSectionProps {
  icon: string
  title: string
  description: string
}

/**
 * Shared placeholder for the nav routes the spec names (Movies, TV Shows,
 * Live TV, Music, My Stuff, Downloads) but doesn't design in
 * detail — the spec's full attention is on the Home dashboard. This keeps
 * every SidebarNavigation link landing on a real, on-brand page instead
 * of a 404 while those sections await their own design pass.
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
