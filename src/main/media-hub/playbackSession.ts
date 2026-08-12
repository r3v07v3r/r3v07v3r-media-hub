// Ported from r3v07v3r-media-hub's src/main.cjs (subtitleCacheDir/
// clearActiveSubtitle/preparePlayback/stopPlayback, the module-level
// activeMediaUrl/activeMediaTracks/activeSubtitlePath/playbackProxy/
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
import { createPlaybackProxy } from './playback'
import { readSettings, writeSettings } from './settingsStore'
import { osDownloadSubtitleText } from './subtitlesService'
import {
  captureFrame,
  createFfmpegTranscoder,
  detectVideoEncoder,
  extractSubtitleTrack,
  findFfmpeg,
  findFfprobe,
  needsAudioCompatibility,
  probeMedia,
  selectTranscodeAudioTrack,
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

const playbackProxy = createPlaybackProxy()
const ffmpegTranscoder = createFfmpegTranscoder({
  onLog: (line) => logError('ffmpeg:stderr', redactUrls(line.trim()))
})

let activeMediaUrl = ''
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
// True only while the direct/proxied (non-ffmpeg) path is actually serving
// the current title — set in preparePlayback's direct-passthrough branch,
// cleared the moment anything switches to ffmpeg. Used below to decide
// whether transitioning INTO ffmpeg needs the extra teardown grace period.
let directModeActive = false

// Set once a video re-encode has actually failed to start on this
// machine. The fallback below recovers playback, but only after burning
// the full startup budget waiting — and the outcome doesn't change from
// one title to the next, so paying that again on every play would be a
// pointless 60s tax. Remembering it turns the second and later plays
// straight into the stream-copy path. Deliberately session-scoped (not
// persisted): hardware, drivers and the encoder set can change between
// runs, so a restart re-tests rather than writing the machine off.
let videoEncodeUnusable = false

// Embedded subtitle tracks already pulled out of the current media, keyed
// by URL and stream ordinal. Extraction has to demux the WHOLE remote file
// (subtitle cues are interleaved throughout a container, so there is no
// early exit — see extractSubtitleTrack), which on a large file is a real
// wait. Doing it twice for the same track is pure waste: the cues cannot
// have changed. Cleared with the session, since the URL it is keyed by is
// only valid for that session anyway.
const extractedSubtitles = new Map<string, Promise<string | null>>()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Closes the direct proxy and, if it was actually the thing serving this
 * title, gives the remote source a moment to notice before ffmpeg opens a
 * fresh connection to the same link. Found live: TorBox (like most debrid/
 * streaming sources — see vlc.ts's own note on this) caps concurrent
 * connections per link; our local proxy server fully closing doesn't
 * guarantee the *upstream* fetch it was making has been torn down on
 * TorBox's end yet (the abort is wired to the local response's 'close'
 * event, not to server shutdown directly), so starting ffmpeg immediately
 * after can race that teardown and stall out entirely (confirmed live:
 * "did not start producing video in time" on the very first upscale/seek
 * out of direct mode). Already-in-compatibility-mode restarts (the far
 * more common case — every ordinary seek) never had this problem and
 * shouldn't pay the delay: playbackProxy.close() is a no-op there.
 */
async function closeDirectProxyBeforeTranscode(): Promise<void> {
  const wasDirect = directModeActive
  await playbackProxy.close()
  if (wasDirect) await sleep(500)
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
  try {
    return await ffmpegTranscoder.start(
      ffmpegPath,
      activeMediaUrl,
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
    return ffmpegTranscoder.start(ffmpegPath, activeMediaUrl, selection, undefined, targetHeight)
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
 * Probes `url` and starts embedded playback for it: either directly (via
 * the playback proxy) or, by transcoding through ffmpeg — always audio
 * when the source's audio codec isn't browser-compatible, and (opt-in,
 * see Settings > More Options' "Convert incompatible video") video too
 * when the source's video codec is one Chromium can't reliably decode
 * and a real hardware encoder is actually available on this machine
 * (see vlc.ts's detectVideoEncoder — never falls back to a software
 * encoder). Also used by torbox.ts's play:stream/library:play handlers.
 */
export async function preparePlayback(url: string): Promise<PlaybackResult> {
  activeMediaUrl = url
  extractedSubtitles.clear()
  await ffmpegTranscoder.stop()
  activeMediaTracks = await probeMedia(ffprobePath, url)
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
    directModeActive = false
    await playbackProxy.close()
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
      ...started
    }
  }
  directModeActive = true
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
    url: await playbackProxy.register(url)
  }
}

/** Clears active playback state (URL/tracks/subtitle file) and tears down the playback proxy and any running ffmpeg transcoder. */
export async function stopPlayback(): Promise<void> {
  activeMediaUrl = ''
  activeMediaTracks = { video: [], audio: [], subtitle: [], probed: false }
  activeVideoEncoder = undefined
  activeVideoEncoderReason = undefined
  activeUpscaleHeight = undefined
  directModeActive = false
  extractedSubtitles.clear()
  clearActiveSubtitle()
  await Promise.all([playbackProxy.close(), ffmpegTranscoder.stop()])
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
      // Close the still-open direct connection BEFORE opening the new
      // ffmpeg one, not after — see closeDirectProxyBeforeTranscode's own
      // comment for why this order (and the grace delay when it applies)
      // matters: a real bug found live, two simultaneous connections to
      // the same remote link, one of which stalls out.
      await closeDirectProxyBeforeTranscode()
      directModeActive = false
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
      await closeDirectProxyBeforeTranscode()
      directModeActive = false
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
      // Closing the direct connection before opening ffmpeg's (not after)
      // matters most right here — this handler is now reachable from
      // *direct* playback too (a title under 1080p, never having gone
      // through compatibility mode before, upscaled via the quality menu),
      // where the old code path's ordering left both connections open
      // simultaneously against the same remote link. Verified live: with
      // the old after-the-fact close, upscaling a title still on direct
      // playback reliably hit "did not start producing video in time";
      // TorBox (like most debrid/streaming sources) caps concurrent
      // connections per link, and the still-open direct one was eating the
      // new one's slot. closeDirectProxyBeforeTranscode also adds a short
      // grace delay in exactly this transition (and only this one).
      await closeDirectProxyBeforeTranscode()
      directModeActive = false
      const started = await startTranscodeWithFallback(safe, activeUpscaleHeight)
      return { tracks: activeMediaTracks, selection: safe, ...started }
    }
  )

  handle<undefined, { ok: true }>(MEDIA_HUB_CHANNELS.playbackStop, async () => {
    await stopPlayback()
    return { ok: true }
  })

  handle<number | undefined, string | null>(
    MEDIA_HUB_CHANNELS.playbackThumbnail,
    async (_event, seconds) => {
      if (!activeMediaUrl) return null
      return captureFrame(ffmpegPath, activeMediaUrl, Number(seconds) || 0)
    }
  )

  handle<number | undefined, string | null>(
    MEDIA_HUB_CHANNELS.playbackExtractSubtitle,
    async (_event, ordinal) => {
      if (!activeMediaUrl) return null
      const index = Number(ordinal)
      const key = `${activeMediaUrl}::${index}`
      const memo = extractedSubtitles.get(key)
      if (memo !== undefined) return memo
      // Two callers can want the same track at once (a re-click while the
      // first is still running, a party member following a subtitle
      // change). Sharing the in-flight promise means one demux, not two —
      // and this demux walks the entire remote file (see
      // extractSubtitleTrack), so a duplicate is genuinely expensive.
      const pending = extractSubtitleTrack(ffmpegPath, activeMediaUrl, index)
      extractedSubtitles.set(key, pending)
      try {
        const result = await pending
        // Only a real result is worth keeping — a failure may well have
        // been a transient network problem, and caching `null` would make
        // the track permanently unavailable for this session.
        if (result) extractedSubtitles.set(key, Promise.resolve(result))
        else extractedSubtitles.delete(key)
        return result
      } catch (error) {
        extractedSubtitles.delete(key)
        throw error
      }
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
}
