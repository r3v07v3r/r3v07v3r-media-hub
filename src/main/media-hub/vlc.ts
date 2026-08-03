// Ported from r3v07v3r-media-hub's src/vlc.cjs, but compatibility-mode
// transcoding itself no longer uses VLC — see the history below for why.
// The remaining security boundaries are preserved exactly, byte-for-byte
// in intent, from the original: (1) command-injection defenses around the
// transcoder subprocess — `buildFfmpegArguments` re-checks
// `isAllowedRemoteMediaUrl` (SSRF defense, defense in depth immediately
// before every ffmpeg spawn) before any of it is used to build a spawned
// argument list; (2) the same SSRF checks from playback.ts, re-applied
// here before ever invoking ffprobe/ffmpeg against a remote URL. Do not
// loosen, skip, or "simplify" any of these checks without re-auditing
// against the source app.
//
// History: compatibility mode originally shelled out to VLC, transcoding
// BOTH video (to VP8) and audio into a live WebM stream, even though only
// the audio codec was ever the actual incompatibility. Two real bugs came
// from that: (1) on this project's dev machine, GPU-accelerated decode fed
// the VP8 encoder out-of-order timestamps, which could wedge the transcode
// permanently; forcing software decode fixed that specific corruption, but
// exposed (2) the deeper problem — software VP8 encoding simply cannot
// keep up with real movie bitrates in real time (verified: a 1080p/16Mbps
// test clip dropped hundreds of frames even after scaling down and using
// VLC's fastest encode preset). Re-encoding video was never necessary:
// `needsAudioCompatibility` below only ever looks at the audio codec.
// ffmpeg's `-c:v copy` passes video through untouched (near-zero CPU cost,
// no bitrate ceiling to keep up with) and only transcodes audio into AAC,
// muxed into a fragmented MP4 that Chromium can play live exactly like the
// old WebM stream — verified against a real 1080p/16Mbps source with zero
// dropped frames, versus hundreds under the old VLC/WebM approach, and
// unlike that approach the fragmented-MP4 stream also reports a real
// finite `duration` instead of `Infinity`. This does mean embedded
// subtitle tracks can no longer be burned into the video via VLC's
// `soverlay` filter during compatibility mode (that required re-encoding
// video, which copy mode by definition doesn't do) — the separate
// OpenSubtitles-downloaded caption flow (subtitles:apply, WebVTT
// `<track>`) is unaffected since it never depended on the transcode engine.
//
// ffmpeg is bundled with the app (resources/ffmpeg-win, wired up via
// electron-builder.yml's extraResources) rather than required as a
// separate user install like VLC was — most users don't have ffmpeg
// already, unlike VLC, so requiring it separately would have left
// compatibility mode broken for most people. `findFfmpeg()` below checks
// the bundled resource first, falling back to a system search (useful in
// dev, where the app isn't packaged).

