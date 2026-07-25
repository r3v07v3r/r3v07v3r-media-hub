// Ported from r3v07v3r-media-hub's src/main.cjs (subtitleCacheDir/
// clearActiveSubtitle/preparePlayback/stopPlayback, the module-level
// activeMediaUrl/activeMediaTracks/activeSubtitlePath/playbackProxy/
// vlcTranscoder/ffprobePath/ffmpegPath/vlcInstallPath singletons, and the
// subtitles:apply/playback:compatibility/playback:select-tracks/
// playback:stop/playback:thumbnail IPC handlers). Active playback is
// intentionally kept as module-level singleton state, exactly as in the
// original app: there is only ever one "now playing" session for the whole
// app, not per-window/per-session state.
//
// `vlcInstallPath`/`ffmpegPath`/`ffprobePath` are computed once at module
// load (same as the original's module-level consts) and exported so other
// modules — e.g. the settings snapshot's `vlcInstalled` flag — don't each
// re-run their own executable discovery.

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
import { osDownloadSubtitleText } from './subtitlesService'
import {
  captureFrame,
  createVlcTranscoder,
  findFfmpeg,
  findFfprobe,
  findVlc,
  needsAudioCompatibility,
  probeMedia,
  type VlcTranscoderResult
} from './vlc'

export const vlcInstallPath = findVlc()
export const ffmpegPath = findFfmpeg()
export const ffprobePath = findFfprobe()

const playbackProxy = createPlaybackProxy()
const vlcTranscoder = createVlcTranscoder({
  onLog: (line) => logError('vlc:stderr', redactUrls(line.trim()))
})

let activeMediaUrl = ''
let activeMediaTracks: MediaTracks = { video: [], audio: [], subtitle: [], probed: false }
let activeSubtitlePath = ''

function subtitleCacheDir(): string {
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
 * the playback proxy) or, if the source's audio codec isn't
 * browser-compatible and VLC is installed, by transcoding through VLC.
 * Also used by torbox.ts's play:stream/library:play handlers.
 */
export async function preparePlayback(url: string): Promise<PlaybackResult> {
  activeMediaUrl = url
  await vlcTranscoder.stop()
  activeMediaTracks = await probeMedia(ffprobePath, url)
  if (needsAudioCompatibility(activeMediaTracks) && vlcInstallPath) {
    await playbackProxy.close()
    const started = await vlcTranscoder.start(vlcInstallPath, url, {
      audio: activeMediaTracks.audio.find((x) => x.default)?.ordinal ?? 0
    })
    return {
      ok: true,
      player: 'embedded',
      tracks: activeMediaTracks,
      autoReason: 'Audio was converted for browser compatibility.',
      ...started
    }
  }
  return {
    ok: true,
    player: 'embedded',
    compatibility: false,
    tracks: activeMediaTracks,
    url: await playbackProxy.register(url)
  }
}

/** Clears active playback state (URL/tracks/subtitle file) and tears down the playback proxy and any running VLC transcoder. */
export async function stopPlayback(): Promise<void> {
  activeMediaUrl = ''
  activeMediaTracks = { video: [], audio: [], subtitle: [], probed: false }
  clearActiveSubtitle()
  await Promise.all([playbackProxy.close(), vlcTranscoder.stop()])
}

interface SubtitlesApplyPayload {
  fileId?: unknown
  compatibility?: unknown
  selection?: PlaybackSelection
}

type PlaybackCompatibilityResult = VlcTranscoderResult & { tracks: MediaTracks }

type PlaybackSelectTracksResult = VlcTranscoderResult & {
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
      const started = await vlcTranscoder.start(vlcInstallPath, activeMediaUrl, safe)
      await playbackProxy.close()
      // `started.compatibility` is already `true` (VlcTranscoderResult), so it
      // isn't repeated here — TS flags a literal + spread of the same key as
      // an error (TS2783) even though the original JS had no such issue.
      return { ok: true, tracks: activeMediaTracks, ...started }
    }
  )

  handle<PlaybackSelection | undefined, PlaybackCompatibilityResult>(
    MEDIA_HUB_CHANNELS.playbackCompatibility,
    async (_event, selection = {}) => {
      if (!activeMediaUrl) throw new Error('No active media is available for compatibility mode.')
      const started = await vlcTranscoder.start(vlcInstallPath, activeMediaUrl, selection)
      await playbackProxy.close()
      return { tracks: activeMediaTracks, ...started }
    }
  )

  handle<PlaybackSelection | undefined, PlaybackSelectTracksResult>(
    MEDIA_HUB_CHANNELS.playbackSelectTracks,
    async (_event, selection = {}) => {
      if (!activeMediaUrl) throw new Error('No active media is available for track selection.')
      const safe: PlaybackSelection = {
        audio: Number.isInteger(selection.audio) ? (selection.audio as number) : -1,
        subtitle: Number.isInteger(selection.subtitle) ? (selection.subtitle as number) : -1,
        startTime: Math.max(0, Math.min(Number(selection.startTime) || 0, 86400))
      }
      const started = await vlcTranscoder.start(vlcInstallPath, activeMediaUrl, safe)
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
}
