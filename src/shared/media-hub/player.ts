// The contract between the player-overlay window and main.
//
// WHY THIS BOUNDARY EXISTS AT ALL. mpv renders into a native child window,
// which on Windows always composites above Chromium's web content — HTML
// cannot be drawn over it within the same window. The controls therefore live
// in a second, transparent BrowserWindow layered on top. That
// window is its own renderer process with its own React tree, so it has no
// access to the main window's AppStateContext. Everything the player UI needs
// crosses these three payload shapes instead.
//
// Everything here is structurally cloneable: it travels over Electron IPC.

import type { MediaTracks } from './types'
import type { VideoFitMode } from './videoFit'
import type { VideoPictureControl } from './videoPicture'

/**
 * Loudest the player can be asked to go, as a multiplier of the source's own
 * level: 1 is the untouched signal, 2 is twice it.
 *
 * Above 1 mpv amplifies in software, which is the only thing that rescues a
 * film mixed quiet — dialogue buried under the score, a stereo downmix of a
 * 5.1 track with everything but the centre channel loud. Past roughly 2 the
 * amplification stops helping and starts clipping the peaks it cannot fit, so
 * the ceiling is set there rather than at mpv's own 1000% maximum.
 *
 * Three places must agree on this number: mpv's --volume-max (mpv.ts), which
 * makes mpv REJECT any higher value outright; the clamp on the set-volume
 * command (playerBridge.ts); and the slider's range (PlayerOverlayWindow.tsx).
 * They all import it from here for that reason.
 */
export const MAX_PLAYER_VOLUME = 2

/** The subset of a catalog item the player UI actually reads. Deliberately not
 *  the full MediaItem: that type lives in the renderer, and anything needing
 *  the whole record (mark-watched's trackable payload, for one) is handled by
 *  the main window, which already holds it — see PlayerUiEvent. */
export interface PlayerSessionMedia {
  id: string
  title: string
  kind: 'movie' | 'series' | 'anime'
  seasonNumber?: number
  episodeNumber?: number
  episodeTitle?: string
  posterUrl?: string
}

/** Pushed to the overlay on `playerSession` whenever any of it changes. A whole
 *  snapshot rather than deltas — it changes rarely (a title change, a settings
 *  edit, a party roster update), so the simplicity is worth more than the
 *  bytes, and it removes any chance of the overlay applying patches in the
 *  wrong order. */
export interface PlayerSessionSnapshot {
  media: PlayerSessionMedia | null
  tracks: MediaTracks | null
  /** Seconds to resume from, already applied to mpv as its `start` option —
   *  present so the UI can show it, not so it can seek there itself. */
  resumeSeconds: number
  settings: {
    /** 3 | 8 | 15 — see shared/media-hub/playbackBuffer.ts. */
    bufferSeconds: number
    autoSubtitlesEnabled: boolean
    subtitleLanguage: string
    audioLanguage: string
  }
}

/**
 * Observed mpv properties, pushed on `playerState`. A partial patch: only the
 * properties that actually changed are present, so an absent key means
 * "unchanged", not "null".
 *
 * These replace the reads the renderer used to get for free from the <video>
 * element. The mapping is deliberately one-for-one so the port stays reviewable:
 *   video.currentTime  -> timePos        video.paused    -> paused
 *   video.duration     -> duration       video.volume    -> volume
 *   video.playbackRate -> speed          video.buffered  -> cacheEndSeconds
 */
export interface PlayerStatePatch {
  /** Absolute position in the source. Unlike the old compatibility-mode clock,
   *  this needs no segment-offset correction — there are no segments. */
  timePos?: number
  duration?: number
  paused?: boolean
  volume?: number
  speed?: number
  /** 0-based ordinal of the active audio track, -1 for none. Already converted
   *  from mpv's 1-based `aid` — see mpv.ts's ordinalForMpvTrackId. */
  audioOrdinal?: number
  /** 0-based ordinal of the active subtitle track, -1 for none. */
  subtitleOrdinal?: number
  /** How far ahead of the playhead the demuxer cache reaches, in seconds. The
   *  closest equivalent to `video.buffered.end(last) - video.currentTime`, and
   *  what the buffering gate waits on. */
  cacheAheadSeconds?: number
  /** True while mpv has stalled waiting for its cache to refill. */
  bufferingForCache?: boolean
  /** Set once playback reaches the end of the file naturally. */
  eofReached?: boolean
  /** Track list changed — e.g. an external subtitle was added. */
  tracks?: MediaTracks
  /** Current fit mode. Not observed off mpv like the rest of this patch:
   *  `keepaspect` and `panscan` are two properties describing one user-facing
   *  choice, and main is the side that knows which choice they add up to — so
   *  it pushes the mode it just applied rather than the overlay inferring it. */
  fitMode?: VideoFitMode
  /** MPV's live picture offsets. Each is an integer in the -100–100 range;
   * zero is the original picture. */
  brightness?: number
  contrast?: number
  saturation?: number
  gamma?: number
  /** A terminal playback failure. mpv reports these through `end-file` with a
   *  reason rather than anything resembling MediaError.code. */
  error?: string
}