import { spawn, execFile, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'

import type {
  MediaTrack,
  MediaTracks,
  PlaybackSelection,
  UpscaleSuggestion
} from '../../shared/media-hub/types'
import { getPlaybackBufferSeconds } from '../../shared/media-hub/playbackBuffer'
import { isAllowedRemoteMediaUrl } from './playback'
import { readSettings } from './settingsStore'

/** Compatibility-stream token: 64 lowercase hex chars, same shape as the playback-proxy token. */
export function isValidCompatibilityToken(value: unknown): boolean {
  return /^[a-f0-9]{64}$/.test(String(value))
}

function cleanSelection(value: unknown, fallback = -1): number {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 && number < 100 ? number : fallback
}

/**
 * Builds the ffmpeg CLI argument list for compatibility-mode transcoding:
 * copies video untouched, transcodes only audio to AAC, muxed into a
 * fragmented MP4 written to stdout (the caller pipes that to an HTTP
 * response — see createFfmpegTranscoder below). `remoteUrl` is
 * re-validated against `isAllowedRemoteMediaUrl` here as defense in depth
 * immediately before every spawn, same as the rest of this file.
 */
export function buildFfmpegArguments(
  remoteUrl: string,
  selection: PlaybackSelection = {},
  videoEncoder?: string,
  targetHeight?: number
): string[] {
  if (!isAllowedRemoteMediaUrl(remoteUrl)) {
    throw new Error('Compatibility mode requires a valid HTTPS media URL.')
  }

  const audio = cleanSelection(selection.audio)
  const startTime = Math.max(0, Number(selection.startTime) || 0)

  const args = ['-loglevel', 'warning']
  // Streaming/debrid sources can drop the connection briefly under load —
  // without these, ffmpeg just errors out on a transient network blip
  // instead of reconnecting, which would surface as a much worse stall or
  // failure than the interruption itself warranted.
  args.push(
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_on_network_error',
    '1',
    '-reconnect_delay_max',
    '5'
  )
  // Input-side seek (-ss before -i) is fast/keyframe-based, which is what
  // we want since video is copied, not decoded — a re-encode-precision
  // seek isn't possible (or needed) without decoding video anyway.
  //
  // -noaccurate_seek is the fix for a real live-reported bug: after any
  // seek, audio played noticeably behind the video for the rest of that
  // segment. Root cause — ffmpeg's *default* behavior for -ss before -i is
  // "accurate seek": it seeks near a keyframe internally, but for any
  // stream being decoded/re-encoded (audio here — never true for a
  // `-c:v copy` stream, which by definition can't be trimmed to a
  // non-keyframe point without re-encoding) it then discards frames until
  // the exact requested startTime. That makes audio start almost exactly
  // at startTime while copy-mode video can only start at the nearest
  // preceding keyframe — video ends up with extra "keyframe-to-startTime"
  // content audio doesn't have, so audio reads as behind by however far
  // that keyframe gap is (commonly several seconds). -noaccurate_seek
  // stops ffmpeg from doing that discard-until-exact-time trim for audio,
  // so both streams land at the same real position ffmpeg's demuxer
  // reaches — audio and video stay in sync with each other, at the cost of
  // playback occasionally starting up to one keyframe-interval earlier
  // than the literal position clicked, which is far less noticeable than a
  // sustained A/V desync.
  if (startTime > 0) args.push('-noaccurate_seek', '-ss', String(Math.floor(startTime)))
  args.push('-i', remoteUrl)
  args.push('-map', '0:v:0', '-map', audio >= 0 ? `0:a:${audio}` : '0:a:0')
  // Opt-in video path (see detectVideoEncoder) — otherwise the same
  // stream-copy this file's header explains was the right default. Seek
  // stays keyframe-snapped for both streams either way (-noaccurate_seek
  // above): re-encoded video technically COULD support frame-accurate
  // seeking, but that would only reopen the exact audio-behind-video race
  // -noaccurate_seek was added to fix, for a worse-than-marginal gain in
  // seek precision on a feature that doesn't need to be used by default.
  if (videoEncoder) {
    // HEVC sources (the whole reason this path exists) are very commonly
    // 10-bit (Main10 profile) — feeding that straight into an H.264
    // encoder expecting 8-bit 4:2:0 is a well-known real-world failure
    // mode, confirmed live here: without this filter, ffmpeg exited
    // immediately with no video produced at all against a real 10-bit
    // HEVC source, despite the exact same encoder working perfectly
    // against an 8-bit synthetic test pattern. This forces a normal
    // software decode + pixel-format conversion to a format every
    // candidate encoder in VIDEO_ENCODER_ARGS accepts, before handing
    // frames to the (still hardware-accelerated) encoder — a small,
    // well-understood CPU cost for broad compatibility, not a full
    // software encode.
    // Plain `scale` (software, CPU-side) rather than an encoder-specific
    // GPU filter (e.g. scale_cuda) — decode here is already software (the
    // format conversion above requires it), so a GPU scale filter would
    // need its own hwaccel decode path per encoder vendor for no real
    // benefit; resizing itself is cheap relative to the encode step it's
    // already paying for. `-2` keeps width even and aspect-ratio-correct.
    const videoFilters = ['format=yuv420p']
    if (targetHeight && targetHeight > 0) videoFilters.push(`scale=-2:${targetHeight}`)
    args.push('-vf', videoFilters.join(','))
    args.push('-c:v', videoEncoder, ...(VIDEO_ENCODER_ARGS[videoEncoder] || []))
  } else {
    args.push('-c:v', 'copy')
  }
  args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000')
  args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof')
  args.push('-f', 'mp4', 'pipe:1')
  return args
}

/** Loose "raw ffprobe JSON" shape — untrusted external tool output, only the fields we read are modeled. */
export interface FfprobeStream {
  index?: unknown
  codec_type?: unknown
  codec_name?: unknown
  width?: unknown
  height?: unknown
  channels?: unknown
  tags?: { language?: unknown; title?: unknown }
  disposition?: { default?: unknown }
}

export interface FfprobePayload {
  streams?: FfprobeStream[]
  format?: { duration?: unknown }
}

function mediaLabel(
  stream: FfprobeStream,
  type: 'video' | 'audio' | 'subtitle',
  ordinal: number
): string {
  const tags = stream.tags || {}
  const name = String(tags.title || '').trim()
  const language = String(tags.language || '')
    .trim()
    .toUpperCase()
  const codec = String(stream.codec_name || 'unknown').toUpperCase()
  const parts: string[] = []
  if (name) parts.push(name)
  else parts.push(`${type[0].toUpperCase() + type.slice(1)} ${ordinal + 1}`)
  if (type === 'video' && stream.width && stream.height)
    parts.push(`${stream.width}×${stream.height}`)
  if (language && type !== 'video') parts.push(language)
  if (type === 'audio' && stream.channels) parts.push(`${stream.channels}ch`)
  parts.push(codec)
  return parts.join(' • ')
}

export function parseMediaTracks(payload: FfprobePayload = {}): MediaTracks {
  const result: {
    video: MediaTrack[]
    audio: MediaTrack[]
    subtitle: MediaTrack[]
    probed: true
    durationSeconds?: number
  } = {
    video: [],
    audio: [],
    subtitle: [],
    probed: true
  }
  const duration = Number(payload.format?.duration)
  if (Number.isFinite(duration) && duration > 0) result.durationSeconds = duration
  for (const stream of payload.streams || []) {
    const type = stream.codec_type
    if (type !== 'video' && type !== 'audio' && type !== 'subtitle') continue
    const ordinal = result[type].length
    const width = Number(stream.width)
    const height = Number(stream.height)
    result[type].push({
      ordinal,
      index: Number(stream.index),
      codec: String(stream.codec_name || 'unknown').toLowerCase(),
      language: String(stream.tags?.language || ''),
      title: String(stream.tags?.title || ''),
      label: mediaLabel(stream, type, ordinal),
      default: Boolean(stream.disposition?.default),
      ...(type === 'video' && Number.isFinite(width) && width > 0 ? { width } : {}),
      ...(type === 'video' && Number.isFinite(height) && height > 0 ? { height } : {})
    })
  }
  return result
}

const DIRECT_AUDIO_CODECS = new Set([
  'aac',
  'mp3',
  'opus',
  'vorbis',
  'flac',
  'pcm_s16le',
  'pcm_s24le'
])

// TrueHD (Dolby Atmos' underlying codec) and DTS(-HD MA) both live-
// reproduced the same real crash: downmixing either through ffmpeg's
// decoder into AAC eventually produced a packet Chromium's own decoder
// rejected outright (PipelineStatus::PIPELINE_ERROR_DECODE), killing
// playback partway in — verified against a real 4K remux, including that
// avoiding ONLY truehd wasn't sufficient the first time this was fixed,
// because the resulting fallback picked the dts track (present earlier in
// the file's track list than a plain ac3 one) and hit the exact same
// failure. Both are complex lossless-core-plus-extension codecs; a plain
// lossy AC3/E-AC3 core track downmixes far more reliably in practice. Not
// blocking either outright (sometimes the only audio track a release has),
// but preferring a same-language AC3/E-AC3 alternative when one exists —
// TrueHD/DTS-HD releases very commonly ship exactly that alongside the
// lossless track specifically for this kind of compatibility gap.
const RISKY_TRANSCODE_CODECS = new Set(['truehd', 'dts'])

/** Picks which audio track compatibility-mode transcoding should actually
 *  use — not always simply "the default track." See RISKY_TRANSCODE_CODECS. */
export function selectTranscodeAudioTrack(tracks: MediaTracks | undefined): MediaTrack | undefined {
  const audio = tracks?.audio || []
  if (!audio.length) return undefined
  const preferred = audio.find((x) => x.default) || audio[0]
  if (!RISKY_TRANSCODE_CODECS.has(preferred.codec)) return preferred
  const saferSameLanguage = audio.find(
    (t) =>
      t !== preferred && t.language === preferred.language && !RISKY_TRANSCODE_CODECS.has(t.codec)
  )
  const saferAny = audio.find((t) => t !== preferred && !RISKY_TRANSCODE_CODECS.has(t.codec))
  return saferSameLanguage || saferAny || preferred
}

export function needsAudioCompatibility(tracks: MediaTracks | undefined): boolean {
  const selected = selectTranscodeAudioTrack(tracks)
  if (!selected) return false
  return !DIRECT_AUDIO_CODECS.has(String(selected.codec || '').toLowerCase())
}

// Video is stream-copied by default (see buildFfmpegArguments's `-c:v
// copy` and playback.ts's direct-proxy path), so a source encoded in a
// codec Chromium's own (software) decoder can't handle has no fallback
// unless the person has opted into Settings > More Options' "Convert
// incompatible video" AND a real hardware encoder is actually found on
// their machine (see detectVideoEncoder) — off by default, since it's new
// and not every machine has working hardware encode. Confirmed live: HEVC
// sources produced everything from silent "audio only, no picture" to a
// mid-stream PIPELINE_ERROR_DECODE crash partway through playback,
// depending on the specific stream — both symptoms trace back to the same
// gap, not two separate bugs. This detects the risk upfront so the person
// gets one clear message before pressing play (mentioning the opt-in
// fix), instead of a confusing crash minutes in with no explanation.
const RISKY_VIDEO_CODECS = new Set(['hevc', 'h265', 'vc1', 'mpeg2video', 'mpeg4'])

export function videoCodecCompatibilityWarning(
  tracks: MediaTracks | undefined
): string | undefined {
  const codec = String(tracks?.video?.[0]?.codec || '').toLowerCase()
  if (!RISKY_VIDEO_CODECS.has(codec)) return undefined
  return `This title's video (${codec.toUpperCase()}) may not play reliably in this app — some players can't decode it at all, others only partway through. Settings > More Options has an experimental video-conversion option that may help, if your machine has a working hardware encoder.`
}

// Independent of codec compatibility above — a perfectly playable H.264
// source can still just be low-resolution. Only offered up to 1080p
// sources; a title already above that isn't what "make it look better"
// is asking for. Candidates stop at 4K since that's the practical ceiling
// for the hardware encoders this app ever uses (see HW_VIDEO_ENCODER_CANDIDATES) —
// nothing here claims to add detail that isn't in the source, just resizes it
// (plain `scale`, no AI/DNN filter is bundled — see buildFfmpegArguments).
const UPSCALE_HEIGHT_CANDIDATES = [1080, 1440, 2160]

export function videoResolutionUpscaleSuggestion(
  tracks: MediaTracks | undefined,
  screenHeight?: number,
  preferredHeight?: number
): UpscaleSuggestion | undefined {
  const sourceHeight = tracks?.video?.[0]?.height
  if (!sourceHeight || sourceHeight > 1080) return undefined
  const options = UPSCALE_HEIGHT_CANDIDATES.filter((h) => h > sourceHeight)
  if (options.length === 0) return undefined
  if (preferredHeight && options.includes(preferredHeight)) {
    return { sourceHeight, options, recommended: preferredHeight }
  }
  const screen = Number(screenHeight)
  const recommended =
    Number.isFinite(screen) && screen > 0
      ? (options.find((h) => h >= screen) ?? options[options.length - 1])
      : options[0]
  return { sourceHeight, options, recommended }
}

function findInTree(root: string, name: string, depth = 4): string {
  if (!root || depth < 0 || !fs.existsSync(root)) return ''
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return ''
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === name) return full
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = findInTree(path.join(root, entry.name), name, depth - 1)
      if (found) return found
    }
  }
  return ''
}

