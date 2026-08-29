import { useAppState } from '@renderer/context/AppStateContext'
import styles from './TopUtilityBar.module.css'

/**
 * The bar is the edge the app face and the control centre face share, so it
 * is also the only thing that can say which side you are looking at — the
 * control centre no longer carries a heading of its own, because a heading
 * directly under this one was saying the same thing twice.
 *
 * So the word changes with the face. Same mark, same position, same
 * treatment; only the second line moves, which reads as one object being
 * relabelled rather than the chrome being replaced.
 */
export function Brand() {
  const { controlCentreOpen } = useAppState()
  return (
    <div className={styles.brand}>
      <span className={styles.brandMark}>R3</span>
      <span className={styles.brandWord}>
        <span>MEDIA</span>
        <span>{controlCentreOpen ? 'CONTROL HUB' : 'CENTER'}</span>
      </span>
    </div>
  )
}
