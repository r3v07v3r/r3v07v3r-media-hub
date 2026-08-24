// Owns the "now playing" session: resolving a title's bytes into a local
// StreamCache server and handing that to the embedded player, plus the
// subtitle/thumbnail/cache IPC around it. Active playback is module-level
// singleton state — there is only ever one now-playing session for the whole
// app, not per-window state, and playerBridge.ts's mpv instance deliberately
// matches that shape.
//
// streamCache.ts is the sole owner of the upstream connection to a title's
// remote debrid link. That has not changed with the playback engine, and is
// not something mpv's own --cache replaces: it exists because TorBox caps
// concurrent connections per link, and because a per-title on-disk cache is
// what the Downloads page lists and what a later resume reuses. mpv, like the
// <video> element before it, only ever reads from that one local server.
//
// What DID change: there is no transcode. The old pipeline probed the file with
// ffprobe, decided whether Chromium could decode its audio, and if not (which
// was most real releases — AC3/E-AC3/DTS are all outside what a <video> element
// accepts) re-encoded audio through ffmpeg into a live fragmented-MP4 HTTP
// stream, baking one chosen audio track into the bytes because the element has
// no track-selection API. Every seek and every track change was a full restart
// of that pipeline. mpv demuxes and decodes locally, so none of it is needed —
// see mpv.ts's header.

import { app } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import type {
  CacheSessionMeta,
  MediaTracks,
  PlaybackResult,
  StreamCacheEntry,
  SubtitleSelection,
  SubtitlesApplyResult
} from '../../shared/media-hub/types'
import { handle } from './ipcGuard'
import { getPlaybackBufferSeconds } from '../../shared/media-hub/playbackBuffer'
import { normalizeVideoScaling } from '../../shared/media-hub/videoScaling'
import { reportPreparation } from './playbackProgress'
import { captureThumbnail, mpvPath } from './mpv'
import {
  addSubtitleFileToPlayer,
  pushSessionSnapshot,
  startPlayerSession,
  stopPlayerSession
} from './playerBridge'
import { readSettings } from './settingsStore'
import { setPressure } from './taskScheduler'
import {
  clearAllSessions,
  createStreamCache,
  deleteCacheSession,
  listCacheSessions,
  MIN_CACHE_BYTES,
  pruneIdleSessions
} from './streamCache'
import { downloadSubtitleText } from './subtitlesService'

export { mpvPath } from './mpv'

/** True while a title is actively playing (has a live stream-cache
 *  session) — see appIpc.ts's stream-cache-location handlers, which
 *  refuse to change the cache folder while this is true rather than
 *  leaving the active session's directory behind at the old location
 *  with no way back to it (a live StreamCache instance keeps writing to
 *  the root it captured at start() regardless of a later setting change,
 *  and every list/prune/clear call only ever resolves the CURRENT
 *  setting). */
export function hasActivePlayback(): boolean {
  return Boolean(streamCache.getActiveToken())
}

// The sole owner of the upstream connection to the current title's remote
// link (see streamCache.ts's own header comment). Everything downstream reads
// from its local cache server — the player itself, and the throwaway mpv
// process that captures scrub-bar thumbnails — so the remote link is opened
// exactly once no matter what else needs bytes.
const streamCache = createStreamCache()
// Disk-hygiene backstop for a title that was closed before being marked
// watched (its cache is deliberately left in place for a likely near-term
// resume — see stopPlayback's own comment) — runs once at startup and then
// hourly so a cache dir from days ago doesn't sit around forever.
void pruneIdleSessions()
setInterval(() => void pruneIdleSessions(), 60 * 60 * 1000)

let activeMediaUrl = ''
// StreamCache's local server URL for the current title — what mpv actually
// opens. Distinct from activeMediaUrl (the real, remote debrid link), which
// only streamCache.start() ever touches directly. Thumbnail capture reads from
// this one too, so it never costs a second connection to the remote link.
let activeCacheUrl = ''
let activeMediaTracks: MediaTracks = { video: [], audio: [], subtitle: [], probed: false }
/** The external subtitle file (if any) written for the current title, deleted
 *  with the session. Now handed to mpv via sub-add rather than to a transcode
 *  restart that never read it. */
let activeSubtitlePath = ''