export function findFfprobe(): string {
  const executable = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  const direct = [
    'C:/ffmpeg/bin/ffprobe.exe',
    'C:/Program Files/ffmpeg/bin/ffprobe.exe',
    'C:/Program Files (x86)/ffmpeg/bin/ffprobe.exe'
  ]
  const searchRoots = [
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages'),
    path.join(process.env.ProgramData || '', 'chocolatey', 'lib'),
    path.join(process.env.USERPROFILE || '', 'scoop', 'apps')
  ]
  const candidates = [
    process.env.FFPROBE_PATH,
    ...direct,
    ...String(process.env.PATH || '')
      .split(path.delimiter)
      .map((dir) => path.join(dir, executable)),
    ...searchRoots
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    if (searchRoots.includes(candidate)) {
      const found = findInTree(candidate, executable, 5)
      if (found) return found
    }
  }
  return ''
}

export interface ExecFileImplOptions {
  execFileImpl?: typeof execFile
  timeout?: number
}

export function probeMedia(
  ffprobePath: string,
  remoteUrl: string,
  { execFileImpl = execFile, timeout = 15000 }: ExecFileImplOptions = {}
): Promise<MediaTracks> {
  if (!ffprobePath || !isAllowedRemoteMediaUrl(remoteUrl)) {
    return Promise.resolve({ video: [], audio: [], subtitle: [], probed: false })
  }
  return new Promise((resolve) => {
    execFileImpl(
      ffprobePath,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration:stream=index,codec_type,codec_name,width,height,channels:stream_tags=language,title:stream_disposition=default',
        '-of',
        'json',
        remoteUrl
      ],
      { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve({ video: [], audio: [], subtitle: [], probed: false })
        try {
          resolve(parseMediaTracks(JSON.parse(String(stdout)) as FfprobePayload))
        } catch {
          resolve({ video: [], audio: [], subtitle: [], probed: false })
        }
      }
    )
  })
}

