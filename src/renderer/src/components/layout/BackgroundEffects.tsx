'use client'

import { useReducedMotion } from '@renderer/hooks/useReducedMotion'
import styles from './BackgroundEffects.module.css'

/** Purely decorative — a near-black backdrop with a soft star field and
 *  slow-drifting color blobs (spec section 1: "light particle and
 *  star-field effects"). Always absolutely positioned per spec section
 *  21's "decorative background elements can use absolute positioning"
 *  carve-out; everything else in the app uses Grid/Flexbox. */
export function BackgroundEffects() {
  const reduced = useReducedMotion()
  return (
    <div className={`${styles.bg} ${reduced ? styles.reduced : ''}`} aria-hidden="true">
      {/* Painted nebula field (generated art, not CSS) — the base layer
          everything else drifts/glows on top of. Oversized (inset:-6%)
          and slow-panned so the parallax has room to move without ever
          showing an edge. */}
      <div className={styles.nebulaImage} />
      <div className={styles.stars} />
      <div className={`${styles.blob} ${styles.blobBlue}`} />
      <div className={`${styles.blob} ${styles.blobViolet}`} />
      <div className={`${styles.blob} ${styles.blobCyan}`} />
      {/* Layer 4 (motion spec section 9): one or two extremely faint
          curved circuit paths with a slow travelling light pulse — the
          only background layer that reads as "energy moving" rather
          than ambient drift. */}
      <svg className={styles.circuit} viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">
        <path
          className={styles.circuitPath}
          d="M-50,180 C250,180 250,320 550,320 C850,320 850,120 1150,120 C1350,120 1400,220 1650,220"
          pathLength={1}
        />
        <path
          className={styles.circuitPulse}
          d="M-50,180 C250,180 250,320 550,320 C850,320 850,120 1150,120 C1350,120 1400,220 1650,220"
          pathLength={1}
          style={{ animationDelay: '0s' }}
        />
        <path
          className={styles.circuitPath}
          d="M-50,720 C300,720 300,560 620,560 C980,560 980,780 1300,780 C1450,780 1500,700 1650,700"
          pathLength={1}
        />
        <path
          className={styles.circuitPulse}
          d="M-50,720 C300,720 300,560 620,560 C980,560 980,780 1300,780 C1450,780 1500,700 1650,700"
          pathLength={1}
          style={{ animationDelay: '5s' }}
        />
      </svg>
      <div className={styles.vignette} />
    </div>
  )
}
