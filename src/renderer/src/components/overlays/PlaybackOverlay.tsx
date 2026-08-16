'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import { mediaItemToTrackablePayload } from '@renderer/lib/mediaHub/adapters'
import { decodeVttDataUrl, encodeVttDataUrl, shiftVttCues } from '@renderer/lib/mediaHub/vttShift'
import { getPlaybackBufferSeconds } from '@shared/media-hub/playbackBuffer'
import {
  expectedHostPosition,
  isSampleUsable,
  syncCorrection,
  type HostPositionSample
} from '@shared/media-hub/partySync'
import type {
  MediaTrack,
  PlaybackPositionResult,
  PlaybackSelection,
  SkipTimes,
  SubtitleResult
} from '@shared/media-hub/types'
import styles from './Overlays.module.css'

// Coarse enough that dragging across the scrubber only spawns a handful of
// real ffmpeg captures rather than one per pixel of mouse movement — see
// handleScrubberHover's own comment for why that matters.
const THUMBNAIL_BUCKET_SECONDS = 5
// Matches captureFrame's own `-vf scale=160:-1` in vlc.ts — the CSS box is
// sized off this same constant so the two never drift out of sync.
const SCRUB_PREVIEW_WIDTH = 160
// How often the resume bookmark is re-saved while playing — frequent
// enough that a crash or force-quit (which skips every other save point:
// pause, close, natural end) still leaves something recent to come back
// to, infrequent enough that it's a trivial background cost.
const RESUME_SAVE_INTERVAL_MS = 20_000

// Mirrors vlc.ts's own TEXT_SUBTITLE_CODECS (main-process-only, so not
// importable here directly — see this codebase's established "small local
// duplication over a cross-module shared util" convention). Image-based
// codecs (PGS/VobSub/DVB) can't be extracted as WebVTT text at all, so
// those embedded tracks are shown but disabled rather than offered as if
// they'd work.
const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'])

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
 * What to actually tell someone when the <video> element gives up.
 *
 * Every failure used to read as the same sentence, which sent people
 * hunting for a different audio track even when the audio was fine and the
 * stream had simply stopped arriving — the two have completely different
 * fixes. MediaError's code is the only thing that distinguishes them from
 * the renderer's side, so it's what picks the wording (the raw
 * `MEDIA_ERR_*`/pipeline text stays in the console for diagnosis).
 */