export function findFfmpeg(): string {
  const executable = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  // Packaged builds bundle ffmpeg (electron-builder.yml's extraResources,
  // resources/ffmpeg-win) so compatibility mode works with zero setup —
  // most users won't have ffmpeg installed separately, unlike VLC. Only
  // relevant when app.isPackaged; in dev, resourcesPath doesn't contain it
  // and this candidate simply won't exist, falling through to the system
  // search below.
  const bundled = path.join(process.resourcesPath || '', 'ffmpeg', executable)
  const direct = [
    bundled,
    'C:/ffmpeg/bin/ffmpeg.exe',
    'C:/Program Files/ffmpeg/bin/ffmpeg.exe',
    'C:/Program Files (x86)/ffmpeg/bin/ffmpeg.exe'
  ]
  const searchRoots = [
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages'),
    path.join(process.env.ProgramData || '', 'chocolatey', 'lib'),
    path.join(process.env.USERPROFILE || '', 'scoop', 'apps')
  ]
  const candidates = [
    process.env.FFMPEG_PATH,
    ...direct,
    ...String(process.env.PATH || '')
      .split(path.delimiter)
      .map((dir) => path.join(dir, executable)),
    ...searchRoots
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    if (searchRoots.includes(candidate)) {
      const found = findInTree(candidate, executable, 5)
      if (found) return found
    }
  }
  return ''
}

