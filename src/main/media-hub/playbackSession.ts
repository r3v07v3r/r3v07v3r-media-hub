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

import { app } from 'electron'
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
import { readSettings } from './settingsStore'
import { osDownloadSubtitleText } from './subtitlesService'
import {
  captureFrame,
  createFfmpegTranscoder,
  detectVideoEncoder,
  findFfmpeg,
  findFfprobe,
  needsAudioCompatibility,
  probeMedia,
  selectTranscodeAudioTrack,
  videoCodecCompatibilityWarning,
  type FfmpegTranscoderResult
} from './vlc'

export const ffmpegPath = findFfmpeg()
export const ffprobePath = findFfprobe()

const playbackProxy = createPlaybackProxy()
const ffmpegTranscoder = createFfmpegTranscoder({
  onLog: (line) => logError('ffmpeg:stderr', redactUrls(line.trim()))
})

let activeMediaUrl = ''
let activeMediaTracks: MediaTracks = { video: [], audio: [], subtitle: [], probed: false }
let activeSubtitlePath = ''

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
  await ffmpegTranscoder.stop()
  activeMediaTracks = await probeMedia(ffprobePath, url)
  const videoCodecWarning = videoCodecCompatibilityWarning(activeMediaTracks)
  let videoEncoder: string | undefined
  if (videoCodecWarning && ffmpegPath && readSettings().videoTranscodeEnabled) {
    videoEncoder = (await detectVideoEncoder(ffmpegPath)) ?? undefined
  }
  if ((needsAudioCompatibility(activeMediaTracks) || videoEncoder) && ffmpegPath) {
    await playbackProxy.close()
    const started = await ffmpegTranscoder.start(
      ffmpegPath,
      url,
      { audio: selectTranscodeAudioTrack(activeMediaTracks)?.ordinal ?? 0 },
      videoEncoder
    )
    return {
      ok: true,
      player: 'embedded',
      tracks: activeMediaTracks,
      autoReason: videoEncoder
        ? 'Video and audio were converted for compatibility.'
        : 'Audio was converted for browser compatibility.',
      // Actually addressed by the video-transcode path above, so no need
      // to warn about it too — still surfaced when audio-only compatibility
      // mode ran instead (opted out, or no working hardware encoder found).
      videoCodecWarning: videoEncoder ? undefined : videoCodecWarning,
      ...started
    }
  }
  return {
    ok: true,
    player: 'embedded',
    compatibility: false,
    tracks: activeMediaTracks,
    videoCodecWarning,
    url: await playbackProxy.register(url)
  }
}

/** Clears active playback state (URL/tracks/subtitle file) and tears down the playback proxy and any running ffmpeg transcoder. */
export async function stopPlayback(): Promise<void> {
  activeMediaUrl = ''
  activeMediaTracks = { video: [], audio: [], subtitle: [], probed: false }
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
      const started = await ffmpegTranscoder.start(ffmpegPath, activeMediaUrl, safe)
      await playbackProxy.close()
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
      const started = await ffmpegTranscoder.start(ffmpegPath, activeMediaUrl, selection)
      await playbackProxy.close()
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
        : (selectTranscodeAudioTrack(activeMediaTracks)?.ordinal ?? -1)
      const safe: PlaybackSelection = {
        audio,
        subtitle: Number.isInteger(selection.subtitle) ? (selection.subtitle as number) : -1,
        startTime: Math.max(0, Math.min(Number(selection.startTime) || 0, 86400))
      }
      const started = await ffmpegTranscoder.start(ffmpegPath, activeMediaUrl, safe)
      await playbackProxy.close()
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
