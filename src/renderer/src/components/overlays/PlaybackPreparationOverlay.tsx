import { useEffect, useRef } from 'react'
import { Icon } from '@renderer/components/icons/Icon'
import { useAppState } from '@renderer/context/AppStateContext'
import {
  PLAYBACK_PREPARATION_LABELS,
  PLAYBACK_PREPARATION_STAGES,
  type PlaybackTakeoverFailure,
  type ResolvingMedia
} from '@renderer/lib/mediaHub/playbackPreparation'
import styles from './Overlays.module.css'

export function PlaybackPreparationOverlay() {
  const {
    resolvingMedia,
    cancelPlaybackPreparation,
    playbackTakeoverFailure,
    dismissPlaybackTakeoverFailure
  } = useAppState()
  if (playbackTakeoverFailure && !resolvingMedia) {
    return (
      <TakeoverFailure failure={playbackTakeoverFailure} onClose={dismissPlaybackTakeoverFailure} />
    )
  }
  if (!resolvingMedia) return null
  if (resolvingMedia.takeover) {
    return <Takeover media={resolvingMedia} onCancel={cancelPlaybackPreparation} />
  }
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
              <span className={styles.preparationStageText}>
                {PLAYBACK_PREPARATION_LABELS[stage]}
                {/* Only ever under the stage that's actually running, and
                    only once main has said something about it — the stage
                    labels are fixed, this is the live part (see
                    PlaybackPrepareProgress). Steps 3 and 4 are where it
                    matters: they cover a single IPC call that can run for
                    a minute-plus on a large source. */}
                {active && resolvingMedia.detail && (
                  <span className={styles.preparationStageDetail}>{resolvingMedia.detail}</span>
                )}
              </span>
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

/**
 * The wait for a title started over another — Play next, the bar's Next
 * episode, a party moving on. The outgoing one has already been put away, so
 * this takes the whole window: mostly opaque and blurred, with the show's
 * page showing through behind and what is loading in the middle. The four
 * stages shrink to a row of steps and the one line that is live.
 */
function Takeover({ media, onCancel }: { media: ResolvingMedia; onCancel: () => void }) {
  const activeIndex = PLAYBACK_PREPARATION_STAGES.indexOf(media.stage)
  const cancelRef = useRef<HTMLButtonElement>(null)
  // Focus comes here with the screen: the controls that had it are gone, and
  // Enter or Space should not land on a page button behind the blur.
  useEffect(() => {
    cancelRef.current?.focus({ preventScroll: true })
  }, [])
  return (
    <div
      className={styles.takeover}
      role="dialog"
      aria-modal="true"
      aria-label={media.heading ?? `Loading ${media.title}`}
    >
      <div className={styles.takeoverBody} aria-live="polite">
        <span className={styles.takeoverSpinner} aria-hidden="true" />
        <p className={styles.takeoverEyebrow}>{media.subheading ? 'Up next' : 'Starting'}</p>
        <h2 className={styles.takeoverHeading}>{media.heading ?? `Loading ${media.title}`}</h2>
        {media.subheading && <p className={styles.takeoverSubheading}>{media.subheading}</p>}
        <ol className={styles.takeoverSteps} aria-hidden="true">
          {PLAYBACK_PREPARATION_STAGES.map((stage, index) => (
            <li
              key={stage}
              className={`${styles.takeoverStep} ${
                index < activeIndex
                  ? styles.takeoverStepDone
                  : index === activeIndex
                    ? styles.takeoverStepActive
                    : ''
              }`}
            />
          ))}
        </ol>
        <p className={styles.takeoverStatus}>
          {PLAYBACK_PREPARATION_LABELS[media.stage]}
          {media.detail ? ` · ${media.detail}` : ''}
        </p>
        <button ref={cancelRef} type="button" className={styles.takeoverCancel} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/** The takeover, when its title could not start: the reason, Try again, and
 *  Close to the show's page behind. */
function TakeoverFailure({
  failure,
  onClose
}: {
  failure: PlaybackTakeoverFailure
  onClose: () => void
}) {
  const retryRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    retryRef.current?.focus({ preventScroll: true })
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      className={styles.takeover}
      role="alertdialog"
      aria-modal="true"
      aria-label={failure.heading}
    >
      <div className={styles.takeoverBody}>
        <span className={styles.takeoverFailedIcon} aria-hidden="true">
          !
        </span>
        <h2 className={styles.takeoverHeading}>{failure.heading}</h2>
        <p className={styles.takeoverMessage}>{failure.message}</p>
        <div className={styles.takeoverActions}>
          <button
            ref={retryRef}
            type="button"
            className={styles.takeoverPrimary}
            onClick={() => {
              onClose()
              failure.retry()
            }}
          >
            Try again
          </button>
          {failure.setup && (
            <button
              type="button"
              className={styles.takeoverCancel}
              onClick={() => {
                onClose()
                failure.setup?.run()
              }}
            >
              {failure.setup.label}
            </button>
          )}
          <button type="button" className={styles.takeoverCancel} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
