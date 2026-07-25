import styles from './TopUtilityBar.module.css'

export function Brand() {
  return (
    <div className={styles.brand}>
      <span className={styles.brandMark}>R3</span>
      <span className={styles.brandWord}>
        <span>MEDIA</span>
        <span>CENTER</span>
      </span>
    </div>
  )
}
