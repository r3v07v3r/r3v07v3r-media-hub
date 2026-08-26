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
import { PlayerSessionRail } from '@renderer/components/party/PlayerSessionRail'
import {
  AUTOPLAY_NEXT_COUNTDOWN_SECONDS,
  MAX_PLAYER_VOLUME,
  PLAYER_VOLUME_STEP
} from '@shared/media-hub/player'
import type { NextEpisodeRef } from '@shared/media-hub/nextEpisode'
import type { PlayerSessionMedia } from '@shared/media-hub/player'
import type { SubtitleResult } from '@shared/media-hub/types'
import {
  DEFAULT_SUBTITLE_STYLE,
  isSubtitleStyleDefault,
  SUBTITLE_COLORS,
  SUBTITLE_POSITION_MAX,
  SUBTITLE_POSITION_MIN,
  SUBTITLE_SCALE_MAX,
  SUBTITLE_SCALE_MIN,
  SUBTITLE_SCALE_STEP,
  type SubtitleStyle
} from '@shared/media-hub/subtitleStyle'
import {
  DEFAULT_VIDEO_FIT,
  VIDEO_FIT_MODES,
  videoFitDescription,
  videoFitLabel
} from '@shared/media-hub/videoFit'
import {
  DEFAULT_VIDEO_PICTURE,
  VIDEO_PICTURE_CONTROLS,
  VIDEO_PICTURE_MAX,
  VIDEO_PICTURE_MIN
} from '@shared/media-hub/videoPicture'
import styles from './PlayerOverlayWindow.module.css'

const CONTROLS_IDLE_MS = 3200
/** Scrub previews are bucketed so hovering along the bar reuses frames instead
 *  of asking for one per pixel — each is a separate short-lived process. */
const THUMBNAIL_BUCKET_SECONDS = 5
const SCRUB_PREVIEW_WIDTH = 160
/** How far a manual subtitle offset can be nudged per press. mpv applies it
 *  live; there is no re-render of anything. */
const SUBTITLE_DELAY_STEP = 0.25

type Menu = 'audio' | 'subtitles' | 'fit' | 'picture' | 'playback' | 'chapters' | null

/** What the speed control offers. 1 is listed with the rest rather than being
 *  a separate "reset", because it is the value people come back to and hunting
 *  for a differently-shaped control to do it is worse. */
const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const

/** How far one press moves the audio offset. Matches the subtitle step above:
 *  the two corrections are the same job in opposite directions and should not
 *  behave differently. */
const AUDIO_DELAY_STEP = 0.05

/** Sleep-timer choices, in minutes. `0` is the end-of-episode option, which is
 *  not a duration at all — it waits for the file rather than the clock. */