/**
 * Overlay -> main. One channel for every player operation, as a discriminated
 * union, so all of them are validated in the same place before reaching mpv.
 *
 * `seek` is absolute seconds. Note what is NOT here: nothing restarts a
 * stream, because nothing needs to — seeking, switching audio, and switching
 * subtitles are all in-place operations on a demuxer that stays open.
 */
export type PlayerCommand =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'toggle-pause' }
  | { type: 'seek'; seconds: number }
  | { type: 'set-audio-track'; ordinal: number }
  | { type: 'set-subtitle-track'; ordinal: number }
  | { type: 'set-volume'; volume: number }
  /** Party drift correction. mpv preserves pitch by default, matching the
   *  behaviour partySync.ts's control law was tuned against. */
  | { type: 'set-speed'; speed: number }
  /** Loads an external subtitle file already written to disk by the
   *  subtitles:apply flow, and selects it. */
  | { type: 'add-subtitle-file'; path: string }
  /** Manual subtitle timing offset in seconds — the thing VLC users fix in two
   *  keypresses and the old <track>-based pipeline had no way to express. */
  | { type: 'set-subtitle-delay'; seconds: number }
  /** How the picture is fitted into the window — see shared/media-hub/videoFit.ts. */
  | { type: 'set-fit-mode'; mode: VideoFitMode }
  /** One of the small set of live MPV picture controls. */
  | { type: 'set-picture-control'; control: VideoPictureControl; value: number }
  /** Returns every picture control to the original, unadjusted picture. */
  | { type: 'reset-picture-controls' }

/**
 * Main -> overlay. An input that arrived at mpv's own window rather than the
 * controls, forwarded so the overlay can apply it through exactly the handlers
 * its own clicks and keys use.
 *
 * mpv's window receives input whenever the controls are hidden, because the
 * overlay is click-through then and only mousemove is forwarded to it. Acting
 * on those directly in main is what this type exists to avoid: main has no
 * access to the party rules (they live in the overlay's usePartySync), so a
 * pause applied there would pause one person and leave the rest of the watch
 * party playing.
 */
export interface PlayerInputEvent {
  action: 'toggle-pause' | 'toggle-fullscreen'
}

/**
 * Overlay -> main -> main window. Actions whose effect belongs to the main
 * window's own React state, which the overlay process cannot touch directly.
 *
 * `mark-watched` is here rather than in PlayerCommand because it needs the full
 * MediaItem to build its trackable payload, and that record lives in the main
 * window — sending it across twice just to send it back would be worse.
 */
export type PlayerUiEvent =
  | { type: 'stop-playback'; watched: boolean }
  | { type: 'mark-watched' }
  | { type: 'refresh-watch-status' }
  | { type: 'notify'; tone: 'info' | 'error' | 'success'; message: string }
  /** Overlay -> main -> main window: OPEN the party panel. A command, for a
   *  panel that is not open yet — the only one of these three that main passes
   *  on to the main window rather than acting on and stopping. */
  | { type: 'set-party-panel-open'; open: boolean }
  /** Main window -> main: the party panel IS open, so the video has to give up
   *  the front. A report, not a command, which is why it is a separate event
   *  from set-party-panel-open rather than the same one sent the other way: a
   *  report that main echoed back would reach this window as an instruction to
   *  open, and one still in flight when the person closes the panel would land
   *  after them and re-open it.
   *
   *  Sent on the closed -> open edge, and again on every title change so a
   *  mainWindowUiOpen that has drifted false is repaired by the next thing
   *  played rather than staying wrong. */
  | { type: 'party-panel-open' }
  /** Main window -> main: the party panel has gone, so the video can have the
   *  front back. The other half of the report pair above. See playerBridge's
   *  handling of party-panel-open for why the front was given up at all, and
   *  mainWindowUiOpen for why main takes this window's word for the close
   *  rather than inferring it from playback ending. Sent on every open ->
   *  closed edge whatever is playing, and once on mount so a main process that
   *  outlived a renderer reload cannot be left holding a stale "open" — which
   *  would keep the video under the app indefinitely. */
  | { type: 'party-panel-closed' }
  /** Whether the overlay currently wants mouse input. False makes the window
   *  click-through so the video underneath receives the events instead — see
   *  playerWindow.ts's setOverlayInteractive. */
  | { type: 'set-interactive'; interactive: boolean }
  /** Whether this window is actually listening for forwarded input yet.
   *
   *  Sent when the PlayerInputEvent subscription is established and again when
   *  it goes away. Main cannot infer it: the overlay window exists well before
   *  its renderer has mounted anything, and webContents.send to a window with
   *  no listener is silently dropped. Without this, mpv's safety inputs would
   *  be forwarded into nothing during startup or after a renderer failure —
   *  precisely the states those bindings exist for. */
  | { type: 'set-input-ready'; ready: boolean }
