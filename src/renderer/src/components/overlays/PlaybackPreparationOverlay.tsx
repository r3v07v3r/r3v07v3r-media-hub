import { Icon } from '@renderer/components/icons/Icon'
import { useAppState } from '@renderer/context/AppStateContext'
import {
  PLAYBACK_PREPARATION_LABELS,
  PLAYBACK_PREPARATION_STAGES
} from '@renderer/lib/mediaHub/playbackPreparation'
import styles from './Overlays.module.css'

export function PlaybackPreparationOverlay() {
  const { resolvingMedia, cancelPlaybackPreparation } = useAppState()
  if (!resolvingMedia) return null
  const activeIndex = PLAYBACK_PREPARATION_STAGES.indexOf(resolvingMedia.stage)

  return (
    <section
      className={`${styles.preparationCard} glass-panel`}
      aria-label={`Preparing ${resolvingMedia.title}`}
      aria-live="polite"
    >
      <div className={styles.preparationHeader}>
        <span className={styles.preparationSpinner} aria-hidden="true" />
        <div className={styles.preparationHeading}>
          <span className={styles.preparationEyebrow}>Preparing playback</span>
          <strong className={styles.preparationTitle}>{resolvingMedia.title}</strong>
        </div>
      </div>
      <ol className={styles.preparationStages}>
        {PLAYBACK_PREPARATION_STAGES.map((stage, index) => {
          const completed = index < activeIndex
          const active = index === activeIndex
          return (
            <li
              key={stage}
              className={`${styles.preparationStage} ${completed ? styles.preparationStageComplete : ''} ${active ? styles.preparationStageActive : ''}`}
              aria-current={active ? 'step' : undefined}
            >
              <span className={styles.preparationStageIcon} aria-hidden="true">
                {completed ? <Icon name="check" size={12} /> : index + 1}
              </span>
              {PLAYBACK_PREPARATION_LABELS[stage]}
            </li>
          )
        })}
      </ol>
      <button
        type="button"
        className={styles.preparationCancel}
        onClick={cancelPlaybackPreparation}
      >
        Cancel
      </button>
    </section>
  )
}
