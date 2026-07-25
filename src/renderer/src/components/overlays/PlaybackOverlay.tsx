'use client'

import { useEffect, useRef, useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import styles from './Overlays.module.css'

/** A mock playback surface — no real video, but a believable transport UI
 *  (play/pause, scrubber, elapsed/remaining) that demonstrates the
 *  "play and resume" interaction end to end (spec section 18). */
export function PlaybackOverlay() {
  const { playbackMedia, stopPlayback } = useAppState()
  const [playing, setPlaying] = useState(true)
  const [progress, setProgress] = useState(0.15)
  const closeRef = useRef<HTMLButtonElement>(null)

  // Reset playback/progress state when a new title starts playing —
  // adjusted during render (React's recommended pattern for resetting
  // state on prop change) rather than in an effect, so opening a new
  // title doesn't cost an extra render pass just to reset these two
  // values.
  const [trackedMediaId, setTrackedMediaId] = useState(playbackMedia?.id)
  if (playbackMedia && playbackMedia.id !== trackedMediaId) {
    setTrackedMediaId(playbackMedia.id)
    setProgress(playbackMedia.progressPercentage ? playbackMedia.progressPercentage / 100 : 0.05)
    setPlaying(true)
  }

  // Focus management + the keyboard shortcuts are genuine effects (DOM
  // focus imperatively set, a document-level listener subscribed).
  useEffect(() => {
    if (!playbackMedia) return
    closeRef.current?.focus()
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') stopPlayback()
      if (e.key === ' ') {
        e.preventDefault()
        setPlaying((p) => !p)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [playbackMedia, stopPlayback])

  useEffect(() => {
    if (!playbackMedia || !playing) return
    const id = setInterval(() => {
      setProgress((p) => Math.min(1, p + 0.004))
    }, 250)
    return () => clearInterval(id)
  }, [playbackMedia, playing])

  if (!playbackMedia) return null

  const totalMinutes = playbackMedia.runtimeMinutes || 45
  const elapsed = Math.round(totalMinutes * progress)
  const remaining = totalMinutes - elapsed

  return (
    <div className={styles.playback} role="dialog" aria-modal="true" aria-label="Playback">
      <div
        className={styles.playbackArt}
        style={{
          background: `linear-gradient(135deg, ${playbackMedia.artTint[0]}, ${playbackMedia.artTint[1]})`
        }}
      />
      <div className={styles.playbackScrim} />
      <button
        ref={closeRef}
        type="button"
        className={styles.playbackClose}
        onClick={stopPlayback}
        aria-label="Close playback"
      >
        <Icon name="x" size={17} />
      </button>
      <div className={styles.playbackContent}>
        <span className={styles.playbackTitle}>
          {playbackMedia.title}
          {playbackMedia.episodeTitle ? ` — ${playbackMedia.episodeTitle}` : ''}
        </span>
        <button
          type="button"
          className={styles.playPauseButton}
          onClick={() => setPlaying((p) => !p)}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          <Icon name={playing ? 'pause' : 'play'} />
        </button>
        <div className={styles.playbackScrubberWrap}>
          <div
            className={styles.playbackScrubberTrack}
            role="progressbar"
            aria-valuenow={Math.round(progress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Playback progress"
          >
            <div className={styles.playbackScrubberFill} style={{ width: `${progress * 100}%` }} />
          </div>
          <div className={styles.playbackTimes}>
            <span>{elapsed}m elapsed</span>
            <span>{Math.max(0, remaining)}m remaining</span>
          </div>
        </div>
      </div>
    </div>
  )
}
