// Ported from r3v07v3r-media-hub's src/vlc.cjs. Two separate security
// boundaries live in this file and are preserved exactly, byte-for-byte in
// intent, from the original: (1) command-injection defenses around the VLC
// subprocess — `buildVlcArguments` validates the remote URL (re-checking
// `isAllowedRemoteMediaUrl`, defense in depth, right before every VLC
// spawn), the compatibility port range, and the compatibility-token format
// (64 hex chars) *before* any of it is used to build a spawned argument
// list; (2) the same SSRF checks from playback.ts, re-applied here before
// ever invoking ffprobe/ffmpeg/VLC against a remote URL. Do not loosen,
// skip, or "simplify" any of these checks without re-auditing against the
// source app.
//
// Deliberate deviation from the original: `findVlc()` in the source app is
// Windows-only (hardcoded `vlc.exe`, Windows Registry lookups, Windows
// direct-install-path checks) because that app only ever shipped a Windows
// NSIS build. This project's electron-builder.yml targets win/mac/linux,
// so `findVlc()` below is generalized to branch on `process.platform` the
// same way `findFfprobe`/`findFfmpeg` already did in the original: the
// `win32` branch keeps the exact original behavior unchanged (direct
// paths, then registry query, then PATH scan for `vlc.exe`); `darwin` and
// the fallback (linux/other) branches are new, added to match this
// project's build targets, and check the platform-conventional install
// locations before falling back to a PATH scan for the unadorned `vlc`
// executable name. The Windows Registry (`reg.exe`) query stays strictly
// inside the `win32` branch — it is never attempted on other platforms.

import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'

import type { MediaTrack, MediaTracks, PlaybackSelection } from '../../shared/media-hub/types'
import { isAllowedRemoteMediaUrl } from './playback'

/** Compatibility-stream token: 64 lowercase hex chars, same shape as the playback-proxy token. */
export function isValidCompatibilityToken(value: unknown): boolean {
  return /^[a-f0-9]{64}$/.test(String(value))
}

function cleanSelection(value: unknown, fallback = -1): number {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 && number < 100 ? number : fallback
}

/**
 * Builds the VLC CLI argument list for compatibility-mode transcoding.
 * Every value that ends up in `args` is validated first: `remoteUrl` must
 * pass `isAllowedRemoteMediaUrl` (SSRF defense, re-checked here as defense
 * in depth immediately before every VLC spawn), `port` must be a real
 * ephemeral/user port (1024-65535), and `token` must match the 64-hex-char
 * compatibility-token shape. This is the command-injection defense for the
 * VLC subprocess: none of these values reach `spawn` unvalidated.
 */
export function buildVlcArguments(
  remoteUrl: string,
  port: number,
  token: string,
  selection: PlaybackSelection = {}
): string[] {
  if (!isAllowedRemoteMediaUrl(remoteUrl)) {
    throw new Error('VLC compatibility requires a valid HTTPS media URL.')
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Invalid VLC compatibility port.')
  }
  if (!isValidCompatibilityToken(token)) {
    throw new Error('Invalid VLC compatibility stream token.')
  }

  // --avcodec-hw=none: verified live (VLC's own --verbose=2 log) that this
  // machine's GPU-accelerated decode (d3d11va/NVDEC) hands the vpx VP8
  // encoder frames whose PTS values aren't monotonically increasing ("pts
  // is smaller than initial pts"), which the encoder rejects — in the
  // worst case this wedges the whole transcode permanently (the muxer
  // waits forever for a frame that will never come, so the HTTP output
  // never delivers anything past its initial container header) and
  // otherwise drops frames throughout ("late buffer for mux input"),
  // which is what surfaces as playback stutter. Forcing software decode
  // removed the PTS-ordering mismatch entirely in the same repro.
  const args = [
    '-I',
    'dummy',
    '--no-one-instance',
    '--no-video-title-show',
    '--avcodec-hw=none'
  ]
  const audio = cleanSelection(selection.audio)
  const subtitle = cleanSelection(selection.subtitle)
  const startTime = Math.max(0, Number(selection.startTime) || 0)
  const externalSubtitlePath =
    typeof selection.externalSubtitlePath === 'string' ? selection.externalSubtitlePath : ''

  if (audio >= 0) args.push(`--audio-track=${audio}`)
  if (externalSubtitlePath) args.push(`--sub-file=${externalSubtitlePath}`)
  else if (subtitle >= 0) args.push(`--sub-track=${subtitle}`)
  if (startTime > 0) args.push(`--start-time=${Math.floor(startTime)}`)

  args.push(
    '--sout',
    `#transcode{vcodec=VP80,vb=2800,scale=1,acodec=vorb,ab=160,channels=2,samplerate=48000,soverlay}:std{access=http,mux=webm,dst=127.0.0.1:${port}/${token}.webm}`,
    '--sout-keep',
    remoteUrl
  )
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

// Windows-only: queries the Registry for VLC's InstallDir. Never invoked
// outside the `win32` branch of `findVlc` below.
function registryInstallDir(key: string): string {
  try {
    const output = execFileSync('reg', ['query', key, '/v', 'InstallDir'], {
      windowsHide: true,
      encoding: 'utf8'
    })
    return output.match(/InstallDir\s+REG_SZ\s+(.+)/)?.[1]?.trim() || ''
  } catch {
    return ''
  }
}

/**
 * Locates the VLC executable for the current platform. See the file-header
 * comment for why this differs from the original (Windows-only) source:
 * this project ships win/mac/linux builds, so each platform gets its own
 * search strategy, with the `win32` branch kept byte-for-byte identical to
 * the original app's only supported platform.
 */
export function findVlc(): string {
  if (process.platform === 'win32') {
    const executable = 'vlc.exe'
    const direct = [
      'C:/Program Files/VideoLAN/VLC/vlc.exe',
      'C:/Program Files (x86)/VideoLAN/VLC/vlc.exe'
    ]
    for (const candidate of direct) {
      if (fs.existsSync(candidate)) return candidate
    }
    for (const key of [
      'HKLM\\SOFTWARE\\VideoLAN\\VLC',
      'HKLM\\SOFTWARE\\WOW6432Node\\VideoLAN\\VLC'
    ]) {
      const dir = registryInstallDir(key)
      if (dir) {
        const candidate = path.join(dir, executable)
        if (fs.existsSync(candidate)) return candidate
      }
    }
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue
      const candidate = path.join(dir, executable)
      if (fs.existsSync(candidate)) return candidate
    }
    return ''
  }

  if (process.platform === 'darwin') {
    const direct = '/Applications/VLC.app/Contents/MacOS/VLC'
    if (fs.existsSync(direct)) return direct
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue
      const candidate = path.join(dir, 'vlc')
      if (fs.existsSync(candidate)) return candidate
    }
    return ''
  }

  // linux (and any other non-Windows, non-macOS platform)
  const direct = [
    '/usr/bin/vlc',
    '/usr/local/bin/vlc',
    '/snap/bin/vlc',
    '/var/lib/flatpak/exports/bin/org.videolan.VLC'
  ]
  for (const candidate of direct) {
    if (fs.existsSync(candidate)) return candidate
  }
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, 'vlc')
    if (fs.existsSync(candidate)) return candidate
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
  const direct = [
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

function waitForPort(
  port: number,
  timeout = 8000,
  { signal }: { signal?: AbortSignal } = {}
): Promise<void> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      if (signal?.aborted) {
        reject(new Error('VLC compatibility mode was cancelled.'))
        return
      }
      const socket = net.connect({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.destroy()
        resolve()
      })
      socket.once('error', () => {
        socket.destroy()
        if (signal?.aborted) reject(new Error('VLC compatibility mode was cancelled.'))
        else if (Date.now() - started >= timeout)
          reject(new Error('VLC compatibility mode did not start in time.'))
        else setTimeout(attempt, 150)
      })
    }
    attempt()
  })
}