export function captureFrame(
  ffmpegPath: string,
  remoteUrl: string,
  seconds: number,
  { execFileImpl = execFile, timeout = 10000 }: ExecFileImplOptions = {}
): Promise<string | null> {
  if (
    !ffmpegPath ||
    !isAllowedRemoteMediaUrl(remoteUrl) ||
    !Number.isFinite(seconds) ||
    seconds < 0
  ) {
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    execFileImpl(
      ffmpegPath,
      [
        '-ss',
        String(Math.floor(seconds)),
        '-i',
        remoteUrl,
        '-frames:v',
        '1',
        '-vf',
        'scale=160:-1',
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        '-'
      ],
      { windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout) => {
        if (error || !stdout || !stdout.length) return resolve(null)
        resolve(`data:image/jpeg;base64,${stdout.toString('base64')}`)
      }
    )
  })
}

// Text-based subtitle codecs ffmpeg's webvtt muxer can actually convert —
// image-based ones (PGS/"hdmv_pgs_subtitle", VobSub/"dvd_subtitle", DVB)
// are bitmap frames, not text, and ffmpeg has no OCR step to turn those
// into WebVTT cues. Used to decide which embedded subtitle tracks the
// player's menu can offer at all (see extractSubtitleTrack below) rather
// than letting someone pick one that can only ever silently fail.
export const TEXT_SUBTITLE_CODECS = new Set([
  'subrip',
  'srt',
  'ass',
  'ssa',
  'mov_text',
  'webvtt',
  'text'
])

/**
 * Pulls one embedded subtitle stream out of the remote source and converts
 * it to WebVTT text via ffmpeg's own muxer — no video re-encoding, no
 * compatibility-mode restart involved. This is genuinely the fix for a
 * real dead-end found live: PlaybackOverlay's "Embedded" subtitle menu
 * used to call playback:select-tracks (the ffmpeg-restart path), but
 * buildFfmpegArguments never actually read `selection.subtitle` at all —
 * see this file's own header comment on why embedded subtitle *burning*
 * was removed when compatibility mode switched to `-c:v copy` (that
 * required re-encoding video, which copy mode by definition doesn't do).
 * Selecting a menu item that silently did nothing is a worse experience
 * than not offering it, so this is the real fix, not a workaround:
 * extract-and-overlay via the same already-working WebVTT `<track>`
 * mechanism the OpenSubtitles flow already uses, instead of trying to
 * burn it into the transcode.
 *
 * `ordinal` is this stream's position among *subtitle* streams only (the
 * same convention `-map 0:a:N` already uses for audio elsewhere in this
 * file) — matches MediaTrack.ordinal from parseMediaTracks below.
 *
 * Unlike captureFrame's `-frames:v 1` early-exit, there's no way to bail
 * out early here: ffmpeg has to demux through the *entire* remote file to
 * collect every subtitle cue, since containers interleave all their
 * streams together rather than storing each one contiguously. On a fast
 * cached/debrid link this is normally well under a minute; the generous
 * timeout below is a backstop for a genuinely slow connection, not the
 * expected case.
 */
export function extractSubtitleTrack(
  ffmpegPath: string,
  remoteUrl: string,
  ordinal: number,
  { execFileImpl = execFile, timeout = 300000 }: ExecFileImplOptions = {}
): Promise<string | null> {
  if (
    !ffmpegPath ||
    !isAllowedRemoteMediaUrl(remoteUrl) ||
    !Number.isInteger(ordinal) ||
    ordinal < 0
  ) {
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    execFileImpl(
      ffmpegPath,
      ['-i', remoteUrl, '-map', `0:s:${ordinal}`, '-f', 'webvtt', '-'],
      { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error || !stdout || !stdout.trim()) return resolve(null)
        resolve(stdout)
      }
    )
  })
}

// Hardware H.264 encoders ffmpeg was built with support for, in priority
// order — verified live against this project's own dev hardware (an
// NVIDIA RTX 4080 + AMD integrated graphics): h264_nvenc, h264_amf, and
// h264_mf all produced valid, comfortably-real-time output at 1080p30
// (10s of synthetic 1080p30 test content encoded in ~1-1.6s wall-clock
// via each). h264_qsv correctly FAILED outright — no Intel Quick Sync
// hardware present on that machine — which is exactly why
// detectVideoEncoder below does a real functional probe per candidate
// instead of trusting `ffmpeg -encoders`' compile-time list (which lists
// h264_qsv here too, despite it being unusable). Per-encoder args are
// ffmpeg-wiki-documented real-time/low-latency defaults, not exhaustively
// tuned per vendor — only whichever of these actually works on a given
// machine is ever used, so an unverified vendor's args cost that machine
// nothing.
const HW_VIDEO_ENCODER_CANDIDATES = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf']