/** 10GB until the person visits Settings — deliberately not "unbounded" as
 *  the out-of-the-box default, since nobody should have their disk start
 *  filling up before ever touching a cache-size setting. An explicit `0`
 *  (the settings UI's own "unbounded/drive-limited" preset) is different
 *  from "never configured" and is honored as-is. */
const DEFAULT_STREAM_CACHE_MAX_BYTES = 10 * 1024 * 1024 * 1024

function resolveStreamCacheMaxBytes(): number {
  const raw = readSettings().streamCacheMaxGb
  if (raw === undefined || raw === null) return DEFAULT_STREAM_CACHE_MAX_BYTES
  const gb = Number(raw)
  if (!Number.isFinite(gb) || gb <= 0) return 0 // explicit unbounded/drive-limited
  return Math.max(MIN_CACHE_BYTES, gb * 1024 * 1024 * 1024)
}

export function subtitleCacheDir(): string {
  return path.join(app.getPath('userData'), 'subtitles-cache')
}

function clearActiveSubtitle(): void {
  if (activeSubtitlePath) {
    try {
      fs.unlinkSync(activeSubtitlePath)
    } catch {
      // best-effort cleanup only
    }
    activeSubtitlePath = ''
  }
}

/**
 * Starts playback of `url`: opens a StreamCache session for it and hands that
 * cache's local server to the embedded player, which demuxes and decodes it
 * directly. Also used by torbox.ts's play:stream/library:play handlers.
 *
 * There is no codec decision here anymore. The old version probed the file and
 * branched into an ffmpeg transcode whenever Chromium could not decode its
 * audio — which was most real releases — see this file's header.
 */
export async function preparePlayback(
  url: string,
  cacheMeta?: CacheSessionMeta
): Promise<PlaybackResult> {
  activeMediaUrl = url
  // StreamCache is the sole owner of the upstream connection to `url`. It is
  // started before the player opens anything, and mpv then reads only from its
  // local server — never the remote link. That constraint has not changed with
  // the engine: it exists because TorBox caps concurrent connections per link,
  // and mpv's own --cache is a readahead window, not a per-title on-disk cache
  // the Downloads page can list.
  //
  // Note what is NO LONGER here: an ffprobe pass against the remote link. It
  // ran before the cache opened, deliberately sequential so the two never
  // overlapped on that one connection. mpv reports the track list itself, so
  // the remote link is now touched by exactly one thing.
  // Everything the app does in the background — the catalog crawls, the
  // franchise-grouping pass, the watch-history reconcile — stands down for
  // the duration. It competes for the same main thread mpv's IPC and the
  // stream cache's fills run on, and for the same bandwidth the person is
  // trying to watch a film over. Raised before the upstream connection
  // opens rather than after the player appears, so the queue is already
  // quiet by the time the first bytes are being pulled.
  setPressure('playback', 'critical')
  reportPreparation('connect', 'Connecting to the source')
  const cacheResult = await streamCache.start(
    url,
    // Not known yet — the duration now arrives from mpv after the file opens,
    // where ffprobe used to supply it before this call. streamCache.setDuration
    // below closes that gap; until then the retention window uses its
    // chunk-count fallback.
    undefined,
    resolveStreamCacheMaxBytes(),
    cacheMeta
  )
  activeCacheUrl = cacheResult.url
  const settings = readSettings()
  reportPreparation('buffer', 'Opening the file')
  // Everything the old branch below this point did — probing codecs, deciding
  // whether ffmpeg was needed, picking a track to bake into `-map 0:a:N`,
  // detecting a hardware encoder, capping the encode height — existed to work
  // around a <video> element that can only be handed one audio track in a codec
  // Chromium happens to decode. mpv demuxes and decodes the source as-is, so
  // the whole decision collapses into opening the file.
  //
  // `alang`/`slang` express the language *preference*; mpv resolves it against
  // the container itself and reports back which track it chose. That replaces
  // selectTranscodeAudioTrack's job of picking a track AND its unfortunate
  // second job of steering away from TrueHD/DTS, which existed only because
  // downmixing those through ffmpeg produced packets Chromium's decoder
  // rejected mid-playback. Nothing is downmixed now, so the best track is
  // simply playable.
  // Resume is not passed here: the overlay fetches the saved position and
  // issues a seek once loaded, which is now instant and in-place. (mpv's
  // `start` option would let the demuxer open AT the resume point instead of
  // opening at 0 and repositioning — a real, if small, saving on StreamCache's
  // first fill. Left for when resume moves into this call deliberately, rather
  // than plumbed through unused.)
  const { tracks } = await startPlayerSession(activeCacheUrl, {
    audioLanguage: settings.audioLanguage || 'en',
    subtitleLanguage: settings.subtitleLanguage || undefined,
    bufferSeconds: getPlaybackBufferSeconds(settings.playbackBuffer),
    videoScaling: normalizeVideoScaling(settings.videoScaling)
  })
  activeMediaTracks = tracks
  // Now that mpv has opened the file, hand its duration to the cache so the
  // retention window can size itself in bytes rather than chunk counts.
  streamCache.setDuration(tracks.durationSeconds)

  // Tell the overlay window what it is playing. Its own state channel only
  // carries mpv's properties — position, tracks, cache state — none of which
  // say which title this is, so without this the control bar has a real
  // scrubber above a blank name. `cacheMeta` already carries exactly these
  // fields because the Downloads page lists cached sessions by them.
  pushSessionSnapshot({
    media: cacheMeta
      ? {
          id: cacheMeta.catalogId ?? '',
          title: cacheMeta.title,
          kind: cacheMeta.mediaKind ?? 'movie',
          seasonNumber: cacheMeta.seasonNumber,
          episodeNumber: cacheMeta.episodeNumber,
          posterUrl: cacheMeta.posterUrl
        }
      : null,
    tracks: activeMediaTracks,
    // Resume is applied by the overlay itself (seeks are in-place now), so this
    // is informational rather than something to act on.
    resumeSeconds: 0,
    settings: {
      bufferSeconds: getPlaybackBufferSeconds(settings.playbackBuffer),
      autoSubtitlesEnabled: settings.autoSubtitlesEnabled !== false,
      subtitleLanguage: settings.subtitleLanguage || 'en',
      audioLanguage: settings.audioLanguage || 'en'
    }
  })

  return {
    ok: true,
    player: 'embedded',
    tracks: activeMediaTracks,
    selection: { audio: activeMediaTracks.audio.find((track) => track.default)?.ordinal ?? 0 },
    // The player reads from StreamCache's local server directly. Kept in the
    // result because the Downloads page and the party-sync paths still key off
    // it; the renderer no longer loads it into anything itself.
    url: activeCacheUrl
  }
}

