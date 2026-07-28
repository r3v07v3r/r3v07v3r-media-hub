'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import { mediaItemToTrackablePayload } from '@renderer/lib/mediaHub/adapters'
import type { MediaTrack, PlaybackSelection, SubtitleResult } from '@shared/media-hub/types'
import styles from './Overlays.module.css'

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/**
 * The real playback surface — renders the stream AppStateContext's
 * startPlayback already resolved (stream:resolve + stream:play, done
 * BEFORE this component ever mounts — see that function's own comment on
 * why: a Play button showing its own inline "Searching…"/"Buffering…"
 * beats this overlay opening full-screen just to show that text itself,
 * and a no-source/error outcome now never opens this at all) in a genuine
 * `<video>` element with a real control bar (play/pause, seek, volume,
 * audio/subtitle track selection, fullscreen).
 */
export function PlaybackOverlay() {
  const {
    playbackMedia,
    playbackResult: result,
    playbackTracks: tracks,
    setPlaybackResult: setResult,
    setPlaybackTracks: setTracks,
    stopPlayback,
    pushNotification
  } = useAppState()
  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  const [playing, setPlaying] = useState(true)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [openMenu, setOpenMenu] = useState<'audio' | 'subtitles' | null>(null)
  const [subtitleResults, setSubtitleResults] = useState<SubtitleResult[] | null>(null)
  const [activeSubtitleTrackUrl, setActiveSubtitleTrackUrl] = useState<string | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  // How the video fills the player frame: 'contain' (default, letterboxed,
  // nothing cropped), 'cover' (fills the frame, crops whatever overflows),
  // 'fill' (stretches to the frame, ignoring aspect ratio entirely).
  const [fitMode, setFitMode] = useState<'contain' | 'cover' | 'fill'>('contain')
  const markedWatchedRef = useRef(false)
  const hideControlsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Compatibility-mode playback is a single, non-seekable HTTP connection
  // (the main process pipes ffmpeg's stdout straight through — see
  // vlc.ts's createFfmpegTranscoder — with no Range support), so seeking
  // outside whatever's already buffered can't be done by just moving
  // currentTime; it needs a fresh transcode restarted at the target time
  // via ffmpeg's -ss (see handleSeek below). Each restarted segment is its
  // own fresh stream starting from 0, so the <video> element's own
  // currentTime is relative to that restart, not the absolute media
  // position — streamStartOffsetRef holds the absolute offset the current
  // segment began at, and activeSelectionRef holds the last audio/subtitle
  // selection so a seek-triggered restart doesn't silently reset track
  // choice back to default.
  const streamStartOffsetRef = useRef(0)
  const activeSelectionRef = useRef<PlaybackSelection>({})

  const trackedMediaId = playbackMedia?.id
  const kind =
    playbackMedia?.mediaKind ?? (playbackMedia?.mediaType === 'series' ? 'series' : 'movie')

  // Stop the backend's playback session (closes the proxy / kills any
  // ffmpeg transcoder) whenever the overlay closes, whether via the close
  // button, Escape, or the title changing out from under it.
  useEffect(() => {
    if (!playbackMedia) return
    return () => {
      window.api?.mediaHub?.playback.stop().catch(() => {})
    }
  }, [trackedMediaId, playbackMedia])

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) video.play().catch(() => {})
    else video.pause()
  }, [])

  // Real OS-level window fullscreen (via the main process's
  // BrowserWindow.setFullScreen), not the DOM Fullscreen API on this
  // container div — that was the previously-shipped approach and it simply
  // didn't work reliably here. This channel/IPC pair already existed
  // (appIpc.ts's windowToggleFullscreen) but had no caller anywhere in the
  // renderer until now.
  const handleToggleFullscreen = useCallback(() => {
    window.api?.mediaHub?.window
      .toggleFullscreen()
      .then((result) => setIsFullscreen(result.fullScreen))
      .catch(() => {})
  }, [])

  // Keeps this button's icon/label in sync even if fullscreen is exited by
  // something other than this button (Escape, the OS's own fullscreen
  // shortcut) — see main/index.ts's enter-full-screen/leave-full-screen
  // listeners for the other half of this.
  useEffect(() => {
    if (!playbackMedia) return
    return window.api?.mediaHub?.window.onFullscreenChange((payload) =>
      setIsFullscreen(payload.fullScreen)
    )
  }, [playbackMedia])

  const cycleFitMode = useCallback(() => {
    setFitMode((prev) => (prev === 'contain' ? 'cover' : prev === 'cover' ? 'fill' : 'contain'))
  }, [])

  useEffect(() => {
    if (!playbackMedia) return
    closeRef.current?.focus()
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') stopPlayback()
      if (e.key === ' ') {
        e.preventDefault()
        togglePlay()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [playbackMedia, stopPlayback, togglePlay])

  const resetControlsTimer = useCallback(() => {
    setControlsVisible(true)
    if (hideControlsTimer.current) clearTimeout(hideControlsTimer.current)
    hideControlsTimer.current = setTimeout(() => setControlsVisible(false), 3200)
  }, [])

  // Genuinely timer-driven, not a derivable value: shows the controls
  // immediately and (re)arms the auto-hide timeout on mount — an external-
  // timer synchronization effect is exactly what useEffect is for, not
  // something to compute inline.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    resetControlsTimer()
    return () => {
      if (hideControlsTimer.current) clearTimeout(hideControlsTimer.current)
    }
  }, [resetControlsTimer])

  const handleEnded = useCallback(() => {
    setPlaying(false)
    if (!playbackMedia || markedWatchedRef.current) return
    markedWatchedRef.current = true
    const api = window.api?.mediaHub
    if (!api) return
    api.tracking
      .markWatched({
        item: mediaItemToTrackablePayload(playbackMedia),
        playback: { season: playbackMedia.seasonNumber, episode: playbackMedia.episodeNumber }
      })
      .catch(() => {})
  }, [playbackMedia])

  const handleSeek = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const video = videoRef.current
      if (!video || !duration || !Number.isFinite(duration)) return
      const rect = event.currentTarget.getBoundingClientRect()
      const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
      const target = fraction * duration

      if (!result?.compatibility) {
        // Direct/proxied playback (playback.ts forwards real Range/
        // Content-Length headers) genuinely supports currentTime seeks.
        video.currentTime = target
        setCurrentTime(target)
        return
      }

      // Compatibility-mode's stream is a single non-Range HTTP connection
      // (see streamStartOffsetRef's comment above) — setting currentTime
      // directly can't actually reach an unbuffered position. The only
      // real way to "seek" is what selectTrack() already does for track
      // changes: restart the ffmpeg transcode from a new -ss position and
      // load the fresh stream it produces.
      streamStartOffsetRef.current = target
      setCurrentTime(target)
      window.api?.mediaHub?.playback
        .selectTracks({ ...activeSelectionRef.current, startTime: target })
        .then((response) => {
          if (!response) return
          activeSelectionRef.current = response.selection
          setResult((prev) => (prev ? { ...prev, ...response.selection, url: response.url } : prev))
          setTracks(response.tracks)
        })
        .catch((error: unknown) => {
          pushNotification({
            tone: 'error',
            message: error instanceof Error ? error.message : 'Could not seek.'
          })
        })
    },
    [duration, result, pushNotification]
  )

  async function selectTrack(kindKey: 'audio' | 'subtitle', ordinal: number) {
    if (!playbackMedia) return
    const video = videoRef.current
    // During compatibility mode, video.currentTime is relative to the
    // current transcode segment (see streamStartOffsetRef's definition
    // above) — the absolute position is the segment's own start offset
    // plus that relative time, not the relative time alone.
    const startTime = streamStartOffsetRef.current + (video?.currentTime ?? 0)
    try {
      const response = await window.api?.mediaHub?.playback.selectTracks({
        audio: kindKey === 'audio' ? ordinal : undefined,
        subtitle: kindKey === 'subtitle' ? ordinal : undefined,
        startTime
      })
      if (!response) return
      streamStartOffsetRef.current = startTime
      activeSelectionRef.current = response.selection
      // A new transcode session means a new stream URL — the <video> src
      // effect below picks this up and reloads from `startTime`.
      setResult((prev) => (prev ? { ...prev, ...response.selection, url: response.url } : prev))
      setTracks(response.tracks)
    } catch (error) {
      pushNotification({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not change tracks.'
      })
    }
    setOpenMenu(null)
  }

  async function searchSubtitles() {
    if (!playbackMedia) return
    setOpenMenu('subtitles')
    if (subtitleResults) return
    try {
      const results = await window.api?.mediaHub?.subtitles.search(
        { id: playbackMedia.id, type: kind, title: playbackMedia.title },
        { season: playbackMedia.seasonNumber, episode: playbackMedia.episodeNumber }
      )
      setSubtitleResults(results ?? [])
    } catch {
      setSubtitleResults([])
    }
  }

  async function applySubtitle(fileId: number) {
    try {
      const applied = await window.api?.mediaHub?.subtitles.apply(fileId, false)
      if (applied?.vttDataUrl) setActiveSubtitleTrackUrl(applied.vttDataUrl)
    } catch (error) {
      pushNotification({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not load that subtitle.'
      })
    }
    setOpenMenu(null)
  }

  const audioTracks = useMemo<MediaTrack[]>(() => tracks?.audio ?? [], [tracks])
  const subtitleTracks = useMemo<MediaTrack[]>(() => tracks?.subtitle ?? [], [tracks])
  const fitModeLabel = { contain: 'Fit', cover: 'Fill', fill: 'Stretch' }[fitMode]

  // AppStateContext's startPlayback only ever sets playbackMedia once a
  // real PlaybackResult is already resolved — see that function's own
  // comment. There's no in-between "resolving"/"no-source"/"error" state
  // for this component to render at all anymore; if playbackMedia is set,
  // result is too.
  if (!playbackMedia || !result) return null

  return (
    <div
      ref={containerRef}
      className={styles.playback}
      role="dialog"
      aria-modal="true"
      aria-label="Playback"
      onMouseMove={resetControlsTimer}
      onDoubleClick={handleToggleFullscreen}
    >
      {/* Caption track is added dynamically once a subtitle is applied
          (see activeSubtitleTrackUrl) — not present on initial render. */}
      <video
        ref={videoRef}
        className={styles.videoSurface}
        style={{ objectFit: fitMode }}
        src={result.url}
        autoPlay
        onClick={togglePlay}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) =>
          setCurrentTime(streamStartOffsetRef.current + e.currentTarget.currentTime)
        }
        onLoadedMetadata={(e) => {
          // Compatibility mode's fragmented-stream duration climbs as
          // more of the stream arrives rather than being known upfront
          // (early loadedmetadata events under-report it) — prefer the
          // real total ffprobe already found, falling back to the
          // element's own value for direct/proxied playback where it's
          // accurate from the start.
          const probed = tracks?.durationSeconds
          setDuration(probed && Number.isFinite(probed) ? probed : e.currentTarget.duration)
        }}
        onEnded={handleEnded}
        onVolumeChange={(e) => setVolume(e.currentTarget.volume)}
      >
        {activeSubtitleTrackUrl && (
          <track kind="subtitles" src={activeSubtitleTrackUrl} default label="Subtitles" />
        )}
      </video>

      <button
        ref={closeRef}
        type="button"
        className={styles.playbackClose}
        onClick={stopPlayback}
        aria-label="Close playback"
      >
        <Icon name="x" size={17} />
      </button>

      <div
        className={`${styles.playerControls} ${!controlsVisible ? styles.playerControlsHidden : ''}`}
      >
        {result.autoReason && <span className={styles.playerAutoNote}>{result.autoReason}</span>}

          <div className={styles.playerScrubberTrack} onClick={handleSeek}>
            <div
              className={styles.playerScrubberFill}
              style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }}
            />
          </div>

          <div className={styles.playerButtonRow}>
            <button
              type="button"
              className={styles.playerIconButton}
              onClick={togglePlay}
              aria-label={playing ? 'Pause' : 'Play'}
            >
              <Icon name={playing ? 'pause' : 'play'} size={15} />
            </button>

            <span className={styles.playerTimeLabel}>
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>

            <span className={styles.playerTitleLabel}>
              {playbackMedia.title}
              {playbackMedia.episodeTitle ? ` — ${playbackMedia.episodeTitle}` : ''}
            </span>

            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              className={styles.playerVolumeRange}
              onChange={(e) => {
                const v = Number(e.target.value)
                setVolume(v)
                if (videoRef.current) videoRef.current.volume = v
              }}
              aria-label="Volume"
            />

            {audioTracks.length > 1 && (
              <div className={styles.playerMenuWrap}>
                <button
                  type="button"
                  className={styles.playerIconButton}
                  onClick={() => setOpenMenu(openMenu === 'audio' ? null : 'audio')}
                  aria-label="Audio track"
                >
                  <Icon name="waveform" size={15} />
                </button>
                {openMenu === 'audio' && (
                  <div className={styles.playerMenu}>
                    <div className={styles.playerMenuHeading}>Audio</div>
                    {audioTracks.map((t) => (
                      <button
                        key={t.ordinal}
                        type="button"
                        className={`${styles.playerMenuItem} ${t.default ? styles.playerMenuItemActive : ''}`}
                        onClick={() => selectTrack('audio', t.ordinal)}
                      >
                        {t.label}
                        {t.default && <Icon name="check" size={12} />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className={styles.playerMenuWrap}>
              <button
                type="button"
                className={styles.playerIconButton}
                onClick={() => (openMenu === 'subtitles' ? setOpenMenu(null) : searchSubtitles())}
                aria-label="Subtitles"
              >
                <Icon name="info" size={15} />
              </button>
              {openMenu === 'subtitles' && (
                <div className={styles.playerMenu}>
                  <div className={styles.playerMenuHeading}>Embedded</div>
                  {subtitleTracks.length === 0 && (
                    <span className={styles.playerMenuItem}>None</span>
                  )}
                  {subtitleTracks.map((t) => (
                    <button
                      key={t.ordinal}
                      type="button"
                      className={styles.playerMenuItem}
                      onClick={() => selectTrack('subtitle', t.ordinal)}
                    >
                      {t.label}
                    </button>
                  ))}
                  <div className={styles.playerMenuHeading}>OpenSubtitles</div>
                  {subtitleResults === null && (
                    <span className={styles.playerMenuItem}>Searching…</span>
                  )}
                  {subtitleResults?.length === 0 && (
                    <span className={styles.playerMenuItem}>No results</span>
                  )}
                  {subtitleResults?.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className={styles.playerMenuItem}
                      onClick={() => applySubtitle(s.fileId)}
                    >
                      {s.language.toUpperCase()} — {s.releaseName || s.fileName}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              type="button"
              className={`${styles.playerIconButton} ${styles.playerFitButton}`}
              onClick={cycleFitMode}
              aria-label={`Picture fit: ${fitModeLabel} (click to change)`}
              title={`Picture fit: ${fitModeLabel}`}
            >
              <Icon name="aspect-ratio" size={15} />
              <span className={styles.playerFitLabel}>{fitModeLabel}</span>
            </button>

            <button
              type="button"
              className={styles.playerIconButton}
              onClick={handleToggleFullscreen}
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            >
              <Icon name={isFullscreen ? 'collapse' : 'expand'} size={15} />
            </button>
          </div>
        </div>
      </div>
  )
}

