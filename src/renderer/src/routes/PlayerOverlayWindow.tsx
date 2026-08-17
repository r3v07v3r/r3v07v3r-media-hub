// Root of the player-overlay window — the transparent control surface layered
// over mpv's native video output.
//
// The page background MUST stay fully transparent: mpv renders underneath this
// window, not behind a video element inside it. Anything opaque here is a black
// rectangle over the film.
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
import { usePartySync } from '@renderer/hooks/usePartySync'
import { usePlayerTracking } from '@renderer/hooks/usePlayerTracking'
import type { SubtitleResult } from '@shared/media-hub/types'
import {
  DEFAULT_VIDEO_FIT,
  VIDEO_FIT_MODES,
  videoFitDescription,
  videoFitLabel
} from '@shared/media-hub/videoFit'
import styles from './PlayerOverlayWindow.module.css'

const CONTROLS_IDLE_MS = 3200
/** Scrub previews are bucketed so hovering along the bar reuses frames instead
 *  of asking for one per pixel — each is a separate short-lived process. */
const THUMBNAIL_BUCKET_SECONDS = 5
const SCRUB_PREVIEW_WIDTH = 160
/** How far a manual subtitle offset can be nudged per press. mpv applies it
 *  live; there is no re-render of anything. */
const SUBTITLE_DELAY_STEP = 0.25

