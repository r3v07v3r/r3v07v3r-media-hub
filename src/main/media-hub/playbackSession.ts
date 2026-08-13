// Ported from r3v07v3r-media-hub's src/main.cjs (subtitleCacheDir/
// clearActiveSubtitle/preparePlayback/stopPlayback, the module-level
// activeMediaUrl/activeMediaTracks/activeSubtitlePath/streamCache/
// ffmpegTranscoder/ffprobePath/ffmpegPath singletons, and the
// subtitles:apply/playback:compatibility/playback:select-tracks/
// playback:stop/playback:thumbnail IPC handlers). Active playback is
// intentionally kept as module-level singleton state, exactly as in the
// original app: there is only ever one "now playing" session for the whole
// app, not per-window/per-session state.
//
// `ffmpegPath`/`ffprobePath` are computed once at module load (same as the
// original's module-level consts) and exported so other modules don't each
// re-run their own executable discovery. Compatibility-mode transcoding
// used to shell out to a separately-installed VLC — see vlc.ts's header
// comment for why that's now ffmpeg (bundled with the app) instead.
//
// streamCache.ts is the sole owner of the upstream connection to a title's
// remote debrid link — the direct-proxy/ffmpeg connection-swap dance that
// used to live here (closeDirectProxyBeforeTranscode, directModeActive) is
// gone: both playback modes now read from that one local cache server, so
// switching between them never touches the remote link at all.

import { app, screen } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import type {
  MediaTracks,
  PlaybackResult,
  PlaybackSelection,
  SubtitlesApplyResult
} from '../../shared/media-hub/types'
import { handle } from './ipcGuard'
import { logError, redactUrls } from './logger'
import { srtToVtt } from './opensubtitles'
import { readSettings, writeSettings } from './settingsStore'
import { clearAllSessions, createStreamCache, MIN_CACHE_BYTES, pruneIdleSessions } from './streamCache'
import { osDownloadSubtitleText } from './subtitlesService'
import {
  captureFrame,
  createFfmpegTranscoder,
  detectVideoEncoder,
  extractSubtitleTracksBatch,
  findFfmpeg,
  findFfprobe,
  needsAudioCompatibility,
  probeMedia,
  selectTranscodeAudioTrack,
  TEXT_SUBTITLE_CODECS,
  videoCodecCompatibilityWarning,
  videoResolutionUpscaleSuggestion,
  type FfmpegTranscoderResult
} from './vlc'

/** Ceiling for a FORCED video re-encode (see preparePlayback). 1080p is
 *  the point where a real-time encode reliably starts inside the startup
 *  budget on ordinary hardware; 2160p routinely did not. */
const TRANSCODE_MAX_HEIGHT = 1080

export const ffmpegPath = findFfmpeg()
export const ffprobePath = findFfprobe()

// The sole owner of the upstream connection to the current title's remote
// link (see streamCache.ts's own header comment). Both playback modes now
// read from its local cache server: ffmpeg's `-i` in compatibility mode,
// and the <video> element directly in direct mode — there is no longer a
// "direct proxy vs ffmpeg" connection-swap to coordinate, since neither of
// them ever touches the remote link themselves anymore.
const streamCache = createStreamCache()
// Disk-hygiene backstop for a title that was closed before being marked
// watched (its cache is deliberately left in place for a likely near-term
// resume — see stopPlayback's own comment) — runs once at startup and then
// hourly so a cache dir from days ago doesn't sit around forever.
void pruneIdleSessions()
setInterval(() => void pruneIdleSessions(), 60 * 60 * 1000)

const ffmpegTranscoder = createFfmpegTranscoder({
  onLog: (line) => logError('ffmpeg:stderr', redactUrls(line.trim()))
})

