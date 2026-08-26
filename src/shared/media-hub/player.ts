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
import type { NextEpisodeRef } from './nextEpisode'
import type { SubtitleStyle } from './subtitleStyle'
import type { VideoFitMode } from './videoFit'
import type { VideoPictureControl } from './videoPicture'

/**
 * How long the post-play card counts down before starting the next episode.
 *
 * Ten seconds is the figure the players people compare this one to have
 * settled on (Netflix, Plex and Jellyfin are all within a second or two of
 * it), and the reasoning behind it is worth keeping: long enough to read the
 * next episode's name and press Stop on purpose, short enough that sitting
 * through it never feels like being made to wait.
 */
export const AUTOPLAY_NEXT_COUNTDOWN_SECONDS = 10

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

/**
 * The audio filter behind Night mode.
 *
 * The problem it solves is the one that makes people reach for the remote
 * twice a scene: a film mixed for a cinema puts dialogue thirty decibels below
 * the score, so the choice is inaudible speech or a explosion that wakes the
 * house. `dynaudnorm` normalises loudness over a moving window, which lifts
 * the quiet parts without flattening the loud ones into mush the way a hard
 * compressor does.
 *
 * The numbers are deliberately gentle. `f=200` is a 200ms frame and `g=15` a
 * fifteen-frame window — roughly three seconds of context, long enough that
 * the gain does not audibly move within a line of dialogue, which is what
 * "pumping" sounds like. `p=0.6` leaves headroom rather than driving
 * everything to the ceiling, and `m=8` caps how much any one passage can be
 * lifted so a genuinely silent moment stays silent instead of becoming a wall
 * of amplified room tone.
 *
 * Wrapped in mpv's `lavfi=[...]` form rather than passed bare: the bare form
 * relies on mpv auto-detecting a libavfilter name, which works but is not the
 * documented spelling.
 */
export const NIGHT_MODE_AUDIO_FILTER = 'lavfi=[dynaudnorm=f=200:g=15:p=0.6:m=8]'

/**
 * How far one press of the volume keys moves it, in the same units — 5%.
 *
 * Shared for the same reason as the ceiling: the keys are handled TWICE,
 * once by the overlay when it has focus and once by main when mpv's own
 * window took the keystroke instead (playerBridge's client-message handler).
 * Two different steps would make the same key move the volume by different
 * amounts depending on which window happened to be focused.
 */
export const PLAYER_VOLUME_STEP = 0.05

/** The subset of a catalog item the player UI actually reads. Deliberately not
 *  the full MediaItem: that type lives in the renderer, and anything needing
 *  the whole record (mark-watched's trackable payload, for one) is handled by
 *  the main window, which already holds it — see PlayerUiEvent. */
/** One chapter mark, as mpv reports them. */
export interface PlayerChapter {
  title: string
  /** Seconds from the start of the file. */
  time: number
}

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
  /**
   * The episode that follows this one, for the post-play card — null for a
   * movie, for the last episode of a title, and for the whole of the window
   * before it has been worked out.
   *
   * Resolved by main AFTER the first snapshot goes out, and pushed as a
   * second one, because finding it means a metadata read that playback must
   * never wait behind (see playbackSession.ts's resolveNextUp). The overlay
   * therefore has to treat this as "not known YET" rather than "there is
   * none" — which costs it nothing, since it has no use for the value until
   * the file ends.
   */
  nextUp: NextEpisodeRef | null
  settings: {
    /** 3 | 8 | 15 — see shared/media-hub/playbackBuffer.ts. */
    bufferSeconds: number
    autoSubtitlesEnabled: boolean
    subtitleLanguage: string
    audioLanguage: string
    /** Whether reaching the end of an episode offers the next one. */
    autoplayNextEnabled: boolean
    /** The stored look, already applied to mpv — present so the menu opens
     *  showing what is in force rather than the defaults. */
    subtitleStyle: SubtitleStyle
    /** Whether loudness normalization is on. */
    nightModeEnabled: boolean
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
  /** The file's chapter marks, in order. Empty for the many releases that
   *  carry none, which is why the chapters button is absent rather than
   *  disabled when this is empty. */
  chapters?: PlayerChapter[]
  /** Index into `chapters` of the one currently playing, or -1. */
  chapter?: number
  /** mpv's audio delay in seconds — observed rather than assumed, so the
   *  control shows what is actually applied after a title change resets it. */
  audioDelay?: number
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
  /** The same correction for audio, which a badly muxed release needs just as
   *  often and in the opposite direction. */
  | { type: 'set-audio-delay'; seconds: number }
  /** Jump to a chapter by its index in the observed `chapters` list. */
  | { type: 'set-chapter'; index: number }
  /** Size, position, colour and background box — see
   *  shared/media-hub/subtitleStyle.ts. Applied as one command because the
   *  four are one visual decision and applying them separately makes the
   *  subtitle flicker through intermediate states. */
  | { type: 'set-subtitle-style'; style: SubtitleStyle }
  /** Evens out a mix with quiet dialogue and a loud score — see
   *  NIGHT_MODE_AUDIO_FILTER. Stored, because somebody who needs it once
   *  needs it for everything they watch on that setup. */
  | { type: 'set-night-mode'; enabled: boolean }
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
  /** Start the next episode — raised by the post-play card, either because its
   *  countdown ran out or because somebody pressed Play now.
   *
   *  The coordinate travels with the event rather than being recomputed on the
   *  other side. The main window holds the MediaItem but not the episode list
   *  (only main resolves that, into the session's `nextUp`), so recomputing
   *  there would mean a second metadata read that could disagree with the
   *  episode the person was just shown. This says "start the one on the card",
   *  which is the only answer that can't surprise them. Main-window side
   *  revalidates both numbers before playing anything. */
  | { type: 'play-next'; season: number; episode: number }
  /** Report in-progress playback to the tracking services.
   *
   *  Raised on TRANSITIONS only — started, paused, stopped — not on a timer.
   *  Simkl's scrobble endpoints are a state machine, not a heartbeat, and a
   *  call per tick would be a request every few seconds for the whole length
   *  of a film.
   *
   *  Like mark-watched, this carries no item: building the payload needs the
   *  full MediaItem and that record lives in the main window. */
  | { type: 'scrobble'; action: 'start' | 'pause' | 'stop'; progress: number }
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