type Menu = 'audio' | 'subtitles' | 'fit' | null

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
  const [menu, setMenu] = useState<Menu>(null)
  const [subtitleResults, setSubtitleResults] = useState<SubtitleResult[] | null>(null)
  const [subtitleSearchError, setSubtitleSearchError] = useState<string | null>(null)
  const [pendingSubtitleId, setPendingSubtitleId] = useState<string | null>(null)
  const [subtitleDelay, setSubtitleDelay] = useState(0)
  const [preview, setPreview] = useState<{ x: number; time: number; url: string | null } | null>(
    null
  )
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const paused = state.paused ?? true
  const timePos = state.timePos ?? 0
  const duration = state.duration ?? session?.tracks?.durationSeconds ?? 0
  const audioTracks = session?.tracks?.audio ?? []
  const subtitleTracks = session?.tracks?.subtitle ?? []
  const buffering = state.bufferingForCache === true
  const volume = state.volume ?? 1
  const media = session?.media ?? null
  // Main owns this, and pushes it — the overlay never guesses, so the label
  // stays right across a title change or a remount.
  const fitMode = state.fitMode ?? DEFAULT_VIDEO_FIT

  const party = usePartySync({
    timePos,
    duration,
    paused,
    cacheAheadSeconds: state.cacheAheadSeconds ?? 0,
    bufferSeconds: session?.settings.bufferSeconds ?? 3,
    command
  })
  const locked = party.following && !party.canControl

  const tracking = usePlayerTracking({
    media,
    timePos,
    duration,
    playing: !paused,
    onMarkWatched: useCallback(() => ui({ type: 'mark-watched' }), [ui])
  })

  // A menu or an in-flight sync has to pin the controls open — otherwise the
  // idle timer closes the surface out from under someone mid-selection.
  const pinned = menu !== null || party.syncing

  const revealControls = useCallback(() => {
    setControlsVisible(true)
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(() => setControlsVisible(false), CONTROLS_IDLE_MS)
  }, [])

  // Arms the initial idle countdown only — `controlsVisible` already starts
  // true, so calling revealControls() here would set state it is already in.
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

  // Every seek goes through the party-aware path: a host-coordinated handshake
  // when hosting, a plain broadcast otherwise, a no-op when locked.
  const seekTo = useCallback(
    (seconds: number) => {
      if (locked) return
      party.seekTo(Math.max(0, Math.min(seconds, duration || seconds)))
    },
    [locked, party, duration]
  )

  // Apply the saved resume position once the title is playing. Seeks are
  // in-place now, so this no longer waits for a buffering gate the way the
  // <video> path had to. Never applied while following a party — the host owns
  // the position there.
  useEffect(() => {
    if (tracking.resumeSeconds === null || !duration || party.following) return
    seekTo(tracking.resumeSeconds)
    tracking.consumeResume()
  }, [tracking, duration, party.following, seekTo])

  // Saving on pause matters more than it looks: closing the player is the most
  // common way a session ends, and people very often pause first.
  const wasPausedRef = useRef(paused)
  useEffect(() => {
    if (paused && !wasPausedRef.current) tracking.savePositionNow()
    wasPausedRef.current = paused
  }, [paused, tracking])

  // Natural end of file. mpv reports it as a property rather than an element
  // event, but the consequence is the same as the old onEnded.
  useEffect(() => {
    if (state.eofReached !== true) return
    tracking.savePositionNow()
    ui({ type: 'mark-watched' })
  }, [state.eofReached, tracking, ui])

  const closePlayer = useCallback(() => {
    ui({ type: 'stop-playback', watched: tracking.markedWatched() })
  }, [tracking, ui])

  // A terminal failure. The old handler retried once on decode/network errors
  // because the live ffmpeg-to-<video> relay produced transient decode failures
  // a restart usually cleared. There is no relay and no restart now, so an
  // error here is real and is reported once.
  useEffect(() => {
    if (!state.error) return
    ui({ tone: 'error', type: 'notify', message: `Playback failed: ${state.error}` })
    closePlayer()
  }, [state.error, ui, closePlayer])

  // Real OS-level BrowserWindow fullscreen of the MAIN window, not the DOM
  // Fullscreen API and not this window — mpv's video window and this overlay
  // are both sized to the main window's content area, so it is the one that has
  // to change shape for anything to happen (see appIpc.ts).
  const [fullScreen, setFullScreen] = useState(false)
  const toggleFullscreen = useCallback(() => {
    window.api?.mediaHub?.window
      ?.toggleFullscreen()
      .then((result) => setFullScreen(result.fullScreen))
      .catch(() => {})
  }, [])

  // Read once on mount, then follow. Reading matters because the overlay is
  // created mid-session and can open into an already-fullscreen window;
  // following matters because Escape and F11 change the state without asking
  // this button first.
  useEffect(() => {
    const api = window.api?.mediaHub?.window
    if (!api) return
    api
      .isFullscreen()
      .then((result) => setFullScreen(result.fullScreen))
      .catch(() => {})
    return api.onFullscreenChange(({ fullScreen: next }) => setFullScreen(next))
  }, [])

  // Escape leaves fullscreen first, and only closes the title when there was no
  // fullscreen to leave — so one press is never both.
  //
  // The decision is asked of main rather than read from `fullScreen` above.
  // That state is accurate within a frame or two, but Escape is the key someone
  // presses when something has already gone wrong, and answering from a stale
  // cache could make it *enter* fullscreen instead. Anything that goes wrong on
  // the way still closes the player, because a dead Escape is the one outcome
  // that must not happen — see playerBridge's r3-stop for the same rule applied
  // when mpv's window holds the focus instead of this one.
  const handleEscape = useCallback(() => {
    const api = window.api?.mediaHub?.window
    if (!api) {
      closePlayer()
      return
    }
    api
      .exitFullscreen()
      .then(({ wasFullScreen }) => {
        if (!wasFullScreen) closePlayer()
      })
      .catch(() => closePlayer())
  }, [closePlayer])

  // Click the picture to play/pause; double-click it for fullscreen.
  //
  // The two gestures share a button, so the first click of a double-click is
  // indistinguishable from a single one until the second either arrives or
  // doesn't. This toggles immediately and lets the double-click handler put
  // playback back, rather than holding the toggle until a double-click is ruled
  // out. Deferring is the more obvious design and it cannot be made correct
  // here: the deadline it needs is the platform's double-click interval, which
  // is user-configurable (500ms by default on Windows) and not readable from a
  // renderer. Any fixed guess shorter than it fires the toggle before the
  // second click lands — so a plain double-click both pauses the film and goes
  // fullscreen — and any guess long enough to be safe is a visible lag on every
  // single click, which is the whole point of clicking the picture.
  //
  // Toggling twice leaves playback exactly where it started, costs one brief
  // pause during a gesture that is about to redraw the whole window anyway, and
  // stays coherent for a watch party: both toggles broadcast, so everyone ends
  // up in the same state rather than the host alone.
  //
  // All of this covers clicks while the controls are up. When they are hidden
  // the window is click-through and the click reaches mpv instead, which is
  // what its MBTN_LEFT binding is for (see mpv.ts's bindSafetyKeys).
  const pausedBeforeClick = useRef(paused)
  const handleSurfaceClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      // The picture only. Clicks on the controls bar bubble up to here too, and
      // the play button toggling twice per press is not a subtle bug. Locked
      // party followers need no check — togglePlay already ignores them.
      if (event.target !== event.currentTarget) return
      // The second click of a double-click, which the handler below owns.
      if (event.detail > 1) return
      // Recorded before the toggle, so the undo below restores a state that was
      // read when nothing was in flight.
      pausedBeforeClick.current = paused
      party.togglePlay()
    },
    [party, paused]
  )

  // Same picture-only rule — this handler has always been on the surface, so
  // before that rule an impatient double-press on any control threw the window
  // into fullscreen.
  const handleSurfaceDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return
      // Undoes the toggle the first click of this pair already made: the
      // gesture was "fullscreen", not "pause, then fullscreen".
      //
      // setPaused, not another togglePlay. A toggle would have to work out what
      // to tell the rest of a watch party from the last observed `paused`, and
      // that reading may still be the pre-click one this soon after — in which
      // case peers are sent the action that already happened and stay paused
      // while this player resumes. Naming the target state cannot go stale.
      party.setPaused(pausedBeforeClick.current)
      toggleFullscreen()
    },
    [party, toggleFullscreen]
  )

  // Input that reached mpv's window instead of this one, because the controls
  // were hidden and the overlay was click-through (see mpv.ts's bindSafetyKeys
  // for which inputs, and why they cannot be applied in main). Routed through
  // the same handlers as a click here, so the two can never drift apart on who
  // is allowed to pause or on what the party is told.
  //
  // The handlers are read from a ref rather than listed as dependencies:
  // usePartySync returns a fresh object every render, and re-subscribing an IPC
  // channel that often for a callback that changes nothing would be waste.
  // Deliberately NOT revealing the controls here, tempting as it is.
  //
  // Revealing them makes this window interactive, and that hands mouse
  // ownership back from mpv within a few milliseconds — long before the second
  // click of a double-click arrives. That click would then land on this window
  // instead, where it is the *first* click as far as Chromium's click counting
  // is concerned, so mpv never reports MBTN_LEFT_DBL and React never sees a
  // pair: the double-click-to-fullscreen gesture disappears exactly in the
  // state these bindings exist to serve. Both clicks have to stay with the
  // window that saw the first one, so the controls stay put and any mouse
  // movement brings them back as it always has.
  const forwardedInput = useRef({ party, toggleFullscreen })
  useEffect(() => {
    forwardedInput.current = { party, toggleFullscreen }
  })
  useEffect(() => {
    const api = window.api?.mediaHub?.player
    if (!api?.onInput) return
    return api.onInput(({ action }) => {
      const current = forwardedInput.current
      if (action === 'toggle-pause') current.party.togglePlay()
      else if (action === 'toggle-fullscreen') current.toggleFullscreen()
    })
  }, [])

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === ' ') {
        event.preventDefault()
        party.togglePlay()
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        seekTo(timePos + 15)
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        seekTo(timePos - 15)
      } else if (event.key === 'f') {
        toggleFullscreen()
      } else if (event.key === 'Escape') {
        handleEscape()
      }
      revealControls()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [party, seekTo, timePos, toggleFullscreen, handleEscape, revealControls])

  // --- Skip intro/credits (anime only) -------------------------------------
  // Needs a real duration: Aniskip matches submissions by proximity to episode
  // length and 400s without it.
  const skipTimesRef = useRef(false)
  const [skipTimes, setSkipTimes] = useState<{
    intro?: { start: number; end: number }
    credits?: { start: number; end: number }
  } | null>(null)
  useEffect(() => {
    if (skipTimesRef.current || !media || media.kind !== 'anime' || !duration) return
    skipTimesRef.current = true
    window.api?.mediaHub?.playback
      .skipTimes(media.id, media.episodeNumber ?? 1, Math.round(duration))
      .then((times) => setSkipTimes(times ?? null))
      .catch(() => {})
  }, [media, duration])
  // Derived, not stored: which skip window we are inside is a pure function of
  // the current position and the fetched times, and time-pos changes several
  // times a second — holding it in state would mean a setState per tick.
  const skipWindow = ((): { label: string; end: number } | null => {
    const inWindow = (w?: { start: number; end: number }): boolean =>
      Boolean(w && timePos >= w.start && timePos < w.end)
    if (inWindow(skipTimes?.intro)) return { label: 'Skip intro', end: skipTimes!.intro!.end }
    if (inWindow(skipTimes?.credits)) return { label: 'Skip credits', end: skipTimes!.credits!.end }
    return null
  })()

  // --- Scrub-bar thumbnail previews ----------------------------------------
  const thumbnailCache = useRef(new Map<number, string | null>())
  const scrubRequest = useRef(0)
  const scrubDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleScrubberHover = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!duration) return
      const rect = event.currentTarget.getBoundingClientRect()
      const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
      const time = fraction * duration
      const x = Math.max(
        SCRUB_PREVIEW_WIDTH / 2,
        Math.min(rect.width - SCRUB_PREVIEW_WIDTH / 2, event.clientX - rect.left)
      )
      const bucket = Math.floor(time / THUMBNAIL_BUCKET_SECONDS) * THUMBNAIL_BUCKET_SECONDS
      const cached = thumbnailCache.current.get(bucket)
      setPreview({ x, time, url: cached ?? null })
      if (cached !== undefined) return
      if (scrubDebounce.current) clearTimeout(scrubDebounce.current)
      const requestId = ++scrubRequest.current
      // Debounced because each capture is its own short-lived mpv process, and
      // it competes with playback for StreamCache's single fill cursor.
      scrubDebounce.current = setTimeout(() => {
        window.api?.mediaHub?.playback
          .thumbnail(bucket)
          .then((url) => {
            thumbnailCache.current.set(bucket, url)
            if (scrubRequest.current !== requestId) return
            setPreview((current) => (current ? { ...current, url } : current))
          })
          .catch(() => {})
      }, 250)
    },
    [duration]
  )
  useEffect(
    () => () => {
      if (scrubDebounce.current) clearTimeout(scrubDebounce.current)
    },
    []
  )

  // --- Subtitles ------------------------------------------------------------
  const searchSubtitles = useCallback(async () => {
    setMenu('subtitles')
    if (!media || subtitleResults) return
    setSubtitleSearchError(null)
    try {
      const results = await window.api?.mediaHub?.subtitles.search(
        { id: media.id, type: media.kind, title: media.title },
        { season: media.seasonNumber, episode: media.episodeNumber }
      )
      setSubtitleResults(results ?? [])
    } catch (error) {
      // Only successful searches are cached, so a failure retries next time the
      // menu opens — the "connect a provider in Settings" recovery loop.
      setSubtitleSearchError(error instanceof Error ? error.message : 'Subtitle search failed.')
    }
  }, [media, subtitleResults])

  const applyOnlineSubtitle = useCallback(
    async (subtitle: SubtitleResult) => {
      setPendingSubtitleId(subtitle.id)
      try {
        // Writes the .srt and hands it to mpv via sub-add — no conversion, no
        // <track> element, no transcode restart.
        await window.api?.mediaHub?.subtitles.apply({
          provider: subtitle.provider,
          fileId: subtitle.fileId,
          downloadPath: subtitle.downloadPath
        })
      } catch (error) {
        ui({
          tone: 'error',
          type: 'notify',
          message: error instanceof Error ? error.message : 'Could not load that subtitle.'
        })
      } finally {
        setPendingSubtitleId(null)
        setMenu(null)
      }
    },
    [ui]
  )

  const nudgeSubtitleDelay = useCallback(
    (deltaSeconds: number) => {
      const next = Math.round((subtitleDelay + deltaSeconds) * 100) / 100
      setSubtitleDelay(next)
      void command({ type: 'set-subtitle-delay', seconds: next })
    },
    [subtitleDelay, command]
  )

  // --- Friends activity -----------------------------------------------------
  // Main decides whether this actually goes out (sharing is opt-in). Cleared on
  // unmount so closing the player takes the activity down with it.
  const activityRef = useRef({ timePos, paused })
  useEffect(() => {
    activityRef.current = { timePos, paused }
  }, [timePos, paused])
  useEffect(() => {
    if (!media) return
    const publish = (): void => {
      window.api?.mediaHub?.friends
        ?.setActivity({
          mediaId: media.id,
          kind: media.kind,
          title: media.title,
          poster: media.posterUrl,
          position: activityRef.current.timePos,
          paused: activityRef.current.paused
        })
        .catch(() => {})
    }
    publish()
    const timer = setInterval(publish, 20_000)
    return () => {
      clearInterval(timer)
      window.api?.mediaHub?.friends?.setActivity(null).catch(() => {})
    }
  }, [media])

  const activeSubtitleOrdinal = state.subtitleOrdinal ?? -1

  return (
    <div
      className={styles.surface}
      onMouseMove={revealControls}
      onClick={handleSurfaceClick}
      onDoubleClick={handleSurfaceDoubleClick}
    >
      {buffering && (
        <div className={styles.buffering} aria-live="polite">
          <span className={styles.spinner} aria-hidden="true" />
          <span>Buffering…</span>
        </div>
      )}

      {party.waitingNames && party.syncing && (
        <div className={styles.syncWait} aria-live="polite">
          {party.waitingNames.length
            ? `Waiting for ${party.waitingNames.join(', ')} to finish buffering…`
            : 'Starting together…'}
        </div>
      )}

      {/* Rendered outside the controls bar so it stays clickable without
          needing the mouse moved first. */}
      {skipWindow && !locked && (
        <button type="button" className={styles.skipButton} onClick={() => seekTo(skipWindow.end)}>
          {skipWindow.label}
        </button>
      )}

      <div
        className={`${styles.controls} ${controlsVisible || pinned ? '' : styles.controlsHidden}`}
      >
        <div className={styles.title}>
          {media?.title ?? ''}
          {media?.episodeTitle ? ` — ${media.episodeTitle}` : ''}
          {party.notice && (
            <span className={styles.syncBadge}>
              {party.notice === 'synced'
                ? 'In sync'
                : party.notice === 'correcting'
                  ? 'Correcting sync…'
                  : 'Waiting for host sync…'}
            </span>
          )}
          {locked && <span className={styles.syncBadge}>Host is controlling playback</span>}
        </div>

        <div
          className={`${styles.scrubber} ${locked ? styles.scrubberLocked : ''}`}
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(timePos)}
          tabIndex={0}
          onMouseMove={handleScrubberHover}
          onMouseLeave={() => setPreview(null)}
          onClick={(event) => {
            if (!duration) return
            const rect = event.currentTarget.getBoundingClientRect()
            seekTo(((event.clientX - rect.left) / rect.width) * duration)
          }}
        >
          <div
            className={styles.scrubberFill}
            style={{ width: duration ? `${(timePos / duration) * 100}%` : '0%' }}
          />
          {preview && (
            <div className={styles.preview} style={{ left: `${preview.x}px` }}>
              {preview.url ? (
                <img src={preview.url} alt="" width={SCRUB_PREVIEW_WIDTH} />
              ) : (
                <div className={styles.previewPlaceholder} />
              )}
              <span>{formatTime(preview.time)}</span>
            </div>
          )}
        </div>

        <div className={styles.row}>
          <button
            type="button"
            className={styles.button}
            onClick={party.togglePlay}
            disabled={locked}
            aria-label={paused ? 'Play' : 'Pause'}
          >
            {paused ? '▶' : '❚❚'}
          </button>

          <span className={styles.time}>
            {formatTime(timePos)} / {formatTime(duration)}
          </span>

          <div className={styles.spacer} />

          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            className={styles.volume}
            onChange={(event) =>
              void command({ type: 'set-volume', volume: Number(event.target.value) })
            }
            aria-label="Volume"
          />

          {/* Shown whenever the title has any audio at all, not only when it
              has a choice. Hiding it for single-track files makes "this film has
              one track" look identical to "the track list is broken", which is
              exactly the doubt it caused. With one track the menu simply lists
              that one, ticked. */}
          {audioTracks.length > 0 && (
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
              onClick={() => (menu === 'subtitles' ? setMenu(null) : void searchSubtitles())}
            >
              Subtitles
            </button>
            {menu === 'subtitles' && (
              <div className={styles.menu}>
                <div className={styles.menuHeading}>Embedded</div>
                <button
                  type="button"
                  className={styles.menuItem}
                  onClick={() => {
                    void command({ type: 'set-subtitle-track', ordinal: -1 })
                    setMenu(null)
                  }}
                >
                  Off{activeSubtitleOrdinal === -1 ? ' ✓' : ''}
                </button>
                {/* Every embedded track, with no codec filtering and no cache
                    gate. Both existed only because the old pipeline demuxed the
                    whole file to WebVTT: image formats (PGS/VobSub) had no OCR
                    step and were permanently greyed out. mpv renders them. */}
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
                    {activeSubtitleOrdinal === track.ordinal ? ' ✓' : ''}
                  </button>
                ))}

                <div className={styles.menuHeading}>Timing</div>
                <div className={styles.delayRow}>
                  <button
                    type="button"
                    className={styles.button}
                    onClick={() => nudgeSubtitleDelay(-SUBTITLE_DELAY_STEP)}
                  >
                    −
                  </button>
                  <span className={styles.time}>{subtitleDelay.toFixed(2)}s</span>
                  <button
                    type="button"
                    className={styles.button}
                    onClick={() => nudgeSubtitleDelay(SUBTITLE_DELAY_STEP)}
                  >
                    +
                  </button>
                </div>

                <div className={styles.menuHeading}>Online subtitles</div>
                {subtitleSearchError && (
                  <span className={styles.menuNote}>{subtitleSearchError}</span>
                )}
                {!subtitleSearchError && subtitleResults === null && (
                  <span className={styles.menuNote}>Searching…</span>
                )}
                {!subtitleSearchError && subtitleResults?.length === 0 && (
                  <span className={styles.menuNote}>No results</span>
                )}
                {subtitleResults?.map((subtitle) => (
                  <button
                    key={subtitle.id}
                    type="button"
                    className={styles.menuItem}
                    onClick={() => void applyOnlineSubtitle(subtitle)}
                    disabled={pendingSubtitleId !== null}
                  >
                    {pendingSubtitleId === subtitle.id
                      ? 'Loading…'
                      : `${subtitle.language.toUpperCase()} — ${
                          subtitle.releaseName || subtitle.fileName
                        } · ${subtitle.provider === 'subdl' ? 'SubDL' : 'OpenSubtitles'}`}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Fit/fill. mpv applies both underlying properties to the frame
              already on screen, so every option here is instant — there is no
              reload and no reseek behind any of them. */}
          <div className={styles.menuWrap}>
            <button
              type="button"
              className={styles.button}
              onClick={() => setMenu(menu === 'fit' ? null : 'fit')}
              aria-label={`Picture size: ${videoFitLabel(fitMode)}`}
            >
              {videoFitLabel(fitMode)}
            </button>
            {menu === 'fit' && (
              <div className={styles.menu}>
                {VIDEO_FIT_MODES.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={styles.menuItem}
                    onClick={() => {
                      void command({ type: 'set-fit-mode', mode })
                      setMenu(null)
                    }}
                  >
                    {videoFitLabel(mode)}
                    {fitMode === mode ? ' ✓' : ''}
                    <span className={styles.menuItemNote}>{videoFitDescription(mode)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            type="button"
            className={styles.button}
            onClick={() => ui({ type: 'set-party-panel-open', open: true })}
            aria-label="Watch party"
          >
            Party
          </button>

          <button
            type="button"
            className={styles.button}
            onClick={toggleFullscreen}
            aria-label={fullScreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            title={fullScreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
          >
            {fullScreen ? '⤡' : '⤢'}
          </button>

          <button
            type="button"
            className={styles.button}
            onClick={closePlayer}
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