let activeMediaUrl = ''
// StreamCache's local server URL for the current title — what ffmpeg's
// `-i` and the direct-mode <video> element actually read from. Distinct
// from activeMediaUrl (the real, remote debrid link), which only probeMedia
// and streamCache.start() itself ever touch directly.
let activeCacheUrl = ''
let activeMediaTracks: MediaTracks = { video: [], audio: [], subtitle: [], probed: false }
let activeSubtitlePath = ''
// Sticky across every ffmpeg restart for the current title (seek, track
// change, subtitle apply, explicit quality change) — not just the call
// that first resolved them. Before this, a seek during video-transcode
// mode silently dropped back to `-c:v copy` because select-tracks never
// knew an encoder was even in play; upscale would have had the exact same
// gap. `activeVideoEncoderReason` distinguishes *why* the encoder is
// engaged so turning upscale back off doesn't strand a codec-compatibility
// re-encode running (or vice versa: turning it on for upscale-only reasons
// shouldn't look like a codec fix was needed).
let activeVideoEncoder: string | undefined
let activeVideoEncoderReason: 'codec' | 'upscale' | undefined
let activeUpscaleHeight: number | undefined

// Set once a video re-encode has actually failed to start on this
// machine. The fallback below recovers playback, but only after burning
// the full startup budget waiting — and the outcome doesn't change from
// one title to the next, so paying that again on every play would be a
// pointless 60s tax. Remembering it turns the second and later plays
// straight into the stream-copy path. Deliberately session-scoped (not
// persisted): hardware, drivers and the encoder set can change between
// runs, so a restart re-tests rather than writing the machine off.
let videoEncodeUnusable = false

// The whole-file, all-text-tracks batch subtitle extraction for the current
// title (see extractSubtitleTracksBatch's own comment on why batched) —
// computed at most once per title, on first request, and shared by every
// ordinal the subtitle menu asks for afterward. Only runs once
// streamCache.fullRetentionReady() — extracting against a not-yet-fully-
// cached title would mean reading past what's locally available, which is
// exactly the second-connection risk this whole feature exists to remove
// (see playbackExtractSubtitle's own handler below). Cleared with the
// session, same as before.
let subtitleBatchPromise: Promise<Map<number, string>> | null = null

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

/**
 * Starts (or restarts) the ffmpeg transcoder for the current title, with
 * the same recovery preparePlayback's own initial start already had: if a
 * FORCED video re-encode fails to start, that must never take playback
 * down with it — trip the circuit breaker, drop the encoder, and retry as
 * a stream-copy, instead of leaving the caller with a bare rejected
 * promise and the same doomed encoder still armed for next time.
 *
 * Before this, only the very FIRST start of a title (preparePlayback) had
 * that recovery — every RESTART (a seek, a subtitle apply, a track/
 * quality change) called ffmpegTranscoder.start() directly, inheriting
 * whatever `activeVideoEncoder` preparePlayback had armed, with no catch
 * at all. Reported live: a title played fine, then failed with an error a
 * few seconds after a pause/resume (which restarts the transcode the
 * same way a seek does — see handleSeek's own comment) — and then
 * wouldn't play again at all. The re-encode failing on THAT restart
 * (not necessarily on the title's very first start) never set
 * videoEncodeUnusable, so every later restart, and every fresh
 * preparePlayback() from clicking Play again, kept re-arming and
 * retrying the identical doomed re-encode — each one burning up to the
 * full 60s startup budget before failing the exact same way again.
 */