const SLEEP_OPTIONS = [
  { minutes: 15, label: '15 minutes' },
  { minutes: 30, label: '30 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 0, label: 'End of episode' }
] as const

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
  const [roomRailOpen, setRoomRailOpen] = useState(false)
  const [subtitleResults, setSubtitleResults] = useState<SubtitleResult[] | null>(null)
  const [subtitleSearchError, setSubtitleSearchError] = useState<string | null>(null)
  const [pendingSubtitleId, setPendingSubtitleId] = useState<string | null>(null)
  const [subtitleDelay, setSubtitleDelay] = useState(0)
  const [preview, setPreview] = useState<{ x: number; time: number; url: string | null } | null>(
    null
  )
  const [countdown, setCountdown] = useState(AUTOPLAY_NEXT_COUNTDOWN_SECONDS)
  const [countdownFor, setCountdownFor] = useState<string | null>(null)
  // A wall-clock deadline, or 'episode' for "stop when this file ends".
  const [sleep, setSleep] = useState<{ at: number } | 'episode' | null>(null)
  const [sleepRemaining, setSleepRemaining] = useState(0)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const paused = state.paused ?? true
  const timePos = state.timePos ?? 0
  const duration = state.duration ?? session?.tracks?.durationSeconds ?? 0
  const audioTracks = session?.tracks?.audio ?? []
  const subtitleTracks = session?.tracks?.subtitle ?? []
  const buffering = state.bufferingForCache === true
  const volume = state.volume ?? 1
  // Shown as a percentage rather than the 0-2 the command speaks: the number
  // only means anything against the 100% that is the film's own level, which
  // is the line the slider can now be pushed past.
  const volumePercent = Math.round(volume * 100)
  const volumeBoosted = volume > 1
  const media = session?.media ?? null
  // Main owns this, and pushes it — the overlay never guesses, so the label
  // stays right across a title change or a remount.
  const fitMode = state.fitMode ?? DEFAULT_VIDEO_FIT
  const pictureSettings = {
    brightness: state.brightness ?? DEFAULT_VIDEO_PICTURE.brightness,
    contrast: state.contrast ?? DEFAULT_VIDEO_PICTURE.contrast,
    saturation: state.saturation ?? DEFAULT_VIDEO_PICTURE.saturation,
    gamma: state.gamma ?? DEFAULT_VIDEO_PICTURE.gamma
  }
  const pictureAdjusted = Object.values(pictureSettings).some((value) => value !== 0)
  const speed = state.speed ?? 1
  const chapters = state.chapters ?? []
  const currentChapter = state.chapter ?? -1
  const audioDelay = state.audioDelay ?? 0
  const subtitleStyle = session?.settings.subtitleStyle ?? DEFAULT_SUBTITLE_STYLE
  const subtitleStyled = !isSubtitleStyleDefault(subtitleStyle)
  const nightMode = session?.settings.nightModeEnabled === true

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
    volume,
    onMarkWatched: useCallback(() => ui({ type: 'mark-watched' }), [ui])
  })

  // The post-play card, derived rather than stored — there is no state here
  // that main is not already the authority on, and storing a copy would only
  // create a second one to keep in step.
  //
  // A party FOLLOWER never gets the card, whatever the setting says: the host
  // owns what plays in a room, and a follower that advanced on its own would
  // leave the party watching two different episodes with no way back. The host
  // does get it — startPartyPlayback on the main-window side announces whatever
  // it starts, so the room follows along exactly as it would from a click.
  const autoplay: NextEpisodeRef | null =
    state.eofReached === true &&
    !party.following &&
    // A sleep timer set to "end of episode" is somebody saying this is the
    // last one. Offering the next one anyway — and starting it on a countdown
    // — would be the app overruling that.
    sleep !== 'episode' &&
    session?.settings.autoplayNextEnabled !== false
      ? (session?.nextUp ?? null)
      : null
  const autoplayKey = autoplay ? `${media?.id ?? ''}:${autoplay.season}:${autoplay.episode}` : null

  // Restart the countdown when the card changes subject, adjusted during render
  // rather than in an effect — the same pattern SidebarNavigation uses for its
  // route-keyed state, and the reason this component holds a key alongside the
  // number instead of resetting it from a useEffect.
  if (countdownFor !== autoplayKey) {
    setCountdownFor(autoplayKey)
    setCountdown(AUTOPLAY_NEXT_COUNTDOWN_SECONDS)
  }

  // Which card has already been acted on. Needed because `eofReached` stays
  // true until the next file actually opens: without it, the tick below would
  // keep re-raising play-next for the whole time the next episode spends
  // resolving, which is a stream search rather than an instant cut.
  const [startedNextFor, setStartedNextFor] = useState<string | null>(null)
  const startNext = useCallback(
    (next: NextEpisodeRef, key: string) => {
      setStartedNextFor(key)
      tracking.savePositionNow()
      ui({ type: 'play-next', season: next.season, episode: next.episode })
    },
    [tracking, ui]
  )
  const startingNext = autoplayKey !== null && startedNextFor === autoplayKey

  // One tick per second while the card is up. The last tick starts the episode
  // rather than writing a zero somebody would see, and it goes through the same
  // call the Play now button makes, so there is only one way in.
  //
  // Both the count and the start happen INSIDE the timeout, never in the effect
  // body — an effect that sets state synchronously cascades a render, and the
  // countdown would run its whole length in a single frame.
  useEffect(() => {
    if (!autoplay || !autoplayKey || startingNext) return
    const timer = setTimeout(() => {
      if (countdown <= 1) startNext(autoplay, autoplayKey)
      else setCountdown(countdown - 1)
    }, 1000)
    return () => clearTimeout(timer)
  }, [autoplay, autoplayKey, countdown, startingNext, startNext])

  // A menu or an in-flight sync has to pin the controls open — otherwise the
  // idle timer closes the surface out from under someone mid-selection.
  // The post-play card pins too. The window is click-through whenever the
  // controls are hidden, so a card whose buttons appeared without this would
  // pass every click straight through to mpv — visible, and unpressable.
  const pinned = menu !== null || party.syncing || roomRailOpen || autoplay !== null

  const revealControls = useCallback(() => {
    setControlsVisible(true)
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(() => setControlsVisible(false), CONTROLS_IDLE_MS)
  }, [])

  // Arms the idle countdown when this window is actually put on screen, not
  // when this tree mounts.
  //
  // The two are far apart: the window is created before `loadfile` so its
  // renderer has the load to boot in, and main does not show it until there is
  // a film to sit over (playerWindow.ts's revealPlayerOverlay). A countdown
  // armed at mount therefore ran during the wait, so on any cold stream slower
  // than CONTROLS_IDLE_MS the controls had already faded by the moment they
  // first became visible — the film starts and there is no bar.
  //
  // Main has to report it, tempting as `document.visibilityState` is. Measured
  // on Electron 39 with this window's exact webPreferences: it reads 'visible'
  // for the whole time the window is hidden and fires no visibilitychange when
  // the window is finally shown, so a renderer-side check would arm at mount
  // and never re-arm — the very bug it was meant to fix. See the
  // playerControlsShown channel for why the documented cure is not available.
  // A report that never arrives costs a bar that stays up until the mouse next
  // moves, which revealControls then arms in the ordinary way — degraded, not
  // stuck, which is the right way round for a control surface.
  useEffect(() => {
    const unsubscribe = window.api?.mediaHub?.player?.onControlsShown?.(revealControls)
    return () => {
      unsubscribe?.()
      if (idleTimer.current) clearTimeout(idleTimer.current)
    }
  }, [revealControls])

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

  // Volume nudges work off an optimistic ref rather than reading `volume`
  // straight from state: mpv's property observations reach this window on a
  // 120ms flush timer (playerBridge's STATE_FLUSH_MS), so a held key would
  // read the same stale value several presses running and crawl. Writing the
  // ref as each command goes out makes presses compound; the mirror effect
  // puts mpv's own answer back whenever one lands, so nothing drifts.
  const volumeRef = useRef(volume)
  useEffect(() => {
    volumeRef.current = volume
  }, [volume])

  // Not gated on `locked` like seeking and pausing are: volume is this
  // machine's business, not the party's, so there is no host to defer to.
  const nudgeVolume = useCallback(
    (delta: number) => {
      const next = Math.min(MAX_PLAYER_VOLUME, Math.max(0, volumeRef.current + delta))
      // Rounded because 0.05 steps do not land on clean multiples in binary
      // floating point, and this number is shown as a percentage.
      const rounded = Math.round(next * 100) / 100
      volumeRef.current = rounded
      void command({ type: 'set-volume', volume: rounded })
    },
    [command]
  )

  // The other half of the volume decision main begins by resetting every
  // title to 100%: one being RESUMED comes back at the volume it was left
  // at, since a title left partway through is exactly the one whose boost
  // was set for a reason. No bookmark, or one with no volume recorded, and
  // there is nothing to apply — the reset already stands.
  useEffect(() => {
    if (tracking.resumeVolume === null) return
    void command({ type: 'set-volume', volume: tracking.resumeVolume })
    tracking.consumeResumeVolume()
  }, [tracking, command])

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

  // Saves BEFORE raising the stop, not only via usePlayerTracking's teardown
  // effect — same explicit call the pause and end-of-file paths above already
  // make, and here it also fixes an ordering problem. `stop-playback` reaches
  // the main window through main (two hops), where it clears playbackMedia;
  // the detail page re-reads its resume bookmarks off that transition to draw
  // each episode tile's "N min left" sliver. Starting the one-hop save first
  // means it has landed by the time that re-read is even issued, so closing
  // partway through an episode leaves a tile that reflects it. Teardown's own
  // save stays as the backstop for the paths that never come through here
  // (the window being destroyed outright).
  // How far through, kept somewhere a callback can read it WITHOUT depending
  // on it. closePlayer needs the figure at the arbitrary moment somebody
  // presses the button; closing over `timePos` instead would give it a new
  // identity roughly eight times a second, and the sleep timer that depends on
  // it would clear its own timeout before it could ever fire.
  const progressRef = useRef(0)
  useEffect(() => {
    progressRef.current = duration > 0 ? Math.round((timePos / duration) * 100) : 0
  }, [timePos, duration])

  const closePlayer = useCallback(() => {
    tracking.savePositionNow()
    // The one transition the scrobble effect above cannot observe: the window
    // is going away, so there is no later render to notice it in.
    if (media) {
      ui({ type: 'scrobble', action: 'stop', progress: progressRef.current, media })
    }
    ui({ type: 'stop-playback', watched: tracking.markedWatched() })
  }, [tracking, ui, media])

  /** Applies a partial change over the style in force, as one command. */
  const applySubtitleStyle = useCallback(
    (patch: Partial<SubtitleStyle>) => {
      void command({ type: 'set-subtitle-style', style: { ...subtitleStyle, ...patch } })
    },
    [command, subtitleStyle]
  )

  // Tell the tracking services what is happening, on TRANSITIONS only.
  //
  // Simkl's scrobble endpoints are a state machine — start, pause, stop — not
  // a heartbeat, so this fires when the playing state or the title changes and
  // at no other time. A call per tick would be a request every few seconds for
  // the length of a film, for a service that wants three.
  //
  // A party FOLLOWER still scrobbles: they really are watching it, whoever
  // pressed play. What they must not do is act on the transition themselves,
  // and this does not — it only reports.
  const scrobbleState = useRef<{
    key: string
    playing: boolean
    media: PlayerSessionMedia
  } | null>(null)
  useEffect(() => {
    if (!media) return
    const key = `${media.id}:${media.seasonNumber ?? ''}:${media.episodeNumber ?? ''}`
    const previous = scrobbleState.current
    const playing = !paused && state.eofReached !== true
    if (previous?.key === key && previous.playing === playing) return

    // Progress is read off the live clock rather than stored, because the only
    // consumer of it is Simkl deciding whether a `stop` was "finished" or
    // "gave up" — and that is a question about where the person actually was.
    const progress = duration > 0 ? Math.round((timePos / duration) * 100) : 0

    // A title change stops the OUTGOING one before starting the new one, or
    // Simkl is left holding a scrobble for something that is no longer
    // playing. The stop carries the PREVIOUS media, not the current one —
    // that is the whole reason the identity travels with the event.
    if (previous && previous.key !== key) {
      ui({ type: 'scrobble', action: 'stop', progress, media: previous.media })
    }
    scrobbleState.current = { key, playing, media }
    ui({ type: 'scrobble', action: playing ? 'start' : 'pause', progress, media })
    // timePos and duration are deliberately NOT dependencies: they change
    // every tick, and depending on them would turn this into the heartbeat it
    // exists not to be. They are read at the moment a transition happens,
    // which is the only moment their value is wanted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media, paused, state.eofReached, ui])

  // The sleep timer's clock. One tick per second while a deadline is set,
  // reaching zero by stopping playback through exactly the path the close
  // button uses — so the position is saved and the watch status settled the
  // same way, rather than the window simply vanishing.
  //
  // Both the count and the stop happen INSIDE the timeout, never in the effect
  // body: an effect that sets state synchronously cascades a render, and the
  // whole hour would elapse in one frame.
  useEffect(() => {
    if (sleep === null || sleep === 'episode') return
    const timer = setTimeout(() => {
      const remaining = Math.max(0, Math.round((sleep.at - Date.now()) / 1000))
      if (remaining <= 0) {
        setSleep(null)
        closePlayer()
        return
      }
      setSleepRemaining(remaining)
    }, 250)
    return () => clearTimeout(timer)
  }, [sleep, sleepRemaining, closePlayer])

  // The other half of the timer: "end of episode" waits for the file rather
  // than the clock. Autoplay is already suppressed for this case above, so
  // reaching the end here means there is genuinely nothing more to do.
  useEffect(() => {
    if (sleep !== 'episode' || state.eofReached !== true) return
    const timer = setTimeout(() => {
      setSleep(null)
      closePlayer()
    }, 0)
    return () => clearTimeout(timer)
  }, [sleep, state.eofReached, closePlayer])

  /** Arms, re-arms or cancels the timer. `minutes` of 0 is end-of-episode. */
  const setSleepTimer = useCallback((minutes: number | null) => {
    if (minutes === null) {
      setSleep(null)
      setSleepRemaining(0)
      return
    }
    if (minutes === 0) {
      setSleep('episode')
      setSleepRemaining(0)
      return
    }
    setSleep({ at: Date.now() + minutes * 60_000 })
    setSleepRemaining(minutes * 60)
  }, [])

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
    const unsubscribe = api.onInput(({ action }) => {
      const current = forwardedInput.current
      if (action === 'toggle-pause') current.party.togglePlay()
      else if (action === 'toggle-fullscreen') current.toggleFullscreen()
    })
    // Main forwards nothing until this says so, and goes back to driving mpv
    // itself once it is retracted — otherwise input would be handed to a window
    // that has not mounted this listener yet, or no longer has it, and vanish.
    // Retracting it also covers a React tree that unmounts on an error, since
    // effect cleanups still run in that case.
    ui({ type: 'set-input-ready', ready: true })
    return () => {
      ui({ type: 'set-input-ready', ready: false })
      unsubscribe()
    }
  }, [ui])

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
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        nudgeVolume(PLAYER_VOLUME_STEP)
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        nudgeVolume(-PLAYER_VOLUME_STEP)
      } else if (event.key === 'f') {
        toggleFullscreen()
      } else if (event.key === 'Escape') {
        handleEscape()
      }
      revealControls()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [party, seekTo, timePos, nudgeVolume, toggleFullscreen, handleEscape, revealControls])

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
      <PlayerSessionRail open={roomRailOpen} onClose={() => setRoomRailOpen(false)} />
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

      {/* Post-play. Outside the controls bar for the same reason the skip
          button is: it has to be usable without moving the mouse first, and it
          outlives the bar's idle fade. */}
      {autoplay && autoplayKey && (
        <div className={styles.postPlay} role="dialog" aria-label="Up next">
          <p className={styles.postPlayLabel}>Up next</p>
          <p className={styles.postPlayTitle}>
            {`S${String(autoplay.season).padStart(2, '0')}E${String(autoplay.episode).padStart(2, '0')}`}
            {autoplay.title ? ` — ${autoplay.title}` : ''}
          </p>
          <div className={styles.postPlayActions}>
            <button
              type="button"
              className={styles.postPlayPrimary}
              disabled={startingNext}
              onClick={() => startNext(autoplay, autoplayKey)}
            >
              {/* The card stays up while the next episode resolves — it is a
                  stream search, not an instant cut — so it says what is
                  happening instead of offering a button that has already been
                  pressed. */}
              {startingNext ? 'Starting…' : `Play now (${countdown})`}
            </button>
            <button type="button" className={styles.postPlaySecondary} onClick={closePlayer}>
              Stop
            </button>
          </div>
        </div>
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

          {/* Runs past 100% deliberately. Everything above it is mpv amplifying
              in software, which is the only fix on this side for a film mixed
              far quieter than the rest of the system — the ceiling is
              MAX_PLAYER_VOLUME, and mpv is launched knowing the same number. */}
          <div className={styles.volumeWrap}>
            <input
              type="range"
              min={0}
              max={MAX_PLAYER_VOLUME}
              step={0.05}
              value={volume}
              className={`${styles.volume} ${volumeBoosted ? styles.volumeBoosted : ''}`}
              onChange={(event) =>
                void command({ type: 'set-volume', volume: Number(event.target.value) })
              }
              aria-label="Volume"
              aria-valuetext={`${volumePercent}%`}
              title={
                volumeBoosted
                  ? `Volume ${volumePercent}% — amplified above the source level`
                  : `Volume ${volumePercent}%`
              }
            />
            {/* Fixed width, always present: a readout that appeared only once
                boosted would shove every control to its right along mid-drag. */}
            <span className={styles.volumeReadout}>{volumePercent}%</span>
          </div>

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

                {/* How they LOOK, as opposed to which track and when. Four
                    controls, applied as one command: the four are a single
                    visual decision, and pushing them at mpv separately makes
                    the subtitle flicker through intermediate states. */}
                <div className={styles.menuHeading}>Appearance</div>
                <label className={styles.styleControl}>
                  <span>
                    Size<output>{subtitleStyle.scale.toFixed(1)}×</output>
                  </span>
                  <input
                    type="range"
                    min={SUBTITLE_SCALE_MIN}
                    max={SUBTITLE_SCALE_MAX}
                    step={SUBTITLE_SCALE_STEP}
                    value={subtitleStyle.scale}
                    aria-label="Subtitle size"
                    onChange={(event) => applySubtitleStyle({ scale: Number(event.target.value) })}
                  />
                </label>
                <label className={styles.styleControl}>
                  <span>
                    Height<output>{subtitleStyle.position}</output>
                  </span>
                  <input
                    type="range"
                    min={SUBTITLE_POSITION_MIN}
                    max={SUBTITLE_POSITION_MAX}
                    step={1}
                    value={subtitleStyle.position}
                    aria-label="Subtitle position"
                    onChange={(event) =>
                      applySubtitleStyle({ position: Number(event.target.value) })
                    }
                  />
                </label>
                <div className={styles.colorRow}>
                  {SUBTITLE_COLORS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={`${styles.colorSwatch} ${
                        subtitleStyle.color === option.value ? styles.colorSwatchOn : ''
                      }`}
                      style={{ background: option.hex }}
                      aria-label={`${option.label} subtitles`}
                      aria-pressed={subtitleStyle.color === option.value}
                      onClick={() => applySubtitleStyle({ color: option.value })}
                    />
                  ))}
                  <button
                    type="button"
                    className={styles.styleToggle}
                    aria-pressed={subtitleStyle.background}
                    onClick={() => applySubtitleStyle({ background: !subtitleStyle.background })}
                  >
                    Backdrop{subtitleStyle.background ? ' ✓' : ''}
                  </button>
                  <button
                    type="button"
                    className={styles.styleToggle}
                    disabled={!subtitleStyled}
                    onClick={() => applySubtitleStyle(DEFAULT_SUBTITLE_STYLE)}
                  >
                    Reset
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

          {/* Speed, audio sync and the sleep timer — three things that are
              about how this session plays rather than about the picture, so
              they share one menu instead of adding three buttons to a bar
              that is already full. */}
          <div className={styles.menuWrap}>
            <button
              type="button"
              className={styles.button}
              onClick={() => setMenu(menu === 'playback' ? null : 'playback')}
              aria-expanded={menu === 'playback'}
            >
              {speed === 1 ? 'Playback' : `${speed}×`}
              {sleep !== null ? ' · ⏱' : ''}
              {nightMode ? ' · ☾' : ''}
            </button>
            {menu === 'playback' && (
              <div className={`${styles.menu} ${styles.playbackMenu}`}>
                <div className={styles.menuHeading}>Speed</div>
                {/* Hidden outright while following a host. Speed is the lever
                    partySync's drift correction pulls (see usePartySync), so a
                    manual choice here would be fighting the sync law and losing
                    — better not to offer it than to offer it and have it snap
                    back a second later. */}
                {party.following ? (
                  <p className={styles.menuNote}>The host sets the speed in a room.</p>
                ) : (
                  <div className={styles.speedRow}>
                    {SPEED_OPTIONS.map((option) => (
                      <button
                        key={option}
                        type="button"
                        className={`${styles.speedButton} ${speed === option ? styles.speedButtonOn : ''}`}
                        aria-pressed={speed === option}
                        onClick={() => void command({ type: 'set-speed', speed: option })}
                      >
                        {option}&times;
                      </button>
                    ))}
                  </div>
                )}

                <div className={styles.menuHeading}>Audio sync</div>
                <div className={styles.nudgeRow}>
                  <button
                    type="button"
                    className={styles.nudgeButton}
                    aria-label="Audio earlier"
                    onClick={() =>
                      void command({
                        type: 'set-audio-delay',
                        seconds: Number((audioDelay - AUDIO_DELAY_STEP).toFixed(2))
                      })
                    }
                  >
                    &minus;
                  </button>
                  <output className={styles.nudgeValue}>
                    {audioDelay === 0
                      ? 'In sync'
                      : `${audioDelay > 0 ? '+' : ''}${audioDelay.toFixed(2)}s`}
                  </output>
                  <button
                    type="button"
                    className={styles.nudgeButton}
                    aria-label="Audio later"
                    onClick={() =>
                      void command({
                        type: 'set-audio-delay',
                        seconds: Number((audioDelay + AUDIO_DELAY_STEP).toFixed(2))
                      })
                    }
                  >
                    +
                  </button>
                  <button
                    type="button"
                    className={styles.nudgeReset}
                    disabled={audioDelay === 0}
                    onClick={() => void command({ type: 'set-audio-delay', seconds: 0 })}
                  >
                    Reset
                  </button>
                </div>

                <div className={styles.menuHeading}>Sound</div>
                <button
                  type="button"
                  className={styles.menuItem}
                  aria-pressed={nightMode}
                  onClick={() => void command({ type: 'set-night-mode', enabled: !nightMode })}
                >
                  Night mode{nightMode ? ' ✓' : ''}
                  <span className={styles.menuItemNote}>
                    Evens out quiet dialogue against a loud score.
                  </span>
                </button>

                <div className={styles.menuHeading}>Sleep timer</div>
                {SLEEP_OPTIONS.map((option) => {
                  const active =
                    option.minutes === 0
                      ? sleep === 'episode'
                      : sleep !== null && sleep !== 'episode'
                  return (
                    <button
                      key={option.label}
                      type="button"
                      className={styles.menuItem}
                      onClick={() => setSleepTimer(option.minutes)}
                    >
                      {option.label}
                      {option.minutes === 0 && sleep === 'episode' ? ' ✓' : ''}
                      {option.minutes !== 0 && active
                        ? ` · ${formatTime(sleepRemaining)} left`
                        : ''}
                    </button>
                  )
                })}
                {sleep !== null && (
                  <button
                    type="button"
                    className={styles.menuItem}
                    onClick={() => setSleepTimer(null)}
                  >
                    Cancel timer
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Absent rather than disabled when a release carries no chapter
              marks, which is most of them — a permanently greyed-out button is
              a worse answer than no button. */}
          {chapters.length > 0 && (
            <div className={styles.menuWrap}>
              <button
                type="button"
                className={styles.button}
                onClick={() => setMenu(menu === 'chapters' ? null : 'chapters')}
                aria-expanded={menu === 'chapters'}
                disabled={locked}
              >
                Chapters
              </button>
              {menu === 'chapters' && (
                <div className={`${styles.menu} ${styles.chapterMenu}`}>
                  {chapters.map((chapter, index) => (
                    <button
                      key={`${index}-${chapter.time}`}
                      type="button"
                      className={styles.menuItem}
                      onClick={() => {
                        void command({ type: 'set-chapter', index })
                        setMenu(null)
                      }}
                    >
                      {chapter.title || `Chapter ${index + 1}`}
                      {index === currentChapter ? ' ✓' : ''}
                      <span className={styles.menuItemNote}>{formatTime(chapter.time)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

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

          <div className={styles.menuWrap}>
            <button
              type="button"
              className={styles.button}
              onClick={() => setMenu(menu === 'picture' ? null : 'picture')}
              aria-expanded={menu === 'picture'}
            >
              Picture{pictureAdjusted ? ' •' : ''}
            </button>
            {menu === 'picture' && (
              <div className={`${styles.menu} ${styles.pictureMenu}`}>
                <div className={styles.menuHeading}>Picture</div>
                {VIDEO_PICTURE_CONTROLS.map(({ control, label }) => (
                  <label key={control} className={styles.pictureControl}>
                    <span>
                      {label}
                      <output>{pictureSettings[control]}</output>
                    </span>
                    <input
                      type="range"
                      min={VIDEO_PICTURE_MIN}
                      max={VIDEO_PICTURE_MAX}
                      step={1}
                      value={pictureSettings[control]}
                      onChange={(event) =>
                        void command({
                          type: 'set-picture-control',
                          control,
                          value: Number(event.target.value)
                        })
                      }
                      aria-label={label}
                    />
                  </label>
                ))}
                <button
                  type="button"
                  className={styles.resetPictureButton}
                  onClick={() => void command({ type: 'reset-picture-controls' })}
                  disabled={!pictureAdjusted}
                >
                  Reset picture
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            className={styles.button}
            onClick={() => setRoomRailOpen((open) => !open)}
            aria-pressed={roomRailOpen}
            aria-label="Open room rail"
          >
            Room
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