const VIDEO_ENCODER_ARGS: Record<string, string[]> = {
  h264_nvenc: [
    '-preset',
    'p4',
    '-tune',
    'll',
    '-rc',
    'vbr',
    '-cq',
    '23',
    '-b:v',
    '8M',
    '-maxrate',
    '12M',
    '-bufsize',
    '16M'
  ],
  h264_qsv: ['-preset', 'fast', '-b:v', '8M', '-maxrate', '12M'],
  h264_amf: ['-quality', 'speed', '-rc', 'vbr_latency', '-b:v', '8M', '-maxrate', '12M'],
  h264_mf: ['-b:v', '8M']
}

let cachedVideoEncoder: string | null | undefined

/** Real functional probe, not just "is it compiled in" — a tiny real
 *  encode job against one candidate, since a hardware encoder can be
 *  compiled into ffmpeg but still fail immediately at runtime on
 *  hardware that doesn't support it (see HW_VIDEO_ENCODER_CANDIDATES'
 *  own comment on h264_qsv). */
function probeVideoEncoder(
  ffmpegPath: string,
  encoder: string,
  { execFileImpl = execFile }: ExecFileImplOptions = {}
): Promise<boolean> {
  return new Promise((resolve) => {
    execFileImpl(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=0.5:size=320x240:rate=10',
        '-c:v',
        encoder,
        ...(VIDEO_ENCODER_ARGS[encoder] || []),
        '-f',
        'null',
        '-'
      ],
      { windowsHide: true, timeout: 8000 },
      (error) => resolve(!error)
    )
  })
}

/**
 * Cached (module-level, resolved once per app run — hardware capability
 * doesn't change mid-session) result of probing HW_VIDEO_ENCODER_CANDIDATES
 * in priority order. Only ever consulted when a source's video codec has
 * already been flagged (see videoCodecCompatibilityWarning) AND the
 * person has opted in via Settings' video-transcode toggle — this never
 * runs for ordinary playback, and never falls back to a software
 * encoder (this ffmpeg build has none — see the file header for why the
 * original VLC/software-VP8 attempt was abandoned): if nothing in the
 * candidate list actually works, this returns null and playback falls
 * back to the existing copy-mode-plus-warning behavior untouched.
 */
export async function detectVideoEncoder(
  ffmpegPath: string,
  options: ExecFileImplOptions = {}
): Promise<string | null> {
  if (cachedVideoEncoder !== undefined) return cachedVideoEncoder
  if (!ffmpegPath) {
    cachedVideoEncoder = null
    return null
  }
  for (const candidate of HW_VIDEO_ENCODER_CANDIDATES) {
    if (await probeVideoEncoder(ffmpegPath, candidate, options)) {
      cachedVideoEncoder = candidate
      return cachedVideoEncoder
    }
  }
  cachedVideoEncoder = null
  return null
}