export function waitForStreamData(
  url: string,
  timeout = 25000,
  { httpGetImpl = http.get, signal }: { httpGetImpl?: typeof http.get; signal?: AbortSignal } = {}
): Promise<void> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      if (signal?.aborted) {
        reject(new Error('VLC compatibility mode was cancelled.'))
        return
      }
      const retryOrFail = (): void => {
        if (signal?.aborted) {
          reject(new Error('VLC compatibility mode was cancelled.'))
          return
        }
        if (Date.now() - started >= timeout) {
          reject(new Error('VLC compatibility mode did not start producing video in time.'))
          return
        }
        setTimeout(attempt, 300)
      }
      let settled = false
      const req = httpGetImpl(url, (response) => {
        response.on('data', (chunk: Buffer) => {
          if (settled || !chunk.length) return
          settled = true
          req.destroy()
          response.destroy()
          resolve()
        })
        response.on('error', () => {
          if (!settled) retryOrFail()
        })
        response.on('end', () => {
          if (!settled) retryOrFail()
        })
      })
      req.on('error', () => {
        if (!settled) retryOrFail()
      })
      req.setTimeout(2000, () => req.destroy())
    }
    attempt()
  })
}

export interface VlcTranscoderResult {
  url: string
  engine: string
  compatibility: true
}

export interface VlcTranscoder {
  start: (
    vlcPath: string,
    remoteUrl: string,
    selection?: PlaybackSelection
  ) => Promise<VlcTranscoderResult>
  stop: () => Promise<void>
}

export interface CreateVlcTranscoderOptions {
  spawnImpl?: typeof spawn
  randomBytes?: typeof crypto.randomBytes
  onLog?: (chunk: string) => void
  httpGetImpl?: typeof http.get
}

export function createVlcTranscoder({
  spawnImpl = spawn,
  randomBytes = crypto.randomBytes,
  onLog = () => {},
  httpGetImpl = http.get
}: CreateVlcTranscoderOptions = {}): VlcTranscoder {
  let child: ChildProcess | null = null

  async function stop(): Promise<void> {
    if (child && !child.killed) child.kill()
    child = null
  }

  async function start(
    vlcPath: string,
    remoteUrl: string,
    selection: PlaybackSelection = {}
  ): Promise<VlcTranscoderResult> {
    if (!vlcPath) throw new Error('VLC is not installed. Install VLC to use compatibility mode.')
    await stop()
    const port = await freePort()
    const token = randomBytes(32).toString('hex')
    const args = buildVlcArguments(remoteUrl, port, token, selection)
    child = spawnImpl(vlcPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    const spawned = child
    spawned.stderr?.on('data', (chunk: Buffer) => {
      try {
        onLog(chunk.toString())
      } catch {
        // ignore log handler errors
      }
    })
    const portAbort = new AbortController()
    const spawnError = new Promise<never>((_resolve, reject) => {
      spawned.once('error', (error) => {
        child = null
        portAbort.abort()
        reject(new Error(`VLC failed to start: ${error.message}`))
      })
    })
    spawnError.catch(() => {})
    spawned.unref?.()
    const streamUrl = `http://127.0.0.1:${port}/${token}.webm`
    const portWait = waitForPort(port, 8000, { signal: portAbort.signal }).then(() =>
      waitForStreamData(streamUrl, 25000, { httpGetImpl, signal: portAbort.signal })
    )
    portWait.catch(() => {})
    await Promise.race([portWait, spawnError])
    return { url: streamUrl, engine: 'VLC audio/video compatibility', compatibility: true }
  }

  return { start, stop }
}
