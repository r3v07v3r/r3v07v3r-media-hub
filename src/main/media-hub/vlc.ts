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

import type { MediaTrack, MediaTracks, PlaybackSelection } from '../../shared/media-hub/types'
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
  selection: PlaybackSelection = {}
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
  if (startTime > 0) args.push('-ss', String(Math.floor(startTime)))
  args.push('-i', remoteUrl)
  args.push('-map', '0:v:0', '-map', audio >= 0 ? `0:a:${audio}` : '0:a:0')
  args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000')
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
    result[type].push({
      ordinal,
      index: Number(stream.index),
      codec: String(stream.codec_name || 'unknown').toLowerCase(),
      language: String(stream.tags?.language || ''),
      title: String(stream.tags?.title || ''),
      label: mediaLabel(stream, type, ordinal),
      default: Boolean(stream.disposition?.default)
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

export function needsAudioCompatibility(tracks: MediaTracks | undefined): boolean {
  const audio = tracks?.audio || []
  if (!audio.length) return false
  const selected = audio.find((x) => x.default) || audio[0]
  return !DIRECT_AUDIO_CODECS.has(String(selected.codec || '').toLowerCase())
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
    selection?: PlaybackSelection
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
    selection: PlaybackSelection = {}
  ): Promise<FfmpegTranscoderResult> {
    if (!ffmpegPath) throw new Error('Compatibility mode is unavailable (ffmpeg not found).')
    await stop()
    const port = await freePort()
    const token = randomBytes(32).toString('hex')
    const args = buildFfmpegArguments(remoteUrl, selection)
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
      setTimeout(() => {
        if (!ready) reject(new Error('Compatibility mode did not start producing video in time.'))
      }, 25000)
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

    await readyPromise
    return {
      url: `http://127.0.0.1:${port}${expectedPath}`,
      engine: 'ffmpeg audio compatibility (video copy)',
      compatibility: true
    }
  }

  return { start, stop }
}
