'use client'

import { useAppState } from '@renderer/context/AppStateContext'
import styles from './PartyLoadingOverlay.module.css'

/** Shown to every party member EXCEPT the one who started playback, from
 *  the moment the host picks a title until this member's own stream is
 *  actually running.
 *
 *  It covers two waits back to back, which is the whole reason it exists:
 *  first the host resolving their stream (nothing is broadcast during
 *  that — `nowPlaying` can only be sent once there's a real stream to
 *  announce), then this member resolving their own. Previously both
 *  windows passed with no indication whatsoever that anything was
 *  happening. See PartyPreparingPayload in shared/media-hub/types.ts.
 *
 *  Suppressed once playback is up: PlaybackOverlay is then on screen and
 *  carries its own buffering state, so leaving this card floating over it
 *  would just be a second, contradictory spinner. */
export function PartyLoadingOverlay() {
  const { partyPreparing, playbackMedia } = useAppState()
  if (!partyPreparing || playbackMedia) return null
  return (
    <div className={`${styles.card} glass-panel`} role="status" aria-live="polite">
      {partyPreparing.poster ? (
        <img className={styles.poster} src={partyPreparing.poster} alt="" />
      ) : (
        <div className={styles.poster} aria-hidden="true" />
      )}
      <div className={styles.text}>
        <span className={styles.label}>
          <span className={styles.spinner} aria-hidden="true" />
          Starting party playback
        </span>
        {partyPreparing.title ? <span className={styles.title}>{partyPreparing.title}</span> : null}
        <span className={styles.hint}>Getting your stream ready…</span>
      </div>
    </div>
  )
}