/** Clears active playback state (URL/tracks/subtitle file), and tears down
 *  StreamCache and any running ffmpeg transcoder. `deleteCache` (passed
 *  from the renderer's real close, gated on the title having already
 *  crossed the 80%-watched mark — see PlaybackOverlay's markedWatchedRef)
 *  deletes the title's cache directory outright rather than leaving it for
 *  the idle sweep; otherwise the cache is left on disk for a likely
 *  near-term resume. */
export async function stopPlayback(deleteCache = false): Promise<void> {
  // Released here rather than in a `finally` around playback, because this
  // is the one function every end-of-playback path goes through — the
  // renderer closing the player, a new title replacing this one, and the
  // app quitting. A missed release would leave background work suspended
  // for the rest of the session with nothing playing to explain it.
  setPressure('playback', 'idle')
  activeMediaUrl = ''
  activeCacheUrl = ''
  activeMediaTracks = { video: [], audio: [], subtitle: [], probed: false }
  clearActiveSubtitle()
  // Unloads the title and closes the control overlay, which is also what
  // destroys mpv's embedded video window and reveals the app UI behind it. The
  // mpv process itself stays alive and idle so the next title is a `loadfile`
  // rather than a respawn.
  await Promise.all([
    deleteCache ? streamCache.deleteSession() : streamCache.stop(),
    stopPlayerSession()
  ])
}

interface SubtitlesApplyPayload {
  provider?: unknown
  fileId?: unknown
  downloadPath?: unknown
}

/**
 * Validates the untrusted subtitle selection coming back over IPC into a
 * SubtitleSelection, or throws.
 *
 * Which field has to be valid depends on the provider, so the provider is
 * checked first and the other field is discarded rather than trusted: a
 * payload claiming `subdl` never reaches the OpenSubtitles download path on
 * the strength of a fileId it also happened to carry. The archive path
 * itself is re-validated at the point of use (subdl.ts's
 * resolveSubdlDownloadUrl), which is the actual SSRF boundary — this only
 * rejects the obviously malformed early, with a message the menu can show.
 */
