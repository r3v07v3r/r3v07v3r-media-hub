import styles from './FeaturedHero.module.css'

/**
 * What the hero shows on a genuine first run — nothing remembered from a
 * previous session (see lib/mediaHub/startupSnapshot.ts) and the first
 * home:personalized/catalog:list fetch still out.
 *
 * It reuses .hero and .content rather than defining its own box, which is
 * the whole point: the real hero is a fixed 520px grid row (see .hero's
 * own comment), so the placeholder occupies exactly the space the loaded
 * hero will, and nothing below it moves when the titles arrive. The bars
 * are sized to the real elements they stand in for — eyebrow label,
 * title, two description lines, two action buttons, slide selector — so
 * this reads as the page arriving rather than as a different screen.
 */
export function FeaturedHeroSkeleton() {
  return (
    <section className={styles.hero} aria-busy="true" aria-label="Loading featured titles">
      <div className={styles.skeletonWash} aria-hidden="true" />
      <div className={styles.content} aria-hidden="true">
        <span className={`${styles.skeletonBar} ${styles.skeletonEyebrow}`} />
        <span className={`${styles.skeletonBar} ${styles.skeletonTitle}`} />
        <span className={`${styles.skeletonBar} ${styles.skeletonMeta}`} />
        <span className={`${styles.skeletonBar} ${styles.skeletonLine}`} />
        <span className={`${styles.skeletonBar} ${styles.skeletonLineShort}`} />
        <div className={styles.skeletonActions}>
          <span className={`${styles.skeletonBar} ${styles.skeletonButton}`} />
          <span className={`${styles.skeletonBar} ${styles.skeletonButtonNarrow}`} />
        </div>
        <span className={`${styles.skeletonBar} ${styles.skeletonSelector}`} />
      </div>
    </section>
  )
}
