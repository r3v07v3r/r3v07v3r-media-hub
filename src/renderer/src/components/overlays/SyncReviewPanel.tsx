'use client'

import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import overlayStyles from './Overlays.module.css'
import styles from './SyncReviewPanel.module.css'

/** Rendered from GlobalOverlays.tsx, driven by AppStateContext's
 *  syncDiscrepancies/syncReviewOpen — see tracking.ts's own header comment
 *  for how these disagreements are found and why nothing here is ever
 *  applied automatically. Each row is resolved independently: picking
 *  "Keep local"/"Use Simkl" pushes that value to the losing side, and
 *  "Ignore" just drops the item from future checks without changing
 *  either side. "Keep local" is recorded before it is sent, and a burst
 *  of them goes out as one batched request per service a few seconds
 *  after the last click — so working down this list is one push, and a
 *  row that leaves stays gone even if that push has to be retried on a
 *  later launch (see tracking.ts's pending-push queue). */
export function SyncReviewPanel() {
  const { syncReviewOpen, setSyncReviewOpen, syncDiscrepancies, resolveSyncDiscrepancy } =
    useAppState()

  if (!syncReviewOpen) return null

  return (
    <div
      className={overlayStyles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label="Out-of-sync titles"
      onClick={() => setSyncReviewOpen(false)}
    >
      <div
        className={`${overlayStyles.modal} ${styles.modal} glass-panel`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <div className={styles.headerText}>
            <span className={styles.title}>Out of sync with Simkl</span>
            <span className={styles.subtitle}>
              These titles disagree between this app and Simkl. Pick which side is right, or ignore
              a title to stop it showing up here.
            </span>
          </div>
          <button
            type="button"
            className={styles.closeButton}
            onClick={() => setSyncReviewOpen(false)}
            aria-label="Close"
          >
            <Icon name="x" size={13} />
          </button>
        </div>
        <div className={styles.list}>
          {syncDiscrepancies.length === 0 ? (
            <div className={styles.row}>
              <span className={styles.subtitle}>All caught up.</span>
            </div>
          ) : (
            syncDiscrepancies.map((d) => (
              <div key={d.id} className={styles.row}>
                {d.poster && <img className={styles.poster} src={d.poster} alt="" />}
                <div className={styles.info}>
                  <span className={styles.itemTitle}>
                    {d.title} {d.year ? `(${d.year})` : ''}
                  </span>
                  <div className={styles.statusRow}>
                    <span>Here:</span>
                    <span
                      className={`${styles.statusBadge} ${d.localWatched ? styles.statusWatched : styles.statusUnwatched}`}
                    >
                      {d.localWatched ? 'Watched' : 'Not watched'}
                    </span>
                    <span>Simkl:</span>
                    <span
                      className={`${styles.statusBadge} ${d.remoteWatched ? styles.statusWatched : styles.statusUnwatched}`}
                    >
                      {d.remoteWatched ? 'Watched' : 'Not watched'}
                    </span>
                  </div>
                </div>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={`${styles.actionButton} ${styles.actionButtonPrimary}`}
                    onClick={() => resolveSyncDiscrepancy(d, 'use-local')}
                  >
                    Keep local
                  </button>
                  <button
                    type="button"
                    className={styles.actionButton}
                    onClick={() => resolveSyncDiscrepancy(d, 'use-remote')}
                  >
                    Use Simkl
                  </button>
                  <button
                    type="button"
                    className={styles.ignoreButton}
                    aria-label={`Ignore ${d.title}`}
                    onClick={() => resolveSyncDiscrepancy(d, 'ignore')}
                  >
                    <Icon name="x" size={13} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
