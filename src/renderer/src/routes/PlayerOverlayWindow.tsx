// Root of the player-overlay window — the transparent control surface layered
// over mpv's native video output.
//
// The page background MUST stay fully transparent: mpv is rendering underneath
// this window, not behind a video element inside it. Anything opaque here is a
// black rectangle over the film.
//
// Two structural behaviours live here rather than in the controls themselves,
// because they are about the window and not about any one control:
//
//  1. CLICK-THROUGH. While the controls are hidden the whole window is
//     click-through (main calls setIgnoreMouseEvents with forward: true), so
//     clicks land on mpv while mousemove still reaches this side to reveal the
//     controls. Without it, an invisible full-screen window would swallow every
//     click aimed at the picture.
//  2. NO SHOW/HIDE. The window stays up for the whole session and the controls
//     fade with CSS. Toggling a transparent window's visibility is what
//     produces the flicker Electron transparent overlays are known for on
//     Windows; measured this way, the overlay costs 0 dropped frames.

import { useCallback, useEffect, useRef, useState } from 'react'

import { PlayerWindowProvider, usePlayerWindow } from '@renderer/context/PlayerWindowContext'
import styles from './PlayerOverlayWindow.module.css'

const CONTROLS_IDLE_MS = 3200

function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00'
  const seconds = Math.floor(totalSeconds % 60)
  const minutes = Math.floor((totalSeconds / 60) % 60)
  const hours = Math.floor(totalSeconds / 3600)
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes)
  return `${hours > 0 ? `${hours}:` : ''}${mm}:${String(seconds).padStart(2, '0')}`
}

function PlayerControls() {
  const { session, state, command, ui, setInteractive } = usePlayerWindow()
  const [controlsVisible, setControlsVisible] = useState(true)
  const [menu, setMenu] = useState<'audio' | 'subtitles' | null>(null)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // A menu being open has to pin the controls open too — otherwise the idle
  // timer closes the surface out from under someone mid-selection.
  const pinned = menu !== null

  const revealControls = useCallback(() => {
    setControlsVisible(true)
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(() => setControlsVisible(false), CONTROLS_IDLE_MS)
  }, [])

  // Arms the initial idle countdown only — `controlsVisible` already starts
  // true, so calling revealControls() here would set state it is already in and
  // trigger a cascading render for nothing.
  useEffect(() => {
    idleTimer.current = setTimeout(() => setControlsVisible(false), CONTROLS_IDLE_MS)
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current)
    }
  }, [])

  // The window only takes mouse input while there is something to click.
  useEffect(() => {
    setInteractive(controlsVisible || pinned)
  }, [controlsVisible, pinned, setInteractive])

  const paused = state.paused ?? true
  const timePos = state.timePos ?? 0
  const duration = state.duration ?? session?.tracks?.durationSeconds ?? 0
  const audioTracks = session?.tracks?.audio ?? []
  const subtitleTracks = session?.tracks?.subtitle ?? []
  const buffering = state.bufferingForCache === true

  const seekToFraction = (fraction: number): void => {
    if (!duration) return
    void command({ type: 'seek', seconds: Math.max(0, Math.min(1, fraction)) * duration })
  }

  return (
    <div
      className={styles.surface}
      onMouseMove={revealControls}
      onDoubleClick={() => ui({ type: 'set-party-panel-open', open: false })}
    >
      {buffering && (
        <div className={styles.buffering} aria-live="polite">
          <span className={styles.spinner} aria-hidden="true" />
          <span>Buffering…</span>
        </div>
      )}

      <div
        className={`${styles.controls} ${controlsVisible || pinned ? '' : styles.controlsHidden}`}
      >
        <div className={styles.title}>
          {session?.media?.title ?? ''}
          {session?.media?.episodeTitle ? ` — ${session.media.episodeTitle}` : ''}
        </div>

        <div
          className={styles.scrubber}
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(timePos)}
          tabIndex={0}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            seekToFraction((event.clientX - rect.left) / rect.width)
          }}
        >
          <div
            className={styles.scrubberFill}
            style={{ width: duration ? `${(timePos / duration) * 100}%` : '0%' }}
          />
        </div>

        <div className={styles.row}>
          <button
            type="button"
            className={styles.button}
            onClick={() => void command({ type: 'toggle-pause' })}
            aria-label={paused ? 'Play' : 'Pause'}
          >
            {paused ? '▶' : '❚❚'}
          </button>

          <span className={styles.time}>
            {formatTime(timePos)} / {formatTime(duration)}
          </span>

          <div className={styles.spacer} />

          {audioTracks.length > 1 && (
            <div className={styles.menuWrap}>
              <button
                type="button"
                className={styles.button}
                onClick={() => setMenu(menu === 'audio' ? null : 'audio')}
              >
                Audio
              </button>
              {menu === 'audio' && (
                <div className={styles.menu}>
                  {audioTracks.map((track) => (
                    <button
                      key={track.ordinal}
                      type="button"
                      className={styles.menuItem}
                      // No busy state and no "Loading…" label, unlike the
                      // ffmpeg-restart path this replaced: selecting a track is
                      // a property write that lands in about a millisecond.
                      onClick={() => {
                        void command({ type: 'set-audio-track', ordinal: track.ordinal })
                        setMenu(null)
                      }}
                    >
                      {track.label}
                      {state.audioOrdinal === track.ordinal ? ' ✓' : ''}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className={styles.menuWrap}>
            <button
              type="button"
              className={styles.button}
              onClick={() => setMenu(menu === 'subtitles' ? null : 'subtitles')}
            >
              Subtitles
            </button>
            {menu === 'subtitles' && (
              <div className={styles.menu}>
                <button
                  type="button"
                  className={styles.menuItem}
                  onClick={() => {
                    void command({ type: 'set-subtitle-track', ordinal: -1 })
                    setMenu(null)
                  }}
                >
                  Off{state.subtitleOrdinal === -1 ? ' ✓' : ''}
                </button>
                {/* Every embedded track is listed, with no codec filtering and
                    no cache gate. Both existed only because the old pipeline
                    had to demux the whole file to WebVTT: image-based formats
                    (PGS/VobSub) had no OCR step and were permanently greyed
                    out. mpv renders them directly. */}
                {subtitleTracks.map((track) => (
                  <button
                    key={track.ordinal}
                    type="button"
                    className={styles.menuItem}
                    onClick={() => {
                      void command({ type: 'set-subtitle-track', ordinal: track.ordinal })
                      setMenu(null)
                    }}
                  >
                    {track.label}
                    {state.subtitleOrdinal === track.ordinal ? ' ✓' : ''}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            type="button"
            className={styles.button}
            onClick={() => ui({ type: 'stop-playback', watched: false })}
            aria-label="Close player"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  )
}

export default function PlayerOverlayWindow() {
  return (
    <PlayerWindowProvider>
      <PlayerControls />
    </PlayerWindowProvider>
  )
}