async function startTranscodeWithFallback(
  selection: PlaybackSelection,
  targetHeight?: number
): Promise<FfmpegTranscoderResult> {
  // Every restart (seek/track/quality change) proactively repositions
  // StreamCache's sequential fetch toward the new position first — by the
  // time ffmpeg's own -ss lands against the local cache moments later, the
  // bytes it wants are already there or arriving, instead of ffmpeg's
  // first read discovering the gap itself. Best-effort/non-blocking (see
  // streamCache.ts's own comment) — never anything to await here.
  if (Number.isFinite(selection.startTime)) streamCache.seekHint(Number(selection.startTime))
  try {
    return await ffmpegTranscoder.start(
      ffmpegPath,
      activeCacheUrl,
      selection,
      activeVideoEncoder,
      targetHeight
    )
  } catch (error) {
    if (!activeVideoEncoder) throw error
    logError('playback:transcode', `video re-encode failed on restart, retrying stream-copy: ${error}`)
    videoEncodeUnusable = true
    activeVideoEncoder = undefined
    activeVideoEncoderReason = undefined
    await ffmpegTranscoder.stop()
    return ffmpegTranscoder.start(ffmpegPath, activeCacheUrl, selection, undefined, targetHeight)
  }
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
 * Probes `url` and starts embedded playback for it: either directly (the
 * <video> element reading straight from StreamCache's local cache server)
 * or, by transcoding through ffmpeg (also reading from that same local
 * server, never the remote link itself) — always audio when the source's
 * audio codec isn't browser-compatible, and (opt-in, see Settings > More
 * Options' "Convert incompatible video") video too when the source's video
 * codec is one Chromium can't reliably decode and a real hardware encoder
 * is actually available on this machine (see vlc.ts's detectVideoEncoder —
 * never falls back to a software encoder). Also used by torbox.ts's
 * play:stream/library:play handlers.
 */
export async function preparePlayback(url: string): Promise<PlaybackResult> {
  activeMediaUrl = url
  subtitleBatchPromise = null
  await ffmpegTranscoder.stop()
  activeMediaTracks = await probeMedia(ffprobePath, url)
  // StreamCache becomes the sole owner of the upstream connection to `url`
  // from here on — probeMedia above is the one remote touch that happens
  // BEFORE it (sequential, already complete by this point, so it never
  // overlaps with StreamCache's own connection). Started even for a title
  // that turns out not to need ffmpeg at all: direct-mode playback below
  // reads from this same local server instead of proxying the remote link
  // per-Range-request the way the old playbackProxy did.
  const cacheResult = await streamCache.start(
    url,
    activeMediaTracks.durationSeconds,
    resolveStreamCacheMaxBytes()
  )
  activeCacheUrl = cacheResult.url
  // Fresh title — none of the previous one's sticky transcode state
  // carries over (a new upscale suggestion gets computed below either way).
  activeVideoEncoder = undefined
  activeVideoEncoderReason = undefined
  activeUpscaleHeight = undefined
  const videoCodecWarning = videoCodecCompatibilityWarning(activeMediaTracks)
  // probeMedia already retries once internally — reaching here with
  // `probed: false` while ffprobePath IS set means both attempts genuinely
  // failed (a bad/slow link), so audio-codec detection below has nothing
  // to work with and silently takes the "no compatibility issue found"
  // branch. Told upfront rather than leaving no sound/no track menus with
  // no explanation (see probeMedia's own comment). Gated on ffprobePath so
  // this doesn't fire on every single title on a machine where ffprobe
  // just isn't installed/bundled at all (findFfprobe returned '') — that's
  // a standing environment gap "try playing again" can't fix, not a
  // one-off transient failure worth telling anyone about per-title.
  const tracksWarning =
    activeMediaTracks.probed || !ffprobePath
      ? undefined
      : "Couldn't read this file's audio/subtitle track info — playback may have no sound or subtitle options. Try playing again."
  if (
    videoCodecWarning &&
    ffmpegPath &&
    !videoEncodeUnusable &&
    readSettings().videoTranscodeEnabled
  ) {
    activeVideoEncoder = (await detectVideoEncoder(ffmpegPath)) ?? undefined
    if (activeVideoEncoder) activeVideoEncoderReason = 'codec'
  }
  // Independent of the codec-compatibility path above — a screen-height
  // lookup and a filter/sort over a 3-item array, never touches ffmpeg, so
  // it's always cheap to compute and safe to surface on every title.
  const settings = readSettings()
  // Which language to play when the file offers a choice. Consulted below
  // both for picking the track AND for deciding whether ffmpeg is needed
  // at all — direct playback hands the file to Chromium, which has no way
  // to be told which audio track to use.
  const audioLanguage = settings.audioLanguage || 'en'
  const screenHeight = screen.getPrimaryDisplay()?.workAreaSize?.height
  const upscaleSuggestion = videoResolutionUpscaleSuggestion(
    activeMediaTracks,
    screenHeight,
    settings.preferredUpscaleHeight
  )
  if ((needsAudioCompatibility(activeMediaTracks, audioLanguage) || activeVideoEncoder) && ffmpegPath) {
    // Cap the height when we're FORCED to re-encode video. Re-encoding
    // 2160p in real time is what made 4K HEVC titles unplayable: ffmpeg
    // never produced its first bytes inside even the extended 60s startup
    // budget, so the title failed outright. Scaling to 1080p first cuts
    // the encoder's pixel rate by ~4x and is invisible on any normal
    // display at normal viewing distance — a 1080p stream that starts is
    // strictly better than a 2160p one that never does.
    //
    // Only applies on the re-encode path (activeVideoEncoder set); a
    // stream-copy is untouched and still delivers the source resolution
    // exactly. An explicit upscale preference still wins, since that's the
    // person deliberately asking for a specific output height.
    const sourceHeight = Number(activeMediaTracks.video?.[0]?.height) || 0
    const encodeHeight =
      activeUpscaleHeight ??
      (sourceHeight > TRANSCODE_MAX_HEIGHT ? TRANSCODE_MAX_HEIGHT : undefined)
    const audioSelection = {
      audio: selectTranscodeAudioTrack(activeMediaTracks, audioLanguage)?.ordinal ?? 0
    }
    // "Convert incompatible video" is an opt-in, explicitly experimental
    // setting, and on a 2160p HEVC source it reliably blew the whole 60s
    // startup budget without emitting a frame — so with it on, every 4K
    // title simply failed to play, while the very same title plays in
    // ~13s by stream-copying the video and converting only the audio
    // (verified live: hevc 3840x2160, HDR intact). Chromium decodes HEVC
    // itself, which is what makes the fallback viable rather than a
    // consolation prize: the copy path preserves the source resolution
    // and HDR metadata exactly, where a successful re-encode would have
    // thrown both away. Recovery itself lives in
    // startTranscodeWithFallback, shared with every restart path below.
    const started = await startTranscodeWithFallback(audioSelection, encodeHeight)
    return {
      ok: true,
      player: 'embedded',
      tracks: activeMediaTracks,
      // What ffmpeg was actually told to play — not the container's own
      // default, which selectTranscodeAudioTrack may well have declined.
      // The player marks its audio menu from this.
      selection: { ...audioSelection, upscaleHeight: activeUpscaleHeight ?? 0 },
      autoReason: activeVideoEncoder
        ? 'Video and audio were converted for compatibility.'
        : 'Audio was converted for browser compatibility.',
      // Actually addressed by the video-transcode path above, so no need
      // to warn about it too — still surfaced when audio-only compatibility
      // mode ran instead (opted out, or no working hardware encoder found).
      videoCodecWarning: activeVideoEncoder ? undefined : videoCodecWarning,
      tracksWarning,
      upscaleSuggestion,
      embeddedSubtitlesAvailable: cacheResult.fullRetention,
      ...started
    }
  }
  return {
    ok: true,
    player: 'embedded',
    compatibility: false,
    tracks: activeMediaTracks,
    // Nothing is selecting anything here — the browser demuxes the file
    // itself and plays whichever audio stream the container marks default
    // (falling back to the first). Reaching this branch at all means that
    // track IS the one we wanted, since needsAudioCompatibility above
    // routes to ffmpeg whenever it isn't. Reported so the player's audio
    // menu can mark the track actually being heard.
    selection: { audio: selectTranscodeAudioTrack(activeMediaTracks, audioLanguage)?.ordinal },
    videoCodecWarning,
    tracksWarning,
    upscaleSuggestion,
    embeddedSubtitlesAvailable: cacheResult.fullRetention,
    // The <video> element reads straight from StreamCache's local server —
    // no separate proxy registration step needed, unlike the old
    // playbackProxy.register(url) (which opened its own connection to the
    // remote link per Range request Chromium made).
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
  activeMediaUrl = ''
  activeCacheUrl = ''
  activeMediaTracks = { video: [], audio: [], subtitle: [], probed: false }
  activeVideoEncoder = undefined
  activeVideoEncoderReason = undefined
  activeUpscaleHeight = undefined
  subtitleBatchPromise = null
  clearActiveSubtitle()
  await Promise.all([
    deleteCache ? streamCache.deleteSession() : streamCache.stop(),
    ffmpegTranscoder.stop()
  ])
}

interface SubtitlesApplyPayload {
  fileId?: unknown
  compatibility?: unknown
  selection?: PlaybackSelection
}

type PlaybackCompatibilityResult = FfmpegTranscoderResult & { tracks: MediaTracks }

type PlaybackSelectTracksResult = FfmpegTranscoderResult & {
  tracks: MediaTracks
  selection: PlaybackSelection
}

export function registerPlaybackIpc(): void {
  handle<SubtitlesApplyPayload | undefined, SubtitlesApplyResult>(
    MEDIA_HUB_CHANNELS.subtitlesApply,
    async (_event, payload) => {
      if (!activeMediaUrl) throw new Error('No active media is available for subtitles.')
      const id = Number(payload?.fileId)
      if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid subtitle selection.')
      const srtText = await osDownloadSubtitleText(id)
      if (!payload?.compatibility) {
        return {
          ok: true,
          compatibility: false,
          vttDataUrl: `data:text/vtt;base64,${Buffer.from(srtToVtt(srtText)).toString('base64')}`
        }
      }
      clearActiveSubtitle()
      const dir = subtitleCacheDir()
      fs.mkdirSync(dir, { recursive: true })
      const filePath = path.join(dir, `${crypto.randomBytes(16).toString('hex')}.srt`)
      fs.writeFileSync(filePath, srtText, { mode: 0o600 })
      activeSubtitlePath = filePath
      const selection = payload?.selection
      const safe: PlaybackSelection = {
        audio: Number.isInteger(selection?.audio) ? (selection?.audio as number) : -1,
        startTime: Math.max(0, Math.min(Number(selection?.startTime) || 0, 86400)),
        externalSubtitlePath: filePath
      }
      const started = await startTranscodeWithFallback(safe, activeUpscaleHeight)
      // `started.compatibility` is already `true` (FfmpegTranscoderResult), so
      // it isn't repeated here — TS flags a literal + spread of the same key
      // as an error (TS2783) even though the original JS had no such issue.
      return { ok: true, tracks: activeMediaTracks, ...started }
    }
  )

  handle<PlaybackSelection | undefined, PlaybackCompatibilityResult>(
    MEDIA_HUB_CHANNELS.playbackCompatibility,
    async (_event, selection = {}) => {
      if (!activeMediaUrl) throw new Error('No active media is available for compatibility mode.')
      const started = await startTranscodeWithFallback(selection, activeUpscaleHeight)
      return { tracks: activeMediaTracks, ...started }
    }
  )

  handle<PlaybackSelection | undefined, PlaybackSelectTracksResult>(
    MEDIA_HUB_CHANNELS.playbackSelectTracks,
    async (_event, selection = {}) => {
      if (!activeMediaUrl) throw new Error('No active media is available for track selection.')
      // Every seek in compatibility mode restarts the transcode through
      // here (see PlaybackOverlay's handleSeek), not just explicit track
      // changes — without an explicit audio ordinal, this used to fall
      // back to the container's literal first audio stream regardless of
      // whether preparePlayback's initial start had deliberately avoided
      // it (see selectTranscodeAudioTrack's own comment on the TrueHD/
      // Atmos crash that fix exists for). Falling back the same way here
      // keeps every restart just as safe as the very first one, not only
      // the first.
      const audio = Number.isInteger(selection.audio)
        ? (selection.audio as number)
        : (selectTranscodeAudioTrack(activeMediaTracks, readSettings().audioLanguage || 'en')?.ordinal ?? -1)
      // upscaleHeight is deliberately NOT defaulted the way audio/subtitle
      // are above: undefined here means "this call wasn't about quality at
      // all" (an ordinary seek re-sending the renderer's last known
      // selection) and must leave activeUpscaleHeight exactly as it was —
      // only an explicit number (including 0, "turn it off") changes it.
      // Every restart after the first quality-menu interaction re-echoes
      // the same value on every subsequent seek too (it's just whatever
      // was last returned) — only act when it's genuinely a change, so a
      // plain seek doesn't re-probe the encoder or re-write settings.
      if (
        Number.isInteger(selection.upscaleHeight) &&
        selection.upscaleHeight !== (activeUpscaleHeight ?? 0)
      ) {
        const requested = selection.upscaleHeight as number
        if (requested > 0) {
          if (!activeVideoEncoder) {
            activeVideoEncoder = (await detectVideoEncoder(ffmpegPath)) ?? undefined
            if (!activeVideoEncoder) {
              throw new Error(
                'No working hardware encoder was found on this machine — upscaling is unavailable.'
              )
            }
            activeVideoEncoderReason = 'upscale'
          }
          activeUpscaleHeight = requested
          const current = readSettings()
          writeSettings({ ...current, preferredUpscaleHeight: requested })
        } else {
          // Turning off: only release the encoder too if upscale was the
          // *only* reason it was engaged — a codec-driven re-encode (HEVC
          // etc.) still needs it regardless of the quality choice.
          activeUpscaleHeight = undefined
          if (activeVideoEncoderReason === 'upscale') {
            activeVideoEncoder = undefined
            activeVideoEncoderReason = undefined
          }
        }
      }
      const safe: PlaybackSelection = {
        audio,
        subtitle: Number.isInteger(selection.subtitle) ? (selection.subtitle as number) : -1,
        startTime: Math.max(0, Math.min(Number(selection.startTime) || 0, 86400)),
        upscaleHeight: activeUpscaleHeight ?? 0
      }
      // This handler is reachable from *direct* playback too (a title
      // under 1080p, never having gone through compatibility mode before,
      // upscaled via the quality menu) — no connection-swap coordination
      // needed here anymore, unlike the old playbackProxy/ffmpeg split:
      // both direct-mode and ffmpeg read from the SAME already-running
      // StreamCache local server, so switching between them never touches
      // the remote link at all.
      const started = await startTranscodeWithFallback(safe, activeUpscaleHeight)
      return { tracks: activeMediaTracks, selection: safe, ...started }
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
      return captureFrame(ffmpegPath, activeCacheUrl, Number(seconds) || 0)
    }
  )

  handle<number | undefined, string | null>(
    MEDIA_HUB_CHANNELS.playbackExtractSubtitle,
    async (_event, ordinal) => {
      if (!activeCacheUrl) return null
      const index = Number(ordinal)
      if (!Number.isInteger(index) || index < 0) return null
      // Only reachable once the WHOLE file is locally cached — extracting
      // against a not-yet-fully-cached title would mean ffmpeg reading past
      // what's actually on disk, i.e. StreamCache repositioning its one
      // upstream connection specifically to serve this, mid-playback. The
      // renderer already greys out the "Embedded" subtitle menu in this
      // case (see PlaybackOverlay's fullRetentionReady check); this is the
      // defensive backstop, not the primary gate.
      if (!streamCache.fullRetentionReady()) return null
      // Two callers can want a track at once (a re-click, a party member
      // following a subtitle change) — sharing the in-flight batch promise
      // means one demux for every track this title has, not one per call.
      if (!subtitleBatchPromise) {
        const textOrdinals = activeMediaTracks.subtitle
          .filter((t) => TEXT_SUBTITLE_CODECS.has(t.codec))
          .map((t) => t.ordinal)
        subtitleBatchPromise = extractSubtitleTracksBatch(ffmpegPath, activeCacheUrl, textOrdinals)
      }
      const batch = await subtitleBatchPromise
      return batch.get(index) ?? null
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

  handle<undefined, { ok: true; freedBytes: number }>(
    MEDIA_HUB_CHANNELS.streamCacheClear,
    async () => ({ ok: true, freedBytes: await clearAllSessions() })
  )
}