function playbackErrorMessage(error: MediaError | null | undefined): string {
  switch (error?.code) {
    case 2: // MEDIA_ERR_NETWORK
      return 'Playback stopped because the stream stopped arriving. The source may have dropped the connection — try playing again.'
    case 3: // MEDIA_ERR_DECODE
      return "Playback stopped because this file's audio or video couldn't be decoded. Try playing again and picking a different audio track."
    case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED
      return "Playback stopped because this file's format isn't supported by the player. Try a different source for this title."
    default:
      return 'Playback stopped unexpectedly and could not continue. Try playing again — a different audio track may avoid the issue.'
  }
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
    refreshWatchStatus,
    pushNotification,
    mediaHubSettings,
    partyStatus,
    partyPendingSeek,
    consumePartyPendingSeek,
    partyPanelOpen,
    setPartyPanelOpen,
    partyHostCode
  } = useAppState()
  const isPartyHost = Boolean(partyStatus?.inParty && partyStatus.role === 'host')
  // While following, local play/pause/seek controls are disabled (see the
  // control-row buttons and handleSeek/togglePlay's own early-returns
  // below) — the wire protocol only host-gates `seek` server-side (see
  // watchParty.ts's party:playback-action handler), so this UI-layer lock
  // is what actually keeps a follower from fighting the host's control.
  const followingParty = Boolean(partyStatus?.inParty && partyStatus.role === 'client')
  // Host-toggled (see PartyPanel's "Anyone can control playback" switch):
  // when on, a follower's own play/pause/seek stop being locked out and
  // start broadcasting too, same as the host's always have.
  const canControl = Boolean(followingParty && partyStatus?.allowMemberControl)
  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  // Starts false, not true: playback is no longer autoPlay-driven — see
  // the buffering-gate effect below, which calls .play() itself only once
  // enough of the stream has actually buffered ahead.
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [openMenu, setOpenMenu] = useState<'audio' | 'subtitles' | 'quality' | null>(null)
  // Guards against clicking a second track while the first is still
  // restarting ffmpeg (a real crash found live: the second request's
  // stop() kills the first one's not-yet-ready process, which then
  // reports itself as a failure) — see vlc.ts's generation tracking for
  // the same protection at the backend layer too.
  const [trackChangeBusy, setTrackChangeBusy] = useState(false)
  // Which audio ordinal selectTrack() is currently applying — display only
  // (trackChangeBusy alone already gates re-entrancy correctly). Without
  // this the audio menu gave zero visible feedback while a track change
  // was in flight (an ffmpeg restart in compatibility mode routinely takes
  // several seconds, longer on a slow connection) — a real, live-reported
  // "it says loading but nothing happens" complaint that was really just
  // "no indication anything is happening at all," not a hang.
  const [pendingAudioOrdinal, setPendingAudioOrdinal] = useState<number | null>(null)
  // Mirrors activeSelectionRef.current.upscaleHeight for rendering purposes
  // (the ref itself doesn't trigger a re-render on change) — 0 means "off".
  const [appliedUpscaleHeight, setAppliedUpscaleHeight] = useState(0)
  // True only while an explicit quality-menu pick is in flight — separate
  // from bufferingReady (which covers the actual restart's own re-buffer,
  // shown automatically once the new stream URL lands) so the button shows
  // "Applying…" the moment it's clicked, before the restart itself even
  // starts producing a response to react to.
  const [applyingQuality, setApplyingQuality] = useState(false)
  const [subtitleResults, setSubtitleResults] = useState<SubtitleResult[] | null>(null)
  // Which search result's id applySubtitle() is currently downloading and
  // converting — display only, but a real gap without it: unlike the
  // embedded-subtitle path (extractingSubtitleOrdinal) and audio track
  // switch (pendingAudioOrdinal), this menu previously gave zero feedback
  // while a download+SRT-to-VTT conversion was in flight, AND had no
  // re-entrancy guard — a second click (same item or a different one)
  // while the first was still running fired a second concurrent apply. A
  // live-reported "subtitles say loading but never change" complaint was,
  // at least in part, this: no visible sign anything was happening at all.
  //
  // Keyed on the result's `id` rather than its fileId now that results come
  // from two providers: fileId is an OpenSubtitles-only concept and is 0 on
  // every SubDL row, so keying on it would have marked every SubDL row in
  // the menu as pending at once.
  const [pendingSubtitleId, setPendingSubtitleId] = useState<string | null>(null)
  const [activeSubtitleTrackUrl, setActiveSubtitleTrackUrl] = useState<string | null>(null)
  // Non-null while an embedded-subtitle extraction (extractSubtitleTrack,
  // see applyEmbeddedSubtitle) is in flight — separate from
  // trackChangeBusy, which is specifically about the ffmpeg-restart path
  // this doesn't use.
  const [extractingSubtitleOrdinal, setExtractingSubtitleOrdinal] = useState<number | null>(null)
  // Anime-only (see main/media-hub/aniskip.ts — no equivalent free source
  // exists for movies/series) — null until fetched, and stays null forever
  // when nothing was found for this episode, which is the normal case for
  // most episodes of most shows.
  const [skipTimes, setSkipTimes] = useState<SkipTimes | null>(null)
  // Guards the fetch to exactly once per title: `duration` can legitimately
  // change again later (a seek/track-change restart in compatibility mode
  // re-fires onLoadedMetadata), but the skip windows for this same episode
  // don't change, so only the FIRST time duration becomes known should
  // trigger the request.
  const skipTimesFetchedRef = useRef(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  // How the video fills the player frame: 'contain' (default, letterboxed,
  // nothing cropped), 'cover' (fills the frame, crops whatever overflows),
  // 'fill' (stretches to the frame, ignoring aspect ratio entirely).
  const [fitMode, setFitMode] = useState<'contain' | 'cover' | 'fill'>('contain')
  // True once enough of the stream has buffered ahead to actually start
  // playing — see the buffering-gate effect below. Resets on every new
  // segment (a fresh title, or a seek/track-change restart in
  // compatibility mode each begin their own fresh buffer-up).
  const [bufferingReady, setBufferingReady] = useState(false)
  const markedWatchedRef = useRef(false)
  // Resume position — where this title left off last time, fetched once
  // per title/episode (see the fetch effect below) and applied at most
  // once (resumeAppliedRef). currentPositionRef mirrors currentTime/
  // duration into a ref, not just the state that already exists for
  // them, specifically so the save-on-close effect's cleanup function can
  // read the LATEST value at the moment of teardown — a cleanup closure
  // only sees whatever was in scope when the effect last ran, which is
  // not necessarily the current position.
  const [resumePosition, setResumePosition] = useState<PlaybackPositionResult | null>(null)
  const resumeAppliedRef = useRef(false)
  // Whether a compatibility-mode decode (code 3) or network (code 2)
  // error has already triggered one automatic ffmpeg-restart retry for
  // this title/episode — see onError below. One shot only: a genuine,
  // unrecoverable stream defect (bad source track, real corruption, a
  // dead debrid link) must not loop forever restarting.
  const transcodeErrorRetriedRef = useRef(false)
  const currentPositionRef = useRef({ time: 0, duration: 0 })
  const hideControlsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // The ORIGINAL, un-shifted subtitle VTT text (absolute-timeline cue
  // times, exactly as OpenSubtitles/srtToVtt produced it) — kept
  // separately from activeSubtitleTrackUrl (which is always the CURRENTLY
  // shifted version actually applied to the <track>) so re-shifting after
  // another seek never compounds an earlier shift.
  const subtitleVttRef = useRef<string | null>(null)
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
  // Every ffmpeg restart (seek, track change, quality change) is a
  // multi-second round trip — spawn ffmpeg, wait for real bytes — with
  // nothing stopping a second one from being fired before the first
  // resolves (found live: clicking around the scrubber a few times while
  // hunting for a resume point). The main process already tracks its own
  // generation to stop a superseded restart from reporting a false
  // failure (see vlc.ts), but nothing on this side stopped a SUCCESSFUL
  // late response from an older, already-superseded request from landing
  // after the newer one and overwriting it — pointing the <video> element
  // at a URL for an ffmpeg process that had already been killed. That's
  // what made rapid seeking feel broken/unresponsive and could leave
  // playback stuck. Bumped by performSeek/selectTrack/applyUpscale right
  // before each restart request; their response handlers check it's still
  // current before applying anything.
  const transcodeGenerationRef = useRef(0)
  // Same stale-response problem as transcodeGenerationRef above, one layer
  // up: there are three independent ways a subtitle can get applied here
  // (the "Always have subtitles" auto-fetch on mount, a manual OpenSubtitles
  // pick, and an embedded-track extraction), and nothing stopped a slow
  // one's late result from landing after a faster, newer choice and
  // silently overwriting it — found live: extracting an embedded track can
  // take tens of seconds (no early exit — see applyEmbeddedSubtitle's own
  // comment), which is easily enough time to open the menu and pick a fast
  // OpenSubtitles result instead, only to have the abandoned embedded
  // extraction quietly replace it once it finally finishes. Same fix as
  // transcodeGenerationRef: bumped by all three writers before they start,
  // checked before any of them actually apply their result.
  const subtitleGenerationRef = useRef(0)

  // Scrubbing thumbnail preview — hovering the seek bar shows the frame at
  // that position. `time`/`x` update on every mousemove (cheap, just local
  // math); the actual thumbnail fetch (mediahub:playback:thumbnail, a real
  // ffmpeg -ss capture against the remote source — see vlc.ts's
  // captureFrame) is debounced and bucketed to whole THUMBNAIL_BUCKET_SECONDS
  // so dragging the mouse across the bar doesn't spawn one ffmpeg process
  // per pixel: TorBox and most debrid sources cap concurrent connections
  // per link, and this capture is a separate connection from whatever
  // playback (direct or compatibility-mode) is already using that same link.
  const [scrubPreview, setScrubPreview] = useState<{
    time: number
    x: number
    thumbnail: string | null
  } | null>(null)
  const thumbnailCacheRef = useRef<Map<number, string | null>>(new Map())
  const scrubDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Bumped on every hover move and on mouse-leave — lets a slow in-flight
  // capture recognize it's stale (the pointer moved to a different bucket,
  // or left the bar entirely) before it overwrites the preview with an
  // answer for a position nobody's hovering over anymore.
  const scrubRequestIdRef = useRef(0)

  // Synced-seek protocol (see shared/media-hub/types.ts's PartyPlaybackAction
  // for the wire messages) — when the host seeks, nobody actually resumes
  // playing until every party member has finished re-buffering at the new
  // position, so a slow connection doesn't leave everyone else watching
  // ahead of (or behind) it. `activeSyncRequestId` is non-null on BOTH the
  // host and every follower for the duration of one such wait.
  const [activeSyncRequestId, setActiveSyncRequestId] = useState<string | null>(null)
  // Null = no sync wait in progress. Empty array = waiting, but nobody
  // named yet (host hasn't computed the list, or it just emptied out).
  const [syncWaitingNames, setSyncWaitingNames] = useState<string[] | null>(null)
  // Small, honest feedback loop for followers: local controls stay instant,
  // while this reports whether the background clock is locked, gently
  // correcting drift, or waiting for a fresh host heartbeat.
  const [partySyncNotice, setPartySyncNotice] = useState<'synced' | 'correcting' | 'delayed'>(
    'delayed'
  )
  // Mirrors activeSyncRequestId for the OLD (non-party) buffering-gate
  // effect below to read without needing it in that effect's own
  // dependency array — adding it there would tear down and restart that
  // effect (losing its buffering progress) on every sync-state change,
  // not just on a genuine new segment.
  const activeSyncRequestIdRef = useRef<string | null>(null)
  useEffect(() => {
    activeSyncRequestIdRef.current = activeSyncRequestId
  }, [activeSyncRequestId])
  // Host only: who has reported their buffer ready for the CURRENT
  // requestId. A Set, not derived from partyStatus, because members can
  // report in before checkPartySeekReady has ever run.
  const syncReadyIdsRef = useRef<Set<string>>(new Set())
  const syncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const SYNC_TIMEOUT_MS = 20000
  // Heartbeat interval. Halved from 10s now that followers extrapolate
  // between beats rather than only correcting on arrival: each one is a
  // fresh fix that resets accumulated estimation error, and the payload is
  // a few dozen bytes.
  const HOST_HEARTBEAT_MS = 5000
  const SYNC_PLAY_DELAY_MS = 1500
  // Whether the buffer gate should actually START playing once it is
  // satisfied. True for a normal first load (that SHOULD auto-play); set to
  // false by a restart that happens while the video is paused — changing
  // audio track or quality tears down and restarts ffmpeg, and the gate
  // that follows would otherwise resume playback the person never asked
  // for. In a party that is worse than an annoyance: the host pauses to
  // talk, a follower switches audio language, and seconds later that
  // follower alone starts playing again — and a follower without
  // allowMemberControl cannot pause themselves back, because togglePlay
  // early-returns for them.
  const resumeAfterRestartRef = useRef(true)
  // Follower's last known fix on the host's position, stamped with the
  // LOCAL clock on arrival — see partySync.ts for why arrival time rather
  // than a host-sent wall clock.
  const hostFixRef = useRef<HostPositionSample | null>(null)

  const trackedMediaId = playbackMedia?.id
  const kind =
    playbackMedia?.mediaKind ?? (playbackMedia?.mediaType === 'series' ? 'series' : 'movie')
  const targetBufferSeconds = getPlaybackBufferSeconds(mediaHubSettings?.playbackBuffer)

  // Tears down whatever sync-seek wait is in progress, on both the host
  // (who owns the ready-tracking) and a follower (who just needed to know
  // whether one was active). Called when a wait resolves normally, times
  // out, or a fresh seek supersedes it.
  const clearSyncSeek = useCallback(() => {
    setActiveSyncRequestId(null)
    setSyncWaitingNames(null)
    syncReadyIdsRef.current = new Set()
    if (syncTimeoutRef.current) {
      clearTimeout(syncTimeoutRef.current)
      syncTimeoutRef.current = null
    }
  }, [])

  // Stop the backend's playback session (closes the proxy / kills any
  // ffmpeg transcoder) whenever the overlay closes, whether via the close
  // button, Escape, or the title changing out from under it.
  useEffect(() => {
    if (!playbackMedia) return
    // Presence for the synced-seek quorum. Being in a party and watching it
    // are different things, and the host can only wait on members who can
    // actually answer — see PartyMemberSummary.watching. Announced from
    // here specifically because this effect already brackets the exact
    // window in which a player exists to respond.
    window.api?.mediaHub?.party.playbackAction({ type: 'watching', watching: true }).catch(() => {})
    return () => {
      window.api?.mediaHub?.party
        .playbackAction({ type: 'watching', watching: false })
        .catch(() => {})
      // Deliberately NOT stopping the backend here. This cleanup runs
      // whenever the TITLE changes, not only when playback ends — the
      // overlay is keyed on playbackMedia.id — and by then the next
      // title's session already exists, because startPlayback creates it
      // before committing the new media. There is only ONE global backend
      // session, so stopping here tore down the session that had just
      // been created: direct playback 404'd instantly with "Playback
      // stopped unexpectedly", and compatibility mode failed on the first
      // seek with "No active media is available". It bit every party
      // title change, on the host and every follower alike.
      //
      // Teardown belongs to stopPlayback() in AppStateContext, which is
      // the single funnel for every real close (Escape, the close button,
      // the video error handler); app quit is handled separately by
      // main/index.ts's before-quit.
      clearSyncSeek()
    }
  }, [trackedMediaId, playbackMedia, clearSyncSeek])

  const togglePlay = useCallback(() => {
    if (followingParty && !canControl) return
    const video = videoRef.current
    if (!video) return
    const willPlay = video.paused
    if (willPlay) video.play().catch(() => {})
    else video.pause()
    if (isPartyHost || canControl) {
      window.api?.mediaHub?.party
        .playbackAction({ type: willPlay ? 'play' : 'pause' })
        .catch(() => {})
    }
  }, [followingParty, canControl, isPartyHost])

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

  // Re-derives the currently-applied subtitle track from the ORIGINAL vtt
  // text (subtitleVttRef) shifted by whatever streamStartOffsetRef is
  // right now — called every time that offset changes (seek or track
  // restart during compatibility mode), so the <track> src always matches
  // the segment currently playing instead of drifting further out of sync
  // with every subsequent seek.
  const applyShiftedSubtitle = useCallback(() => {
    if (!subtitleVttRef.current) return
    const shifted = shiftVttCues(subtitleVttRef.current, streamStartOffsetRef.current)
    setActiveSubtitleTrackUrl(encodeVttDataUrl(shifted))
  }, [])

  // Turns the subtitle track on. This is not belt-and-braces — without it
  // subtitles never appeared at all, no matter which source they came
  // from (OpenSubtitles, an extracted embedded track, or the automatic
  // "always have subtitles" fetch).
  //
  // The <track> below carries `default`, but that attribute is only ever
  // consulted by the media element's own resource-selection algorithm,
  // which runs when the element loads its media. Every <track> here is
  // added by React AFTER the <video> already exists, so that algorithm has
  // long since finished and the new TextTrack is created in mode
  // 'disabled' — parsed, cued, and invisible. Nothing else in this
  // renderer touches textTracks, so the cues had no way to ever be shown.
  //
  // Re-armed on `loadeddata` as well as on mount: compatibility mode swaps
  // the element's src on every seek and track change, and reloading the
  // media resets every text track back to 'disabled' again.
  //
  // Also re-armed on the textTracks list's own `addtrack` event — found
  // live: picking a subtitle mid-playback (no seek, no src change, so
  // `loadeddata` never fires again) raced the browser's own track
  // registration. Inserting the <track> element into the DOM doesn't add
  // it to video.textTracks synchronously; that happens via a queued task,
  // which this effect's synchronous `show()` call could easily run before.
  // The result: the call landed too early, found nothing to switch on, and
  // the subtitle silently never appeared — with nothing left to give it a
  // second try. `addtrack` fires exactly when the browser actually
  // registers the new TextTrack, so `show()` always gets a call after that
  // point regardless of timing.
  useEffect(() => {
    const video = videoRef.current
    if (!video || !activeSubtitleTrackUrl) return
    const show = (): void => {
      for (let i = 0; i < video.textTracks.length; i++) {
        const track = video.textTracks[i]
        if (track.kind === 'subtitles' || track.kind === 'captions') track.mode = 'showing'
      }
    }
    show()
    video.addEventListener('loadeddata', show)
    video.textTracks.addEventListener('addtrack', show)
    return () => {
      video.removeEventListener('loadeddata', show)
      video.textTracks.removeEventListener('addtrack', show)
    }
  }, [activeSubtitleTrackUrl, result?.url])

  useEffect(() => {
    if (!playbackMedia) return
    closeRef.current?.focus()
  }, [playbackMedia])

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

  // Shared by the 80%-progress effect below and handleEnded — whichever
  // fires first wins, markedWatchedRef stops the other from double-marking
  // (and from double-refreshing watch status).
  const markWatchedNow = useCallback(() => {
    if (!playbackMedia || markedWatchedRef.current) return
    markedWatchedRef.current = true
    const api = window.api?.mediaHub
    if (!api) return
    api.tracking
      .markWatched({
        item: mediaItemToTrackablePayload(playbackMedia),
        playback: { season: playbackMedia.seasonNumber, episode: playbackMedia.episodeNumber }
      })
      .then(() => refreshWatchStatus())
      .catch(() => {})
  }, [playbackMedia, refreshWatchStatus])

  // This component only remounts on a change to playbackMedia.id (see
  // GlobalOverlays.tsx's `key`), not on an episode change within the same
  // series, so switching episodes needs its own reset — otherwise the
  // PREVIOUS episode's resume position (and its "already applied" flag)
  // would still be sitting in state for the render or two before the
  // fetch effect below resolves a fresh one, and could get applied to the
  // wrong episode. React's own "reset state when a prop changes" pattern
  // (the same one MediaGrid.tsx's reveal-batch reset and
  // SidebarNavigation.tsx's moreOpenForPathname use) — done during
  // render, not in an effect, so there's no window where stale state is
  // visible even for one commit.
  const resumeKey = trackedMediaId
    ? `${trackedMediaId}:${playbackMedia?.seasonNumber ?? ''}:${playbackMedia?.episodeNumber ?? ''}`
    : null
  const [resumeKeyForReset, setResumeKeyForReset] = useState(resumeKey)
  if (resumeKeyForReset !== resumeKey) {
    setResumeKeyForReset(resumeKey)
    setResumePosition(null)
  }

  // Fetches the saved resume position for this exact title/episode.
  useEffect(() => {
    // Refs are only safe to mutate outside render (event handlers,
    // effects) — this is the ref half of the same per-episode reset the
    // render-time block above handles for resumePosition's own state.
    resumeAppliedRef.current = false
    transcodeErrorRetriedRef.current = false
    if (!playbackMedia) return
    const api = window.api?.mediaHub
    if (!api) return
    let cancelled = false
    api.tracking
      .getPosition({
        id: playbackMedia.id,
        playback: { season: playbackMedia.seasonNumber, episode: playbackMedia.episodeNumber }
      })
      .then((result) => {
        if (!cancelled) setResumePosition(result)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [trackedMediaId, playbackMedia?.seasonNumber, playbackMedia?.episodeNumber])

  useEffect(() => {
    currentPositionRef.current.duration = duration
  }, [duration])

  const savePositionNow = useCallback(() => {
    if (!playbackMedia) return
    const { time, duration: total } = currentPositionRef.current
    if (!Number.isFinite(time) || time <= 0) return
    window.api?.mediaHub?.tracking
      .savePosition({
        id: playbackMedia.id,
        playback: { season: playbackMedia.seasonNumber, episode: playbackMedia.episodeNumber },
        positionSeconds: time,
        durationSeconds: Number.isFinite(total) && total > 0 ? total : undefined
      })
      .catch(() => {})
  }, [playbackMedia])

  // Periodic, so a crash or force-quit — which skips every other save
  // point below — still leaves a recent bookmark rather than nothing.
  useEffect(() => {
    if (!playing) return
    const timer = setInterval(savePositionNow, RESUME_SAVE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [playing, savePositionNow])

  // The other save points: pausing, and closing/unmounting this overlay
  // however that happens (Escape, the close button, the video error
  // handler, or the title changing out from under it — see the teardown
  // effect above). A cleanup function, not an explicit call at each close
  // site, so every one of those paths is covered uniformly instead of
  // needing to remember to add this at each of them. Reads
  // currentPositionRef rather than the `currentTime`/`duration` state
  // directly — a cleanup closure only sees what was in scope when the
  // effect last (re)ran, and the ref is what stays current right up to
  // the moment of teardown.
  useEffect(() => {
    return () => savePositionNow()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately only re-armed per title/episode, see savePositionNow's own deps
  }, [trackedMediaId, playbackMedia?.seasonNumber, playbackMedia?.episodeNumber])

  const handleEnded = useCallback(() => {
    setPlaying(false)
    markWatchedNow()
    // Reads as "finished" territory to savePlaybackPosition's own >=90%
    // check (database.ts), which clears any bookmark rather than storing
    // one pointing at the last few seconds.
    savePositionNow()
  }, [markWatchedNow, savePositionNow])

  // Counts an episode watched at 80% rather than waiting for 'ended' — the
  // last stretch is often credits/recap, and marking here means
  // watchedIds/continueWatching (and therefore "next episode") are already
  // correct by the time someone closes this overlay, not only after
  // playback actually finishes.
  useEffect(() => {
    if (!duration || currentTime / duration < 0.8) return
    markWatchedNow()
  }, [currentTime, duration, markWatchedNow])

  // Shared by the scrubber click (handleSeek), the initial catch-up seek
  // when joining a party mid-title (partyPendingSeek), and the follower-
  // apply effect below for incoming seek/position corrections — all three
  // just need to land on an absolute target time, none of them care how
  // it got computed.
  const performSeek = useCallback(
    (target: number, options?: { onFailure?: () => void }) => {
      const video = videoRef.current
      if (!video) return

      // Any explicit seek supersedes an in-progress drift catch-up nudge
      // (see the 'position' correction branch below) — leaving a stale
      // speed adjustment running after landing on a fresh position would
      // just introduce new drift instead of fixing any.
      video.playbackRate = 1

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
      //
      // The offset/currentTime update below is optimistic — applied before
      // the restart is known to succeed, so the scrubber/time label feel
      // instant instead of waiting on a multi-second ffmpeg spin-up. On
      // failure this MUST be reverted, not left pointing at `target`: a
      // real, live-reported bug otherwise, where the scrubber kept
      // showing the new position forever while the <video> element kept
      // playing the untouched old stream (the restart never actually
      // swapped it in) — nothing else in the app could tell that apart
      // from a genuinely successful seek. In a solo session that was a
      // confusing display glitch; in a watch party it was worse — the
      // host's own periodic position broadcasts (see the 'position'
      // correction branch below) kept reporting this false position as
      // truth, so a follower who DID seek successfully had nothing
      // truthful to self-correct against and the party stayed desynced
      // — one side playing from the old spot, the other from the new one
      // — for the rest of the session.
      const previousOffset = streamStartOffsetRef.current
      streamStartOffsetRef.current = target
      setCurrentTime(target)
      applyShiftedSubtitle()
      const myGeneration = ++transcodeGenerationRef.current
      window.api?.mediaHub?.playback
        .selectTracks({ ...activeSelectionRef.current, startTime: target })
        .then((response) => {
          // A newer seek/track/quality change was fired after this one —
          // see transcodeGenerationRef's own comment. That newer request
          // already applied its own state (and its own <video> url); this
          // response describes an ffmpeg session that's already dead.
          if (transcodeGenerationRef.current !== myGeneration) return
          if (!response) return
          activeSelectionRef.current = response.selection
          setAppliedUpscaleHeight(response.selection.upscaleHeight ?? 0)
          setResult((prev) =>
            prev
              ? {
                  ...prev,
                  ...response.selection,
                  url: response.url,
                  // The response IS an FfmpegTranscoderResult (compatibility: true,
                  // plus the engine) — carrying those over is not cosmetic. A title
                  // whose audio was already browser-compatible plays DIRECT, with
                  // compatibility:false; switching audio track starts a real ffmpeg
                  // transcode, but spreading only `selection` left the flag reading
                  // false. Every party-sync path branches on it (the sync-wait
                  // effect's immediate-vs-progress check, performSeek's
                  // currentTime-vs-restart choice), so that member silently stopped
                  // following seeks from then on, with no error.
                  selection: response.selection,
                  compatibility: response.compatibility,
                  engine: response.engine
                }
              : prev
          )
          setTracks(response.tracks)
        })
        .catch((error: unknown) => {
          // A newer seek/track change that superseded this one is NOT a
          // failure — the newer request already applied its own offset and
          // is the truth now. Rolling back here would overwrite it with a
          // stale value while ffmpeg actually runs at the newer position,
          // leaving the scrubber, the time label and the subtitle shift all
          // reading minutes away from what is on screen, and the member
          // desynced from the party with a developer-jargon toast on top.
          // Same detection as selectTrack's own handler, and for the same
          // reason: Electron's IPC round-trip rebuilds a plain Error, so the
          // original .name only survives inside .message.
          if (
            transcodeGenerationRef.current !== myGeneration ||
            (error instanceof Error && error.message.includes('SupersededTranscodeError'))
          ) {
            return
          }
          streamStartOffsetRef.current = previousOffset
          setCurrentTime(previousOffset)
          applyShiftedSubtitle()
          pushNotification({
            tone: 'error',
            message: error instanceof Error ? error.message : 'Could not seek.'
          })
          // A genuine (non-superseded) failure here means the <video>
          // element's `src` never actually changed — for a normal seek
          // that just leaves playback exactly where it was, but for the
          // decode-error recovery below it means the element is STILL
          // sitting in its original errored state with nothing left to
          // fire another 'error' event and reach the notify+stop fallback
          // there. Caught in review: without this, that specific failure
          // combination left the overlay open on a permanently dead
          // stream — a seek-failure toast on top of a frozen video with no
          // further recovery possible.
          options?.onFailure?.()
        })
    },
    [result, pushNotification, applyShiftedSubtitle, setResult, setTracks, setAppliedUpscaleHeight]
  )

  // Applies the resume position once the stream is actually ready to
  // accept a seek — reuses performSeek, the same landing mechanism the
  // scrubber, party catch-up seeks, and drift corrections all already go
  // through, rather than a second bespoke "start at position N" path.
  //
  // Gated on `!followingParty`: a party FOLLOWER is positioned by the
  // party itself (see partyPendingSeek's own effect below), which already
  // lands them on the HOST's live position — this must not also fire and
  // fight that with the follower's own, likely different, saved position.
  // A solo watcher or the party HOST has no such authority to defer to,
  // so their own resume position applies normally. That is the whole of
  // "host takes preference in a party": the host's playback (including
  // where IT resumes from) is what a follower ends up watching, and the
  // follower's own bookmark is simply never consulted.
  useEffect(() => {
    if (!bufferingReady || followingParty) return
    if (resumeAppliedRef.current || !resumePosition) return
    resumeAppliedRef.current = true
    performSeek(resumePosition.positionSeconds)
  }, [bufferingReady, followingParty, resumePosition, performSeek])

  // Host only: re-evaluates the ready-set for `requestId` — called both
  // when a follower's 'ready' message arrives and when the host's own
  // buffer becomes ready (see reportSyncReady below). Once every current
  // party member is accounted for (or `force`, from the safety timeout in
  // handleSeek), releases everyone together: broadcasts 'seek-go', then —
  // after SYNC_PLAY_DELAY_MS, applied identically here on the host's own
  // side — actually resumes. That delay is the "give the message a moment
  // to actually cross the network" cushion; without it the host (zero
  // network hop for itself) would visibly start before anyone else.
  const checkPartySeekReady = useCallback(
    (requestId: string, force = false) => {
      // A stale/duplicate invocation for a request that's already been
      // superseded (resolved, or replaced by a newer seek) must not act —
      // otherwise a late re-entry here could re-broadcast 'seek-waiting'
      // (and re-set the local banner) after 'seek-go' already released
      // everyone for this requestId.
      if (activeSyncRequestIdRef.current !== requestId) return
      const members = partyStatus?.members ?? []
      // `watching !== false` rather than `=== true`: undefined means a
      // member hasn't reported yet (older build, or the message is still in
      // flight), and excluding them on that basis could release a seek
      // before someone who IS watching has buffered. Only an explicit
      // "not watching" is skipped.
      const waiting = members.filter(
        (m) => m.watching !== false && !syncReadyIdsRef.current.has(m.id)
      )
      if (waiting.length > 0 && !force) {
        setSyncWaitingNames(waiting.map((m) => m.name))
        window.api?.mediaHub?.party
          .playbackAction({ type: 'seek-waiting', requestId, waitingIds: waiting.map((m) => m.id) })
          .catch(() => {})
        return
      }
      window.api?.mediaHub?.party.playbackAction({ type: 'seek-go', requestId }).catch(() => {})
      clearSyncSeek()
      setTimeout(() => {
        videoRef.current?.play().catch(() => {})
      }, SYNC_PLAY_DELAY_MS)
    },
    [partyStatus, clearSyncSeek]
  )

  // Reports THIS device's own buffer as ready for `requestId` — the host
  // tracks its own readiness locally with no network round trip (same
  // reasoning as nowPlaying/playbackAction never echoing back to their own
  // sender), a follower has to tell the host over the wire since only the
  // host aggregates the ready-set.
  const reportSyncReady = useCallback(
    (requestId: string) => {
      if (isPartyHost) {
        syncReadyIdsRef.current.add(partyStatus?.selfId || '')
        checkPartySeekReady(requestId)
      } else {
        window.api?.mediaHub?.party.playbackAction({ type: 'ready', requestId }).catch(() => {})
      }
    },
    [isPartyHost, partyStatus, checkPartySeekReady]
  )

  // Waits for THIS device's own buffer to reach the configured target
  // ahead of the (already-seeked) playhead, then reports ready — a
  // deliberately separate effect from the plain buffering-gate below
  // (which auto-plays on its own) since during a sync wait nobody should
  // auto-play until reportSyncReady's eventual 'seek-go' says so.
  //
  // Also keyed on result?.url, not just activeSyncRequestId: in
  // compatibility mode, performSeek's ffmpeg restart (selectTracks) is
  // asynchronous, so activeSyncRequestId is set well before the new
  // segment's URL actually lands on the <video> element — for that brief
  // window, video.buffered/currentTime still describe the OLD segment
  // (fully buffered, from before the seek). Verified live: without this,
  // an immediate unconditional check reported ready instantly using that
  // stale data, and the eventual seek-go arrived before the new segment
  // had loaded anything at all, leaving that device's own .play() call
  // stuck with nothing to play. Direct/proxied mode has no such gap
  // (performSeek sets currentTime synchronously), so it alone is allowed
  // the immediate check — compatibility mode waits for a real 'progress'
  // event against the segment that's actually current.
  useEffect(() => {
    const requestId = activeSyncRequestId
    if (!requestId) return
    const video = videoRef.current
    if (!video) return
    let settled = false
    const tryReport = (force = false): void => {
      if (settled || !video) return
      const buffered = video.buffered
      const bufferedEnd = buffered.length ? buffered.end(buffered.length - 1) : 0
      const totalDuration =
        tracks?.durationSeconds && Number.isFinite(tracks.durationSeconds)
          ? tracks.durationSeconds
          : video.duration
      const fullyBuffered = Number.isFinite(totalDuration) && bufferedEnd >= totalDuration - 0.25
      const haveEnough =
        force || fullyBuffered || bufferedEnd - video.currentTime >= targetBufferSeconds
      if (!haveEnough) return
      settled = true
      reportSyncReady(requestId)
    }
    const onProgress = () => tryReport()
    video.addEventListener('progress', onProgress)
    video.addEventListener('canplaythrough', onProgress)
    const maxWait = setTimeout(() => tryReport(true), 20000)
    if (!result?.compatibility) tryReport()
    return () => {
      settled = true
      clearTimeout(maxWait)
      video.removeEventListener('progress', onProgress)
      video.removeEventListener('canplaythrough', onProgress)
    }
  }, [
    activeSyncRequestId,
    result?.url,
    result?.compatibility,
    targetBufferSeconds,
    tracks,
    reportSyncReady
  ])

  // Shared by the scrubber click (handleSeek) and the ←/→ 15s nudge
  // (seekRelative) — both just need to land on an absolute target time via
  // the same party-aware path (a full host-coordinated seek-sync when
  // hosting, a plain broadcast seek otherwise), so this is the one place
  // that logic lives.
  const seekToTarget = useCallback(
    (target: number) => {
      if (isPartyHost && partyStatus?.inParty) {
        const requestId = crypto.randomUUID()
        videoRef.current?.pause()
        clearSyncSeek()
        performSeek(target)
        setActiveSyncRequestId(requestId)
        setSyncWaitingNames(
          (partyStatus.members ?? [])
            .filter((m) => m.id !== partyStatus.selfId && m.watching !== false)
            .map((m) => m.name)
        )
        window.api?.mediaHub?.party
          .playbackAction({ type: 'seek-sync', position: target, requestId })
          .catch(() => {})
        // Safety net — one stuck/disconnected peer shouldn't hold the
        // whole party's playback hostage forever.
        syncTimeoutRef.current = setTimeout(() => {
          checkPartySeekReady(requestId, true)
        }, SYNC_TIMEOUT_MS)
      } else {
        performSeek(target)
        if (isPartyHost || canControl) {
          window.api?.mediaHub?.party
            .playbackAction({ type: 'seek', position: target })
            .catch(() => {})
        }
      }
    },
    [performSeek, isPartyHost, canControl, partyStatus, clearSyncSeek, checkPartySeekReady]
  )

  const handleSeek = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (followingParty && !canControl) return
      if (!duration || !Number.isFinite(duration)) return
      const rect = event.currentTarget.getBoundingClientRect()
      const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
      seekToTarget(fraction * duration)
    },
    [duration, followingParty, canControl, seekToTarget]
  )

  // Informational only — shows what's at a hovered position regardless of
  // whether this person could actually seek there (same as the mouse
  // position/time label already did before this), so no followingParty/
  // canControl gate here unlike handleSeek itself.
  const handleScrubberHover = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!duration || !Number.isFinite(duration)) return
      const rect = event.currentTarget.getBoundingClientRect()
      const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
      const time = fraction * duration
      // Clamped so the preview's centered thumbnail (SCRUB_PREVIEW_WIDTH
      // wide) never overhangs past the track's own edges — `time`/the
      // label above stay exact, only the popup's horizontal position is
      // adjusted.
      const halfPreview = SCRUB_PREVIEW_WIDTH / 2
      const x =
        rect.width > SCRUB_PREVIEW_WIDTH
          ? Math.min(Math.max(fraction * rect.width, halfPreview), rect.width - halfPreview)
          : rect.width / 2
      const bucket = Math.round(time / THUMBNAIL_BUCKET_SECONDS) * THUMBNAIL_BUCKET_SECONDS
      const cached = thumbnailCacheRef.current.get(bucket)

      setScrubPreview({ time, x, thumbnail: cached ?? null })

      if (scrubDebounceRef.current) clearTimeout(scrubDebounceRef.current)
      if (cached !== undefined) return // already fetched (or confirmed empty) for this bucket

      const requestId = ++scrubRequestIdRef.current
      scrubDebounceRef.current = setTimeout(() => {
        const api = window.api?.mediaHub
        if (!api) return
        api.playback
          .thumbnail(bucket)
          .then((dataUrl) => {
            thumbnailCacheRef.current.set(bucket, dataUrl)
            if (scrubRequestIdRef.current !== requestId) return // superseded by a later hover
            setScrubPreview((prev) =>
              prev &&
              Math.round(prev.time / THUMBNAIL_BUCKET_SECONDS) * THUMBNAIL_BUCKET_SECONDS === bucket
                ? { ...prev, thumbnail: dataUrl }
                : prev
            )
          })
          .catch(() => {})
      }, 250)
    },
    [duration]
  )

  const handleScrubberLeave = useCallback(() => {
    if (scrubDebounceRef.current) clearTimeout(scrubDebounceRef.current)
    scrubRequestIdRef.current++
    setScrubPreview(null)
  }, [])

  useEffect(() => {
    return () => {
      if (scrubDebounceRef.current) clearTimeout(scrubDebounceRef.current)
    }
  }, [])

  // ←/→ nudge the playhead 15s — the same clamped-to-[0,duration] target
  // both the mouse scrubber and party sync already expect; reusing
  // seekToTarget keeps this respecting the same host/follower rules as
  // every other way of seeking (locked out entirely while following
  // unless the host has turned on shared control).
  const seekRelative = useCallback(
    (deltaSeconds: number) => {
      if (followingParty && !canControl) return
      if (!duration || !Number.isFinite(duration)) return
      const target = Math.min(duration, Math.max(0, currentTime + deltaSeconds))
      seekToTarget(target)
    },
    [duration, currentTime, followingParty, canControl, seekToTarget]
  )

  useEffect(() => {
    if (!playbackMedia) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        // Mirror standard video-player UX: the first Escape only backs out
        // of fullscreen (this is real OS-level BrowserWindow fullscreen, not
        // the DOM Fullscreen API, so the OS doesn't do this for us). Only a
        // second Escape, once already windowed, closes the player.
        if (isFullscreen) {
          handleToggleFullscreen()
        } else {
          stopPlayback(markedWatchedRef.current)
        }
      }
      if (e.key === ' ') {
        e.preventDefault()
        togglePlay()
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        seekRelative(15)
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        seekRelative(-15)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [playbackMedia, stopPlayback, togglePlay, seekRelative, isFullscreen, handleToggleFullscreen])

  // Audio only — embedded *subtitle* selection used to also go through
  // here (a `kindKey: 'audio' | 'subtitle'` parameter), but that path was
  // dead: buildFfmpegArguments never read `selection.subtitle` at all (see
  // applyEmbeddedSubtitle's own comment for the real, working replacement).
  // Narrowed to just audio so this function can't quietly regrow that same
  // "looks wired up, does nothing" trap.
  async function selectTrack(ordinal: number) {
    if (!playbackMedia || trackChangeBusy) return
    const video = videoRef.current
    // During compatibility mode, video.currentTime is relative to the
    // current transcode segment (see streamStartOffsetRef's definition
    // above) — the absolute position is the segment's own start offset
    // plus that relative time, not the relative time alone.
    const startTime = streamStartOffsetRef.current + (video?.currentTime ?? 0)
    // A restart resumes only if we were actually playing when it started.
    resumeAfterRestartRef.current = !(video?.paused ?? false)
    setTrackChangeBusy(true)
    setPendingAudioOrdinal(ordinal)
    const myGeneration = ++transcodeGenerationRef.current
    try {
      const response = await window.api?.mediaHub?.playback.selectTracks({
        audio: ordinal,
        startTime
      })
      // A newer seek/track/quality change was fired while this one was
      // still restarting ffmpeg — see transcodeGenerationRef's own
      // comment. Applying this response now would stomp the newer
      // request's state with a URL for an already-dead ffmpeg session.
      if (transcodeGenerationRef.current !== myGeneration) return
      if (!response) return
      streamStartOffsetRef.current = startTime
      activeSelectionRef.current = response.selection
      setAppliedUpscaleHeight(response.selection.upscaleHeight ?? 0)
      applyShiftedSubtitle()
      // A new transcode session means a new stream URL — the <video> src
      // effect below picks this up and reloads from `startTime`.
      setResult((prev) =>
        prev
          ? {
              ...prev,
              ...response.selection,
              url: response.url,
              // The response IS an FfmpegTranscoderResult (compatibility: true,
              // plus the engine) — carrying those over is not cosmetic. A title
              // whose audio was already browser-compatible plays DIRECT, with
              // compatibility:false; switching audio track starts a real ffmpeg
              // transcode, but spreading only `selection` left the flag reading
              // false. Every party-sync path branches on it (the sync-wait
              // effect's immediate-vs-progress check, performSeek's
              // currentTime-vs-restart choice), so that member silently stopped
              // following seeks from then on, with no error.
              selection: response.selection,
              compatibility: response.compatibility,
              engine: response.engine
            }
          : prev
      )
      setTracks(response.tracks)
    } catch (error) {
      // A rapid second track/quality change while the first was still
      // restarting ffmpeg supersedes it server-side (see vlc.ts's
      // generation tracking) — the newer request already applied
      // correctly, so the older one silently losing the race isn't a
      // real failure worth alarming over. Checked via the message text,
      // not `error.name` — Electron's IPC error round-trip reconstructs a
      // plain `Error` on this side, so a thrown error's original `.name`
      // only survives inside the reconstructed `.message` string, not as
      // this object's own `.name` (confirmed live: `.name` here is always
      // just "Error").
      const isSuperseded =
        transcodeGenerationRef.current !== myGeneration ||
        (error instanceof Error && error.message.includes('SupersededTranscodeError'))
      if (!isSuperseded) {
        pushNotification({
          tone: 'error',
          message: error instanceof Error ? error.message : 'Could not change tracks.'
        })
      }
    } finally {
      setTrackChangeBusy(false)
      setPendingAudioOrdinal(null)
      setOpenMenu(null)
    }
  }

  // Local-only, never broadcast to the party (see watchParty.ts — only
  // seek/seek-sync/seek-waiting/seek-go are host-gated) — this changes
  // picture quality, not playback position, so every party member (host
  // or follower) independently decides it for their own stream without
  // needing anyone else's involvement, exactly like an audio-track switch
  // already works. Reuses the same restart path as selectTrack/performSeek
  // above rather than a separate endpoint, so it automatically survives
  // every later seek/track-change the same way (see playbackSession.ts's
  // select-tracks handler treating upscaleHeight as sticky selection state).
  async function applyUpscale(height: number) {
    if (!playbackMedia) return
    const video = videoRef.current
    const startTime = streamStartOffsetRef.current + (video?.currentTime ?? 0)
    // Same restart, same rule as selectTrack: don't resume something the
    // person had paused.
    resumeAfterRestartRef.current = !(video?.paused ?? false)
    setApplyingQuality(true)
    const myGeneration = ++transcodeGenerationRef.current
    try {
      const response = await window.api?.mediaHub?.playback.selectTracks({
        ...activeSelectionRef.current,
        startTime,
        upscaleHeight: height
      })
      // See transcodeGenerationRef's own comment — a newer restart request
      // already won, this one describes an already-dead ffmpeg session.
      if (transcodeGenerationRef.current !== myGeneration) return
      if (!response) return
      streamStartOffsetRef.current = startTime
      activeSelectionRef.current = response.selection
      setAppliedUpscaleHeight(response.selection.upscaleHeight ?? 0)
      applyShiftedSubtitle()
      setResult((prev) =>
        prev
          ? {
              ...prev,
              ...response.selection,
              url: response.url,
              // The response IS an FfmpegTranscoderResult (compatibility: true,
              // plus the engine) — carrying those over is not cosmetic. A title
              // whose audio was already browser-compatible plays DIRECT, with
              // compatibility:false; switching audio track starts a real ffmpeg
              // transcode, but spreading only `selection` left the flag reading
              // false. Every party-sync path branches on it (the sync-wait
              // effect's immediate-vs-progress check, performSeek's
              // currentTime-vs-restart choice), so that member silently stopped
              // following seeks from then on, with no error.
              selection: response.selection,
              compatibility: response.compatibility,
              engine: response.engine
            }
          : prev
      )
      setTracks(response.tracks)
    } catch (error) {
      const isSuperseded =
        transcodeGenerationRef.current !== myGeneration ||
        (error instanceof Error && error.message.includes('SupersededTranscodeError'))
      if (!isSuperseded) {
        pushNotification({
          tone: 'error',
          message: error instanceof Error ? error.message : 'Could not change video quality.'
        })
      }
    }
    setApplyingQuality(false)
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

  async function applySubtitle(subtitle: SubtitleResult) {
    if (pendingSubtitleId !== null) return
    setPendingSubtitleId(subtitle.id)
    const myGeneration = ++subtitleGenerationRef.current
    try {
      const applied = await window.api?.mediaHub?.subtitles.apply(
        {
          provider: subtitle.provider,
          fileId: subtitle.fileId,
          downloadPath: subtitle.downloadPath
        },
        false
      )
      // A newer subtitle pick (or the auto-fetch) already won — see
      // subtitleGenerationRef's own comment.
      if (subtitleGenerationRef.current !== myGeneration) return
      if (applied?.vttDataUrl) {
        // Store the ORIGINAL absolute-timeline VTT, then apply it shifted
        // by whatever offset the current segment is already at (applying
        // a subtitle after having already seeked once shouldn't itself be
        // instantly out of sync).
        subtitleVttRef.current = decodeVttDataUrl(applied.vttDataUrl)
        applyShiftedSubtitle()
      }
    } catch (error) {
      if (subtitleGenerationRef.current !== myGeneration) return
      pushNotification({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not load that subtitle.'
      })
    } finally {
      setPendingSubtitleId(null)
      setOpenMenu(null)
    }
  }

  // The "Embedded" subtitle menu used to route through selectTrack('subtitle',
  // ordinal) — a real dead end found live: that path restarts ffmpeg via
  // playback:select-tracks, but buildFfmpegArguments never actually reads
  // `selection.subtitle` (embedded-subtitle *burning* was removed when
  // compatibility mode switched to `-c:v copy` — see vlc.ts's own header
  // comment), so clicking it silently did nothing. This is the real fix:
  // extract that stream as WebVTT (mediahub:playback:extract-subtitle, no
  // transcode restart involved) and apply it through the exact same
  // <track> mechanism the OpenSubtitles flow above already uses. Can take
  // a while on a slow connection (see extractSubtitleTrack's own comment
  // on why there's no early exit), so this tracks its own busy state
  // rather than reusing trackChangeBusy, which is specifically about the
  // ffmpeg-restart path this doesn't use.
  async function applyEmbeddedSubtitle(track: MediaTrack) {
    if (extractingSubtitleOrdinal !== null) return
    setExtractingSubtitleOrdinal(track.ordinal)
    const myGeneration = ++subtitleGenerationRef.current
    try {
      const vtt = await window.api?.mediaHub?.playback.extractSubtitle(track.ordinal)
      // A newer subtitle pick (or the auto-fetch) already won while this
      // demux — tens of seconds on a large file, no early exit — was still
      // running. See subtitleGenerationRef's own comment.
      if (subtitleGenerationRef.current !== myGeneration) return
      if (!vtt) {
        pushNotification({
          tone: 'error',
          message: `Could not load "${track.label}" — no subtitle data was found.`
        })
        return
      }
      subtitleVttRef.current = vtt
      applyShiftedSubtitle()
    } catch (error) {
      if (subtitleGenerationRef.current !== myGeneration) return
      pushNotification({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Could not load that subtitle.'
      })
    } finally {
      setExtractingSubtitleOrdinal(null)
      setOpenMenu(null)
    }
  }

  // "Always have subtitles" — automatically fetches and applies an online
  // subtitle match as soon as this title starts, same as clicking the
  // Subtitles menu and picking the first result manually would, so
  // there's always something on screen without that manual step. Uses the
  // exact same search (already scoped server-side to the user's
  // subtitleLanguage setting — see subtitlesService.ts) and apply path the
  // Subtitles menu itself uses; the person can still switch to an embedded
  // track or a different online result afterward via that menu.
  //
  // Taking results[0] means this prefers SubDL whenever it's connected and
  // has a match, which is deliberate: mergeSubtitleResults orders it first
  // precisely because an automatic per-title fetch would otherwise burn a
  // free OpenSubtitles account's five daily downloads in five episodes.
  // Gated on the autoSubtitlesEnabled preference (on by default — see
  // preferences.ts's publicSettings) so someone who'd rather pick manually
  // via the Subtitles menu can turn this off.
  // Runs once per title: this component remounts fresh per playbackMedia
  // (see GlobalOverlays.tsx's `key={playbackMedia?.id}`), so an empty
  // dependency array is genuinely "once per session," not just "once
  // ever." Best-effort — no subtitles found is a normal, silent outcome,
  // not something worth an error toast for.
  useEffect(() => {
    if (!playbackMedia) return
    if (mediaHubSettings?.autoSubtitlesEnabled === false) return
    let cancelled = false
    // Bumped up front, before the search/apply round trip even starts —
    // see subtitleGenerationRef's own comment. A manual pick made while
    // this is still in flight (very plausible: it's two sequential network
    // calls) must win over this auto-fetch's own eventual result, not the
    // other way around.
    const myGeneration = ++subtitleGenerationRef.current
    const api = window.api?.mediaHub
    if (!api) return
    api.subtitles
      .search(
        { id: playbackMedia.id, type: kind, title: playbackMedia.title },
        { season: playbackMedia.seasonNumber, episode: playbackMedia.episodeNumber }
      )
      .then(async (results) => {
        if (cancelled || subtitleGenerationRef.current !== myGeneration || !results?.length) return
        setSubtitleResults(results)
        const applied = await api.subtitles.apply(
          {
            provider: results[0].provider,
            fileId: results[0].fileId,
            downloadPath: results[0].downloadPath
          },
          false
        )
        if (cancelled || subtitleGenerationRef.current !== myGeneration || !applied?.vttDataUrl)
          return
        subtitleVttRef.current = decodeVttDataUrl(applied.vttDataUrl)
        applyShiftedSubtitle()
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Skip Intro/Credits — anime only (see aniskip.ts's own header comment
  // for why there's no equivalent for movies/series). Aniskip's API
  // requires a real episodeLengthSeconds (confirmed live: omitting it is a
  // 400, not a "search without it"), so this waits for `duration` to
  // actually be known rather than firing on mount like the subtitle
  // search above does.
  useEffect(() => {
    if (!playbackMedia || kind !== 'anime') return
    if (!duration || skipTimesFetchedRef.current) return
    skipTimesFetchedRef.current = true
    const api = window.api?.mediaHub
    if (!api) return
    api.playback
      .skipTimes(playbackMedia.id, playbackMedia.episodeNumber ?? 1, duration)
      .then(setSkipTimes)
      .catch(() => {})
  }, [playbackMedia, kind, duration])

  const skipIntroWindow =
    skipTimes?.intro && currentTime >= skipTimes.intro.start && currentTime < skipTimes.intro.end
      ? skipTimes.intro
      : null
  const skipCreditsWindow =
    skipTimes?.credits &&
    currentTime >= skipTimes.credits.start &&
    currentTime < skipTimes.credits.end
      ? skipTimes.credits
      : null

  function handleSkip(target: number) {
    if (followingParty && !canControl) return
    seekToTarget(target)
  }

  const audioTracks = useMemo<MediaTrack[]>(() => tracks?.audio ?? [], [tracks])
  const subtitleTracks = useMemo<MediaTrack[]>(() => tracks?.subtitle ?? [], [tracks])
  // Which audio track is actually being heard, reported by the backend on
  // every start and every restart (see PlaybackResult.selection). The menu
  // used to mark `track.default` instead — ffprobe's disposition flag,
  // which describes the FILE and never changes. That was wrong twice over:
  // it could point at a track selectTranscodeAudioTrack had deliberately
  // refused to use, and picking a different track left the tick exactly
  // where it was, so a switch that worked perfectly still looked like
  // nothing had happened.
  const activeAudioOrdinal = result?.selection?.audio
  const upscaleSuggestion = result?.upscaleSuggestion
  const fitModeLabel = { contain: 'Fit', cover: 'Fill', fill: 'Stretch' }[fitMode]

  // The actual "let it buffer for a while on a bad connection" gate — the
  // <video> element no longer autoplays (see `playing`'s initial value
  // above); instead this waits until enough of the CURRENT segment has
  // buffered ahead of the playhead (or the element itself already says it
  // has enough — readyState 4 — or a real segment shorter than the target
  // has simply finished downloading in full) before calling .play() itself.
  // Applies uniformly to both playback modes: direct/proxied streaming
  // already gets real Range-based buffering from Chromium, this just adds
  // a deliberate wait *before* consuming any of that buffer; compatibility
  // mode's server-side head start (vlc.ts's MIN_BUFFER_MS) still applies on
  // top, so this is genuinely two layers of the same setting reinforcing
  // each other, not a replacement for either. Re-runs on every new segment
  // — a fresh title, or any seek/track-change restart in compatibility mode
  // — since each of those is its own fresh buffer-up from scratch.
  useEffect(() => {
    const video = videoRef.current
    if (!video || !result?.url) return
    setBufferingReady(false)
    let settled = false

    function tryStart(force = false) {
      if (settled || !video) return
      const buffered = video.buffered
      const bufferedEnd = buffered.length ? buffered.end(buffered.length - 1) : 0
      // readyState alone is deliberately NOT treated as "good enough" —
      // Chromium can reach HAVE_ENOUGH_DATA with barely anything buffered,
      // which let playback start well before the configured target and
      // reintroduced exactly the stall this feature exists to prevent
      // (verified live: readyState 4 with ~2s actually buffered against a
      // 15s "Maximum" target started playing, then stalled a few seconds
      // in). A short clip that's already fully downloaded is the one
      // legitimate reason to stop waiting early — nothing more is ever
      // coming, so there's no point holding out for a target buffer bigger
      // than the whole file.
      const totalDuration =
        tracks?.durationSeconds && Number.isFinite(tracks.durationSeconds)
          ? tracks.durationSeconds
          : video.duration
      const fullyBuffered = Number.isFinite(totalDuration) && bufferedEnd >= totalDuration - 0.25
      const haveEnough =
        force || fullyBuffered || bufferedEnd - video.currentTime >= targetBufferSeconds
      if (!haveEnough) return
      settled = true
      setBufferingReady(true)
      // A synced host-initiated seek (see handleSeek/checkPartySeekReady)
      // owns the decision of when to actually play in that case — the
      // dedicated sync-wait effect above reports readiness instead, and
      // this gate's own job here is done once bufferingReady is set.
      if (!activeSyncRequestIdRef.current) {
        if (resumeAfterRestartRef.current) video.play().catch(() => {})
        // Consumed: only the restart that set it is affected, so an
        // ordinary later load still auto-plays.
        resumeAfterRestartRef.current = true
      }
    }

    const onProgress = () => tryStart()
    video.addEventListener('progress', onProgress)
    video.addEventListener('loadedmetadata', onProgress)
    video.addEventListener('canplaythrough', onProgress)
    // Never make someone wait indefinitely for the target to be reached —
    // a connection too slow to ever get there should still start playing
    // (and likely stutter) rather than appear stuck on "Buffering…" forever.
    const maxWait = setTimeout(() => tryStart(true), 20000)
    // Handles the (common) case where enough had already buffered before
    // any of these listeners were attached.
    tryStart()

    return () => {
      settled = true
      clearTimeout(maxWait)
      video.removeEventListener('progress', onProgress)
      video.removeEventListener('loadedmetadata', onProgress)
      video.removeEventListener('canplaythrough', onProgress)
    }
  }, [result?.url, targetBufferSeconds, tracks])

  // Joining a party mid-title (or the host starting a fresh one) leaves an
  // absolute catch-up position in AppStateContext's partyPendingSeek —
  // consumed here once the stream is actually ready to play rather than
  // the instant it's set, since seeking before that would just race the
  // buffering-gate effect above.
  useEffect(() => {
    if (partyPendingSeek === null || !bufferingReady) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    performSeek(partyPendingSeek)
    consumePartyPendingSeek()
  }, [partyPendingSeek, bufferingReady, performSeek, consumePartyPendingSeek])

  // Applies an incoming play/pause/seek/position action to this device's
  // own video. Normally only a follower ever receives these (the host is
  // the sole broadcaster) — but once the host turns on "Anyone can
  // control playback" (see PartyPanel), any member's action reaches
  // everyone else including the host, so this runs for the host too in
  // that case. The wire protocol guarantees a sender never gets its own
  // broadcast echoed back, so there's no risk of a member's own seek
  // bouncing back and re-applying to itself.
  useEffect(() => {
    if (!partyStatus?.inParty) return
    if (partyStatus.role === 'host' && !partyStatus.allowMemberControl) return
    const api = window.api?.mediaHub?.party
    if (!api) return
    return api.onEvent((event) => {
      if (event.type !== 'message') return
      const msg = event.message as {
        type?: string
        position?: number
        paused?: boolean
        requestId?: string
        waitingIds?: string[]
      }
      const video = videoRef.current
      if (!video) return
      if (msg.type === 'play') video.play().catch(() => {})
      else if (msg.type === 'pause') video.pause()
      else if (msg.type === 'seek') {
        // Cancels any still-pending join-time catch-up seek (see
        // partyPendingSeek's own effect below) — without this, a real seek
        // that arrives before this device's buffer ever became ready
        // (partyPendingSeek only gets consumed once bufferingReady flips
        // true) gets silently overwritten the moment buffering DOES catch
        // up: the stale catch-up effect fires afterward with the OLD
        // position from whenever this device joined, snapping playback
        // back to it — confirmed live, reliably landing back at 0. A live
        // seek always supersedes "catch up to where things were on join."
        consumePartyPendingSeek()
        performSeek(Number(msg.position) || 0)
      } else if (msg.type === 'position') {
        // Direct/proxied playback: a plain currentTime nudge is cheap, so
        // correct on any noticeable (>2s) drift. Compatibility mode has no
        // such cheap nudge — performSeek there means restarting the ffmpeg
        // transcode from scratch (see its own comment) — so this used to
        // skip compat mode entirely to avoid restarting over routine
        // jitter. That left a real, permanently-uncorrected gap: each
        // party member resolves and streams their OWN independent copy of
        // the source (see startPartyPlayback), and buildFfmpegArguments's
        // own -noaccurate_seek keyframe-snap (see its comment) means every
        // seek lands each person on the *nearest keyframe in their own
        // file* — which differs release to release, sometimes by several
        // seconds — not the literal requested position. With no
        // correction at all in compat mode, that per-person snap became a
        // permanent offset from everyone else, confirmed live (seek felt
        // instant locally, other members stayed audibly/visibly behind
        // forever after). A wider 6s threshold here still leaves single-
        // keyframe-interval noise alone (restarting the transcode over a
        // couple of seconds of expected snap error would be more
        // disruptive than the drift itself) while actually correcting a
        // real, sustained desync within one ~10s correction cycle instead
        // of never.
        // Record the fix; the steering loop below does the correcting.
        // Deliberately NOT corrected here: acting only on arrival means a
        // follower is uncorrected for the entire gap between heartbeats,
        // and compares a value that is already one network hop stale
        // against its own current position — a systematic backward pull.
        // Stamping arrival on the local clock and extrapolating from it
        // removes both problems (see partySync.ts).
        hostFixRef.current = {
          mediaTime: Number(msg.position) || 0,
          arrivedAt: performance.now(),
          paused: msg.paused === true
        }
      } else if (msg.type === 'seek-sync' && msg.requestId) {
        // Land at the new position and hold there — reportSyncReady (via
        // the dedicated sync-wait effect above, keyed on
        // activeSyncRequestId) is what actually tells the host this
        // device is ready; only 'seek-go' below is allowed to resume it.
        // consumePartyPendingSeek here for the same reason as the plain
        // 'seek' branch above — a still-pending join-time catch-up seek
        // must not be allowed to fire later and undo this.
        video.pause()
        clearSyncSeek()
        consumePartyPendingSeek()
        performSeek(Number(msg.position) || 0)
        setActiveSyncRequestId(msg.requestId)
      } else if (msg.type === 'seek-waiting' && msg.requestId === activeSyncRequestIdRef.current) {
        const names = (msg.waitingIds || [])
          .map((id) => partyStatus?.members?.find((m) => m.id === id)?.name)
          .filter((name): name is string => Boolean(name))
        setSyncWaitingNames(names)
      } else if (msg.type === 'seek-go' && msg.requestId === activeSyncRequestIdRef.current) {
        clearSyncSeek()
        setTimeout(() => {
          videoRef.current?.play().catch(() => {})
        }, SYNC_PLAY_DELAY_MS)
      }
    })
  }, [performSeek, clearSyncSeek, partyStatus, result?.compatibility, consumePartyPendingSeek])

  // Follower side: steers toward where the host is RIGHT NOW, using the
  // last fix extrapolated forward (see partySync.ts). Runs on its own
  // timer rather than only when a heartbeat lands, which is the whole
  // point of extrapolating — corrections happen continuously instead of
  // once every few seconds against an already-stale number.
  //
  // Rate nudges are inaudible and self-correcting, so this converges
  // smoothly; a hard seek is reserved for a gap too large to close by
  // speed alone (and, in compatibility mode, is expensive enough that its
  // threshold stays deliberately wide — see HARD_SEEK_SECONDS).
  useEffect(() => {
    if (!followingParty) return
    const tick = setInterval(() => {
      const video = videoRef.current
      if (!video || video.paused) return
      // A synced seek owns positioning while it's in flight.
      if (activeSyncRequestIdRef.current) return
      const now = performance.now()
      const fix = hostFixRef.current
      if (!isSampleUsable(fix, now)) {
        // No trustworthy fix — coast at normal speed rather than steering
        // toward a stale one.
        if (video.playbackRate !== 1) video.playbackRate = 1
        setPartySyncNotice('delayed')
        return
      }
      if (fix!.paused) {
        if (video.playbackRate !== 1) video.playbackRate = 1
        setPartySyncNotice('synced')
        return
      }
      const expected = expectedHostPosition(fix!, now)
      const local = streamStartOffsetRef.current + video.currentTime
      const correction = syncCorrection(local, expected, !!result?.compatibility)
      if (correction.action === 'seek') {
        setPartySyncNotice('correcting')
        video.playbackRate = 1
        // The fix keeps advancing while the seek lands, so aim at where the
        // host will be, not where it was when we decided to move.
        performSeek(expectedHostPosition(fix!, performance.now()))
      } else if (correction.action === 'rate') {
        setPartySyncNotice('correcting')
        if (video.playbackRate !== correction.rate) video.playbackRate = correction.rate
      } else if (video.playbackRate !== 1) {
        video.playbackRate = 1
        setPartySyncNotice('synced')
      } else {
        setPartySyncNotice('synced')
      }
    }, 1000)
    // Captured now rather than read in the cleanup: by teardown the ref may
    // already point at a different (or no) element, and the one this effect
    // actually steered is the one that must not be left off-speed.
    const steered = videoRef.current
    return () => {
      clearInterval(tick)
      if (steered && steered.playbackRate !== 1) steered.playbackRate = 1
    }
  }, [followingParty, result?.compatibility, performSeek])

  // Publishes what this device is watching to the friends group. The main
  // process decides whether it actually goes out (see friends.ts — sharing
  // is opt-in, and with it off the field is omitted entirely rather than
  // sent as null, so "not sharing" and "not watching" look identical to
  // everyone else). Cleared on unmount so closing the player takes the
  // activity down rather than leaving a stale "still watching" behind.
  useEffect(() => {
    const api = window.api?.mediaHub?.friends
    if (!api || !playbackMedia) return
    const publish = (): void => {
      const video = videoRef.current
      api
        .setActivity({
          mediaId: playbackMedia.id,
          kind,
          title: playbackMedia.title,
          poster: playbackMedia.posterUrl ?? '',
          position: streamStartOffsetRef.current + (video?.currentTime ?? 0),
          paused: video?.paused ?? true,
          // Only meaningful while actually hosting — this is what lets a
          // friend be offered "join their party" rather than just "watch
          // this too".
          partyCode: isPartyHost ? (partyHostCode ?? undefined) : undefined
        })
        .catch(() => {})
    }
    publish()
    const timer = setInterval(publish, 20000)
    return () => {
      clearInterval(timer)
      api.setActivity(null).catch(() => {})
    }
  }, [playbackMedia, kind, isPartyHost, partyHostCode])

  // Host side: keeps followers roughly in sync even without an explicit
  // seek (natural playback drift, a follower who briefly stalled) — see
  // the 'position' branch above for the follower's own >2s correction
  // threshold.
  useEffect(() => {
    if (!isPartyHost) return
    const api = window.api?.mediaHub?.party
    if (!api) return
    const interval = setInterval(() => {
      const video = videoRef.current
      if (!video) return
      const position = streamStartOffsetRef.current + video.currentTime
      // Sent even while PAUSED, unlike before. Followers extrapolate
      // forward from the last heartbeat (see partySync.ts), so silence is
      // ambiguous to them — "host paused" and "host fell off the network"
      // look identical, and one of those means they should keep coasting.
      // Saying so explicitly costs a few bytes every few seconds.
      api.playbackAction({ type: 'position', position, paused: video.paused }).catch(() => {})
    }, HOST_HEARTBEAT_MS)
    return () => clearInterval(interval)
  }, [isPartyHost])

  // Host side of the synced-seek protocol: the only place a follower's
  // 'ready' message (see the dedicated sync-wait effect above, which
  // sends it once THIS device is host, or over the wire when it isn't)
  // actually gets acted on — without this, checkPartySeekReady would
  // never see anyone but the host itself report in, and every sync-seek
  // would silently ride out its full SYNC_TIMEOUT_MS instead of releasing
  // as soon as everyone genuinely catches up.
  useEffect(() => {
    if (!isPartyHost) return
    const api = window.api?.mediaHub?.party
    if (!api) return
    return api.onEvent((event) => {
      if (event.type !== 'message') return
      const msg = event.message as { type?: string; requestId?: string }
      if (
        msg.type !== 'ready' ||
        !msg.requestId ||
        msg.requestId !== activeSyncRequestIdRef.current
      )
        return
      syncReadyIdsRef.current.add(event.from)
      checkPartySeekReady(msg.requestId)
    })
  }, [isPartyHost, checkPartySeekReady])

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
        onClick={togglePlay}
        onPlay={() => setPlaying(true)}
        onPause={() => {
          setPlaying(false)
          savePositionNow()
        }}
        onTimeUpdate={(e) => {
          const absolute = streamStartOffsetRef.current + e.currentTarget.currentTime
          setCurrentTime(absolute)
          // Mirrors currentTime/duration into a ref for the save-on-close
          // effect's cleanup, which can't rely on this render's state —
          // see currentPositionRef's own comment.
          currentPositionRef.current.time = absolute
        }}
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
        onError={() => {
          // Previously silent: a mid-stream decode failure (confirmed
          // live — PipelineStatus::PIPELINE_ERROR_DECODE from a TrueHD/
          // Atmos downmix, see selectTranscodeAudioTrack) left the player
          // frozen with audio and video both dead and no feedback at all.
          // The raw pipeline error is developer-facing jargon, not
          // something to show verbatim — logged for diagnosis, with a
          // plain, actionable message (chosen from the error's own code —
          // see playbackErrorMessage) for the person watching.
          console.error('[playback] video element error', videoRef.current?.error)
          // Only reaches DevTools on its own (see console.error above) —
          // forwarded to main so it lands in logs/media-hub.log too, since
          // that's the one piece of a playback crash that was otherwise
          // unrecoverable after the fact. Best-effort: this must never be
          // why stopPlayback below doesn't run.
          window.api?.mediaHub?.playback
            .reportClientError({
              code: videoRef.current?.error?.code,
              message: videoRef.current?.error?.message,
              currentTime: videoRef.current?.currentTime
            })
            .catch(() => {})
          // A decode error (code 3) in compatibility mode is often a
          // transient artifact of the live ffmpeg-to-<video> relay rather
          // than a genuinely broken source track — reproduced live: the
          // exact same bytes this transcode produces decode cleanly end to
          // end when served as a complete file instead of the live stream,
          // so restarting the transcode fresh from here recovers most of
          // the time. Network errors (code 2) get the same retry: the
          // relay now answers a reconnect from the exact byte it asks for
          // (see vlc.ts's `history`), but a reconnect whose requested byte
          // has genuinely aged out of the retained window still ends in a
          // clean, honest failure there rather than corrupted playback —
          // and a fresh restart recovers that exactly the same way it
          // recovers a decode error. One shot per title/episode
          // (transcodeErrorRetriedRef) either way — a second failure means
          // this really is unrecoverable, and must fall through to the
          // notify+stop below instead of looping.
          if (
            (videoRef.current?.error?.code === 3 || videoRef.current?.error?.code === 2) &&
            result?.compatibility &&
            !transcodeErrorRetriedRef.current
          ) {
            transcodeErrorRetriedRef.current = true
            const video = videoRef.current
            const resumeAt = streamStartOffsetRef.current + (video?.currentTime ?? 0)
            // Same rule as selectTrack/applyUpscale's own restarts: only
            // auto-resume if playback was actually running when this hit.
            resumeAfterRestartRef.current = !(video?.paused ?? false)
            // If the restart itself fails (ffmpeg times out, exits early,
            // etc.), performSeek's own catch already reverts/notifies —
            // this is what actually recovers the overlay afterward, since
            // the <video> element's src never changed and nothing else
            // will ever fire a second 'error' event to reach the fallback
            // below on its own.
            performSeek(resumeAt, { onFailure: () => stopPlayback(markedWatchedRef.current) })
            return
          }
          pushNotification({
            tone: 'error',
            message: playbackErrorMessage(videoRef.current?.error)
          })
          stopPlayback(markedWatchedRef.current)
        }}
      >
        {activeSubtitleTrackUrl && (
          // Keyed on the URL so a re-shifted or replaced subtitle mounts a
          // genuinely new element rather than having its `src` swapped
          // underneath the existing TextTrack, whose already-parsed cues
          // are not guaranteed to be discarded when that happens. The
          // effect above is what actually makes it visible.
          <track
            key={activeSubtitleTrackUrl}
            kind="subtitles"
            src={activeSubtitleTrackUrl}
            default
            label="Subtitles"
          />
        )}
      </video>

      {!bufferingReady ? (
        <div className={styles.playerBuffering} aria-live="polite">
          <span className={styles.playerBufferingSpinner} aria-hidden="true" />
          <span>Buffering…</span>
        </div>
      ) : (
        // Gated on activeSyncRequestId, not just syncWaitingNames alone —
        // clearSyncSeek() always nulls both together, but a late/duplicate
        // 'seek-waiting' broadcast racing the 'seek-go' that resolves the
        // same request could otherwise re-set syncWaitingNames a moment
        // after resolution. Requiring the requestId to still be active
        // closes that off regardless of message-ordering edge cases.
        activeSyncRequestId !== null &&
        syncWaitingNames !== null && (
          <div className={styles.playerBuffering} aria-live="polite">
            <span className={styles.playerBufferingSpinner} aria-hidden="true" />
            <span>
              {syncWaitingNames.length > 0
                ? `Waiting for ${syncWaitingNames.join(', ')} to finish buffering…`
                : 'Starting together…'}
            </span>
          </div>
        )
      )}

      <button
        ref={closeRef}
        type="button"
        className={styles.playbackClose}
        onClick={() => stopPlayback(markedWatchedRef.current)}
        aria-label="Close playback"
      >
        <Icon name="x" size={17} />
      </button>

      {/* Independent of controlsVisible — the whole point is to be
          clickable during the intro/credits window without first having to
          move the mouse to reveal the control bar. */}
      {(skipIntroWindow || skipCreditsWindow) && (
        <button
          type="button"
          className={styles.skipButton}
          onClick={() => handleSkip((skipIntroWindow ?? skipCreditsWindow)!.end)}
        >
          {skipIntroWindow ? 'Skip Intro' : 'Skip Credits'}
          <Icon name="chevron" size={14} />
        </button>
      )}

      <div
        className={`${styles.playerControls} ${!controlsVisible ? styles.playerControlsHidden : ''}`}
      >
        {result.autoReason && <span className={styles.playerAutoNote}>{result.autoReason}</span>}

        <div
          className={`${styles.playerScrubberTrack} ${followingParty && !canControl ? styles.playerScrubberLocked : ''}`}
          onClick={handleSeek}
          onMouseMove={handleScrubberHover}
          onMouseLeave={handleScrubberLeave}
        >
          <div
            className={styles.playerScrubberFill}
            style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }}
          />
          {scrubPreview && (
            <div
              className={styles.scrubPreview}
              style={{ left: `${scrubPreview.x}px` }}
              aria-hidden="true"
            >
              <div className={styles.scrubPreviewThumb}>
                {scrubPreview.thumbnail ? (
                  <img src={scrubPreview.thumbnail} alt="" className={styles.scrubPreviewImage} />
                ) : (
                  <div className={styles.scrubPreviewPlaceholder} />
                )}
              </div>
              <span className={styles.scrubPreviewTime}>{formatTime(scrubPreview.time)}</span>
            </div>
          )}
        </div>

        <div className={styles.playerButtonRow}>
          <button
            type="button"
            className={styles.playerIconButton}
            onClick={togglePlay}
            disabled={followingParty && !canControl}
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

          {followingParty && !canControl && (
            <span className={styles.playerPartyBadge}>
              <Icon name="people" size={12} /> Host is controlling playback
            </span>
          )}

          {followingParty && (
            <span
              className={`${styles.playerPartyBadge} ${
                partySyncNotice === 'delayed' ? styles.playerPartyBadgeWarning : ''
              }`}
              aria-live="polite"
            >
              <Icon name={partySyncNotice === 'synced' ? 'check' : 'refresh'} size={12} />
              {partySyncNotice === 'synced'
                ? 'In sync'
                : partySyncNotice === 'correcting'
                  ? 'Correcting sync…'
                  : 'Waiting for host sync…'}
            </span>
          )}

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
                  {audioTracks.map((t) => {
                    const isActive = activeAudioOrdinal === t.ordinal
                    return (
                      <button
                        key={t.ordinal}
                        type="button"
                        className={`${styles.playerMenuItem} ${isActive ? styles.playerMenuItemActive : ''}`}
                        onClick={() => selectTrack(t.ordinal)}
                        disabled={trackChangeBusy || isActive}
                      >
                        {pendingAudioOrdinal === t.ordinal ? `Loading "${t.label}"…` : t.label}
                        {isActive && <Icon name="check" size={12} />}
                      </button>
                    )
                  })}
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
                {subtitleTracks.length === 0 && <span className={styles.playerMenuItem}>None</span>}
                {/* Extracting an embedded track needs the WHOLE file locally
                    cached (cues are interleaved throughout the container —
                    see streamCache.ts/extractSubtitleTracksBatch) — a cache
                    size too small for this title's file means it can never
                    become available, not just slow, so it's greyed out
                    upfront rather than letting a click silently fail or (the
                    bug this whole cache exists to fix) reopen a second
                    connection to the debrid link to read past what's cached. */}
                {subtitleTracks.length > 0 && !result?.embeddedSubtitlesAvailable && (
                  <span className={styles.playerMenuItem} title="Settings → Stream cache size">
                    Increase the stream cache size in Settings to enable embedded subtitles
                  </span>
                )}
                {result?.embeddedSubtitlesAvailable &&
                  subtitleTracks.map((t) => {
                    const isTextBased = TEXT_SUBTITLE_CODECS.has(t.codec.toLowerCase())
                    const isExtracting = extractingSubtitleOrdinal === t.ordinal
                    return (
                      <button
                        key={t.ordinal}
                        type="button"
                        className={styles.playerMenuItem}
                        onClick={() => applyEmbeddedSubtitle(t)}
                        disabled={!isTextBased || extractingSubtitleOrdinal !== null}
                        title={
                          isTextBased ? undefined : 'Image-based subtitle format — not supported'
                        }
                      >
                        {/* Honest about the wait: pulling an embedded track
                            out means demuxing the whole cached file, which
                            on a large one is tens of seconds, not instant.
                            Saying "Loading…" alone reads as a hang. */}
                        {isExtracting ? `Extracting “${t.label}” — this can take a while…` : t.label}
                        {!isTextBased && ' (unsupported)'}
                      </button>
                    )
                  })}
                {/* Was "OpenSubtitles" when that was the only provider. Now
                    that the list merges both, the heading names the category
                    and each row says which service it came from — which
                    matters for more than curiosity: an OpenSubtitles row
                    spends one of a free account's five daily downloads,
                    a SubDL row costs nothing. */}
                <div className={styles.playerMenuHeading}>Online subtitles</div>
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
                    onClick={() => applySubtitle(s)}
                    disabled={pendingSubtitleId !== null}
                  >
                    {pendingSubtitleId === s.id
                      ? 'Loading…'
                      : `${s.language.toUpperCase()} — ${s.releaseName || s.fileName} · ${
                          s.provider === 'subdl' ? 'SubDL' : 'OpenSubtitles'
                        }`}
                  </button>
                ))}
              </div>
            )}
          </div>

          {upscaleSuggestion && (
            <div className={styles.playerMenuWrap}>
              <button
                type="button"
                className={styles.playerIconButton}
                onClick={() => setOpenMenu(openMenu === 'quality' ? null : 'quality')}
                aria-label="Video quality"
                disabled={applyingQuality}
              >
                <Icon name="expand" size={15} />
              </button>
              {openMenu === 'quality' && (
                <div className={styles.playerMenu}>
                  <div className={styles.playerMenuHeading}>
                    {applyingQuality
                      ? 'Applying…'
                      : `Upscale from ${upscaleSuggestion.sourceHeight}p`}
                  </div>
                  <button
                    type="button"
                    className={`${styles.playerMenuItem} ${appliedUpscaleHeight === 0 ? styles.playerMenuItemActive : ''}`}
                    onClick={() => applyUpscale(0)}
                    disabled={applyingQuality}
                  >
                    Original quality
                    {appliedUpscaleHeight === 0 && <Icon name="check" size={12} />}
                  </button>
                  {upscaleSuggestion.options.map((h) => (
                    <button
                      key={h}
                      type="button"
                      className={`${styles.playerMenuItem} ${appliedUpscaleHeight === h ? styles.playerMenuItemActive : ''}`}
                      onClick={() => applyUpscale(h)}
                      disabled={applyingQuality}
                    >
                      {h}p{h === upscaleSuggestion.recommended ? ' (Recommended)' : ''}
                      {appliedUpscaleHeight === h && <Icon name="check" size={12} />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {partyStatus?.inParty && (
            <button
              type="button"
              className={styles.playerIconButton}
              onClick={() => setPartyPanelOpen((v) => !v)}
              aria-pressed={partyPanelOpen}
              aria-label={`Watch Party — ${partyStatus.members?.length ?? 0} watching`}
              title="Watch Party — members, invite code, and suggestions"
            >
              <Icon name="people" size={15} />
            </button>
          )}

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