function parseSubtitleSelection(payload: SubtitlesApplyPayload | undefined): SubtitleSelection {
  if (payload?.provider === 'subdl') {
    const downloadPath = String(payload?.downloadPath || '')
    if (!downloadPath) throw new Error('Invalid subtitle selection.')
    return { provider: 'subdl', fileId: 0, downloadPath }
  }
  const fileId = Number(payload?.fileId)
  if (!Number.isInteger(fileId) || fileId <= 0) throw new Error('Invalid subtitle selection.')
  return { provider: 'opensubtitles', fileId, downloadPath: '' }
}

export function registerPlaybackIpc(): void {
  handle<SubtitlesApplyPayload | undefined, SubtitlesApplyResult>(
    MEDIA_HUB_CHANNELS.subtitlesApply,
    async (_event, payload) => {
      if (!activeMediaUrl) throw new Error('No active media is available for subtitles.')
      const srtText = await downloadSubtitleText(parseSubtitleSelection(payload))
      clearActiveSubtitle()
      const dir = subtitleCacheDir()
      fs.mkdirSync(dir, { recursive: true })
      const filePath = path.join(dir, `${crypto.randomBytes(16).toString('hex')}.srt`)
      fs.writeFileSync(filePath, srtText, { mode: 0o600 })
      activeSubtitlePath = filePath
      // Handed straight to the player rather than converted or burned in. Both
      // of the old branches are gone: the renderer no longer mounts a WebVTT
      // <track> (so nothing calls srtToVtt, and with it goes the silent failure
      // where an .ass or frame-based .sub came back from a provider, got
      // `WEBVTT` stapled to the front, and produced a track with zero parseable
      // cues that the app reported as success), and the compatibility branch
      // that restarted the transcode with an `externalSubtitlePath`
      // buildFfmpegArguments never actually read is gone with the transcode.
      const ordinal = await addSubtitleFileToPlayer(filePath)
      return { ok: true, ordinal }
    }
  )

  handle<{ watched?: boolean } | undefined, { ok: true }>(
    MEDIA_HUB_CHANNELS.playbackStop,
    async (_event, payload) => {
      await stopPlayback(Boolean(payload?.watched))
      return { ok: true }
    }
  )

  handle<number | undefined, string | null>(
    MEDIA_HUB_CHANNELS.playbackThumbnail,
    async (_event, seconds) => {
      if (!activeCacheUrl) return null
      return captureThumbnail(mpvPath, activeCacheUrl, Number(seconds) || 0)
    }
  )

  handle<undefined, { ok: true; freedBytes: number }>(
    MEDIA_HUB_CHANNELS.subtitlesClearCache,
    () => {
      const dir = subtitleCacheDir()
      let freedBytes = 0
      let entries: string[] = []
      try {
        entries = fs.readdirSync(dir)
      } catch {
        return { ok: true, freedBytes: 0 }
      }
      for (const entry of entries) {
        const filePath = path.join(dir, entry)
        try {
          freedBytes += fs.statSync(filePath).size
          fs.unlinkSync(filePath)
        } catch {
          // Best-effort — a file already gone or locked shouldn't fail the
          // whole clear, same as any other cache-clear operation.
        }
      }
      return { ok: true, freedBytes }
    }
  )

  handle<undefined, StreamCacheEntry[]>(MEDIA_HUB_CHANNELS.streamCacheList, async () =>
    listCacheSessions(streamCache.getActiveToken())
  )

  handle<{ token?: unknown } | undefined, { ok: true }>(
    MEDIA_HUB_CHANNELS.streamCacheDelete,
    async (_event, payload) => {
      const token = String(payload?.token || '')
      if (token && token === streamCache.getActiveToken()) {
        throw new Error("Can't delete — this title is currently playing.")
      }
      await deleteCacheSession(token)
      return { ok: true }
    }
  )

  handle<undefined, { ok: true; freedBytes: number }>(
    MEDIA_HUB_CHANNELS.streamCacheClear,
    async () => ({ ok: true, freedBytes: await clearAllSessions() })
  )
}