/** Test-only: detectVideoEncoder's cache would otherwise make repeat probes within the same process a no-op. */
export function resetVideoEncoderCache(): void {
  cachedVideoEncoder = undefined
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

export interface FfmpegTranscoderResult {
  url: string
  engine: string
  compatibility: true
}

export interface FfmpegTranscoder {
  start: (
    ffmpegPath: string,
    remoteUrl: string,
    selection?: PlaybackSelection,
    videoEncoder?: string,
    targetHeight?: number
  ) => Promise<FfmpegTranscoderResult>
  stop: () => Promise<void>
}

export interface CreateFfmpegTranscoderOptions {
  spawnImpl?: typeof spawn
  randomBytes?: typeof crypto.randomBytes
  onLog?: (chunk: string) => void
}

/**
 * Runs ffmpeg (copy video, transcode only audio — see the file-header
 * comment for why) and serves its stdout over a local HTTP server we own,
 * rather than relying on ffmpeg's own HTTP output (verified live that
 * ffmpeg's own `-listen 1` HTTP muxer doesn't behave as a normal
 * continuously-streaming server for this use case).
 *
 * ffmpeg's stdout isn't read by anyone until a real HTTP client (the
 * renderer's `<video>` element) connects — which only happens *after*
 * `start()` below has already returned the stream URL to the caller. If
 * ffmpeg produces more than one pipe-buffer's worth of output before that
 * (verified live: Windows fills at 64KB) with nobody draining it, the
 * write blocks — and that stall can starve ffmpeg's own stderr progress
 * output too, since both come from the same process loop. An earlier
 * version of this function used that stderr `frame=N` progress output to
 * detect readiness and hung indefinitely for exactly this reason on a
 * `-ss`-seeked restart. Watching stdout's actual bytes directly avoids
 * that dependency, but means this function and the eventual HTTP client
 * are two readers of the same stream — bytes seen here must be buffered
 * and replayed to the client, not just observed, or the fragment(s)
 * consumed while detecting readiness (container header included) would
 * never reach the real client. `pendingChunks`/`clientRes` below implement
 * that: buffer until a client connects, then forward directly (with
 * manual backpressure via `res.write()`'s return value, since forwarding
 * this way loses the automatic backpressure `.pipe()` would have given).
 */
export function createFfmpegTranscoder({
  spawnImpl = spawn,
  randomBytes = crypto.randomBytes,
  onLog = () => {}
}: CreateFfmpegTranscoderOptions = {}): FfmpegTranscoder {
  let child: ChildProcess | null = null
  let server: http.Server | null = null
  // Bumped once per start() call — lets a still-starting call recognize
  // it's been superseded by a newer one (e.g. clicking a second track
  // change before the first has finished restarting ffmpeg) rather than
  // reporting the kill stop() issues on its behalf as a genuine failure.
  let generation = 0

  async function stop(): Promise<void> {
    if (server) {
      const closing = server
      server = null
      await new Promise<void>((resolve) => closing.close(() => resolve()))
    }
    if (child && !child.killed) {
      const dying = child
      // Sending the kill signal doesn't mean the process (or its network
      // connection to the remote source) has actually torn down yet —
      // reported live: seeking killed the old ffmpeg and spawned the new
      // one before the old one's connection to the source had actually
      // closed, and the new connection was rejected outright (many
      // streaming/debrid sources, TorBox included, cap concurrent
      // connections per stream link). Waiting for the real 'exit' event
      // — not just issuing kill() — closes most of that race; the 3s
      // timeout is a backstop in case the process ever ignores the
      // signal outright.
      const exited = new Promise<void>((resolve) => dying.once('exit', () => resolve()))
      dying.kill()
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3000))])
    }
    child = null
  }

  async function start(
    ffmpegPath: string,
    remoteUrl: string,
    selection: PlaybackSelection = {},
    videoEncoder?: string,
    targetHeight?: number
  ): Promise<FfmpegTranscoderResult> {
    if (!ffmpegPath) throw new Error('Compatibility mode is unavailable (ffmpeg not found).')
    // Bumped *before* stop() deliberately — stop() kills and awaits the
    // previous child's exit, which runs that child's own exit handler
    // (registered back when IT called start()) synchronously within this
    // await. That handler needs to already see the new generation to
    // recognize itself as superseded; bumping after stop() would still
    // show it the old generation and misreport a real crash instead.
    const myGeneration = ++generation
    await stop()
    const port = await freePort()
    const token = randomBytes(32).toString('hex')
    const args = buildFfmpegArguments(remoteUrl, selection, videoEncoder, targetHeight)
    child = spawnImpl(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const spawned = child

    spawned.stderr?.on('data', (chunk: Buffer) => {
      try {
        onLog(chunk.toString())
      } catch {
        // ignore log handler errors
      }
    })

    let ready = false
    let totalBytes = 0
    let clientRes: http.ServerResponse | null = null
    let stdoutPaused = false
    let stdoutEnded = false
    const pendingChunks: Buffer[] = []
    // Comfortably beyond the tiny ftyp/empty-moov header (observed ~1-2KB
    // live) so readiness means a real media fragment arrived, not just the
    // container header — the same shallow-check gap that made the old
    // VLC-based version's "any nonzero byte" check misleadingly pass. Now
    // just a sanity floor, not the real readiness gate — see MIN_BUFFER_MS.
    const READY_BYTES = 8192
    // The actual fix for live-reported playback stutter: this used to be
    // the *only* readiness gate, so the client's <video> element started
    // pulling from this response after as little as ~8KB had arrived —
    // for a real 1080p copy-mode stream that's a few milliseconds of
    // buffered head start, effectively none. Verified live: with only
    // READY_BYTES gating, `getVideoPlaybackQuality()` showed buffered.end
    // sitting within milliseconds of currentTime throughout playback (zero
    // cushion) with `waiting` firing repeatedly and dropped frames
    // climbing — any brief dip in TorBox's upstream fetch throughput
    // starved the player instantly, since there was nothing buffered
    // ahead to absorb it. Requiring a real multi-second wall-clock head
    // start before the client ever starts consuming this stream — the
    // same thing a normal streaming player's initial buffering spinner
    // does — gives that cushion room to absorb ordinary jitter instead of
    // it turning into a visible stutter every few seconds.
    //
    // User-configurable (Settings > Playback buffer — see
    // shared/media-hub/playbackBuffer.ts): a fixed 3s floor doesn't help
    // enough on a genuinely bad connection, so "Extra"/"Maximum" let
    // someone deliberately trade a longer wait up front for a smoother
    // watch. This is the server-side floor specifically for compatibility
    // mode's transcode; PlaybackOverlay's client-side buffered-ahead gate
    // (the same setting) is what actually does most of the work, and
    // applies to direct/proxied playback too, not just this mode.
    const MIN_BUFFER_MS = getPlaybackBufferSeconds(readSettings().playbackBuffer) * 1000
    const startedAt = Date.now()

    // Without this, the HTTP response never ends on its own once ffmpeg
    // finishes (a natural EOF for a short/finite source, not just a
    // killed session) — verified live: the <video> element sat in
    // `waiting`/`stalled` past the last real fragment instead of firing
    // `ended`, since nothing ever called res.end() for it.
    spawned.stdout?.on('end', () => {
      stdoutEnded = true
      clientRes?.end()
    })

    const readyPromise = new Promise<void>((resolve, reject) => {
      spawned.stdout?.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length
        if (clientRes) {
          const ok = clientRes.write(chunk)
          if (!ok) {
            spawned.stdout?.pause()
            stdoutPaused = true
          }
        } else {
          pendingChunks.push(chunk)
        }
        if (!ready && totalBytes >= READY_BYTES && Date.now() - startedAt >= MIN_BUFFER_MS) {
          ready = true
          resolve()
        }
      })
      spawned.once('error', (error) => {
        if (!ready) reject(new Error(`ffmpeg failed to start: ${error.message}`))
      })
      spawned.once('exit', (code) => {
        if (ready) return
        // A newer start() call already issued the stop() that killed this
        // process (e.g. a second track change clicked before the first
        // finished restarting ffmpeg) — that supersession is the newer
        // call's own doing, not a failure of this one, so don't report it
        // as "ffmpeg exited before producing video" for a request nobody
        // is still waiting on the normal way.
        if (myGeneration !== generation) {
          const superseded = new Error('Superseded by a newer track/quality change.')
          superseded.name = 'SupersededTranscodeError'
          reject(superseded)
          return
        }
        // A short/low-bitrate clip can finish under READY_BYTES entirely —
        // if ffmpeg exited having produced *some* real output, that's
        // still a legitimate success, not a failure.
        if (totalBytes > 0) {
          ready = true
          resolve()
        } else {
          reject(new Error(`ffmpeg exited before producing video (code ${code}).`))
        }
      })
      // A real hardware video re-encode (videoEncoder set — see
      // playbackSession.ts's videoTranscodeEnabled gate) is fundamentally
      // heavier than this mode's normal audio-only transcode (stream-copy
      // video, just re-encode audio) — found live: a fixed 25s budget that
      // works fine for audio-only reliably timed out for a real video
      // re-encode on the same machine/source, even though it eventually
      // would have produced output. Audio-only mode keeps the original,
      // already-proven 25s; video re-encoding gets more room.
      setTimeout(
        () => {
          if (!ready) reject(new Error('Compatibility mode did not start producing video in time.'))
        },
        videoEncoder ? 60000 : 25000
      )
    })
    readyPromise.catch(() => {})

    const expectedPath = `/${token}.mp4`
    server = http.createServer((req, res) => {
      if (req.url !== expectedPath) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-cache' })
      for (const chunk of pendingChunks) res.write(chunk)
      pendingChunks.length = 0
      if (stdoutEnded) {
        // A short/fast clip (e.g. copy-mode races through in well under a
        // second) can finish entirely before any client ever connects —
        // the 'end' listener above had nothing to call .end() on yet.
        res.end()
        return
      }
      clientRes = res
      res.on('drain', () => {
        if (stdoutPaused) {
          stdoutPaused = false
          spawned.stdout?.resume()
        }
      })
      req.on('close', () => {
        if (clientRes !== res) return
        clientRes = null
        // If stdout was paused waiting for *this* response to drain, no
        // 'drain' event is ever coming now that it's gone — without this,
        // stdout would stay paused forever (no more 'data' events at all),
        // permanently stalling the session even though nothing is
        // actually broken downstream.
        if (stdoutPaused) {
          stdoutPaused = false
          spawned.stdout?.resume()
        }
      })
    })
    const activeServer = server
    await new Promise<void>((resolve, reject) => {
      activeServer.once('error', reject)
      activeServer.listen(port, '127.0.0.1', () => resolve())
    })

    try {
      await readyPromise
    } catch (error) {
      // A timeout/failure here previously left `spawned` running forever —
      // the next start() call's own stop() would eventually reap it, but
      // only if something ever called start() again; a caller that just
      // shows the error and gives up left it orphaned indefinitely (found
      // live: a stray ffmpeg.exe still holding a network connection and
      // over a GB of memory, well after its triggering attempt had failed).
      if (!spawned.killed) spawned.kill()
      activeServer.close()
      if (server === activeServer) server = null
      if (child === spawned) child = null
      throw error
    }
    return {
      url: `http://127.0.0.1:${port}${expectedPath}`,
      engine: 'ffmpeg audio compatibility (video copy)',
      compatibility: true
    }
  }

  return { start, stop }
}
