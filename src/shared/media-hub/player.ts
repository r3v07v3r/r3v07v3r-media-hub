// The contract between the player-overlay window and main.
//
// WHY THIS BOUNDARY EXISTS AT ALL. mpv renders into a native child window,
// which on Windows always composites above Chromium's web content — HTML
// cannot be drawn over it within the same window. The controls therefore live
// in a second, transparent, always-on-top BrowserWindow layered on top. That
// window is its own renderer process with its own React tree, so it has no
// access to the main window's AppStateContext. Everything the player UI needs
// crosses these three payload shapes instead.
//
// Everything here is structurally cloneable: it travels over Electron IPC.

import type { MediaTracks } from './types'

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
  | { type: 'set-fit-mode'; mode: 'contain' | 'cover' | 'fill' }

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
  | { type: 'set-party-panel-open'; open: boolean }
  /** Whether the overlay currently wants mouse input. False makes the window
   *  click-through so the video underneath receives the events instead — see
   *  playerWindow.ts's setOverlayInteractive. */
  | { type: 'set-interactive'; interactive: boolean }
