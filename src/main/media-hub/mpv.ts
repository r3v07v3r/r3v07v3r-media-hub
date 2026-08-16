// The playback engine: a bundled mpv process embedded into the app window,
// driven over mpv's JSON IPC protocol.
//
// WHY THIS REPLACED THE <video> ELEMENT. A Chromium <video> element exposes no
// audio-track selection API at all — it plays whatever the container marks
// default and there is no way to ask it for anything else. The old design
// therefore had to bake the chosen track into the bytes (`-map 0:a:N`), which
// made "switch audio track" mean: kill ffmpeg, wait for its exit, bind a new
// port, respawn with `-ss`, re-parse the container, hand the renderer a new
// URL, throw away every buffered byte, and re-buffer twice. Measured floor was
// ~6-10s on the default buffer preset and ~30s on "maximum". mpv demuxes and
// decodes locally, so the same operation is a property write: measured at 1ms
// against a real multi-track file, with the playhead unmoved.
//
// The same single change removes a long tail of consequences: no audio
// transcode (so no forced stereo downmix, and TrueHD/DTS no longer have to be
// avoided), no codec allowlist (HEVC/VC1/AV1 decode natively), embedded
// subtitles without demuxing the whole file first, PGS/VobSub rendering that
// was previously impossible, and correct subtitle timing because there is no
// segment offset to reconcile.
//
// SECURITY. Spawning mpv against a URL is at least as dangerous as
// `ffmpeg -i <url>` — libmpv's protocol surface is strictly larger (`lavf://`,
// `avdevice://`, `edl://`, `memory://`), and it can load config files and
// Lua/JS user scripts. Two rules, neither optional:
//   1. assertPlayableUrl() below re-checks every URL immediately before
//      loadfile, the same defense-in-depth the ffmpeg spawn sites used.
//   2. The process is launched with --no-config --load-scripts=no --ytdl=no,
//      and every user-influenced value goes through the JSON command/property
//      API as a discrete argument — never interpolated into an option string.

import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import type { MediaTrack, MediaTracks } from '../../shared/media-hub/types'
import { isAllowedRemoteMediaUrl } from './playback'
import { isOwnCacheUrl } from './streamCache'

/** Mirrors vlc.ts's findFfmpeg(): the bundled copy first, then a system search
 *  so `electron-vite dev` works on a machine that has mpv installed without
 *  having run the postinstall fetch. Packaged builds always hit the first
 *  candidate — see electron-builder.yml's win.extraResources. */
export function findMpv(): string {
  const executable = process.platform === 'win32' ? 'mpv.exe' : 'mpv'
  const bundled = path.join(process.resourcesPath || '', 'mpv', executable)
  const candidates = [
    process.env.MPV_PATH,
    bundled,
    // The repo-local copy scripts/fetch-mpv.ts writes, for dev runs where
    // process.resourcesPath doesn't point at the packaged resources folder.
    path.join(process.cwd(), 'resources', 'mpv-win', executable),
    'C:/Program Files/mpv/mpv.exe',
    ...String(process.env.PATH || '')
      .split(path.delimiter)
      .map((dir) => path.join(dir, executable))
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    } catch {
      // An unreadable PATH entry is not a reason to abandon the search.
    }
  }
  return ''
}

/**
 * The gate every URL must pass before it reaches mpv. Ported verbatim in intent
 * from the check `buildFfmpegArguments` ran immediately before every ffmpeg
 * spawn — deleting that file must not delete its guard. Either a genuine public
 * HTTPS media URL (isAllowedRemoteMediaUrl: no private/loopback hosts, no
 * embedded credentials, https only, re-resolved against DNS rebinding upstream)
 * or one of StreamCache's own loopback URLs, which is narrower than it looks:
 * isOwnCacheUrl only matches a 64-hex token this process minted and still has
 * registered, not any URL of that shape.
 */
export function assertPlayableUrl(url: string): void {
  if (!isAllowedRemoteMediaUrl(url) && !isOwnCacheUrl(url)) {
    throw new Error('Playback requires a valid HTTPS media URL.')
  }
}

/** One entry of mpv's `track-list` property. Untrusted external tool output —
 *  only the fields actually read are modeled, same convention as the old
 *  FfprobeStream shape. */
export interface MpvTrackListEntry {
  id?: unknown
  type?: unknown
  'src-id'?: unknown
  lang?: unknown
  title?: unknown
  codec?: unknown
  default?: unknown
  'demux-w'?: unknown
  'demux-h'?: unknown
  'demux-channel-count'?: unknown
}

function trackLabel(
  entry: MpvTrackListEntry,
  type: 'video' | 'audio' | 'subtitle',
  ordinal: number
): string {
  // Formatting preserved exactly from vlc.ts's mediaLabel so the track menus
  // read identically to before the engine swap.
  const name = String(entry.title || '').trim()
  const language = String(entry.lang || '')
    .trim()
    .toUpperCase()
  const codec = String(entry.codec || 'unknown').toUpperCase()
  const width = Number(entry['demux-w'])
  const height = Number(entry['demux-h'])
  const channels = Number(entry['demux-channel-count'])
  const parts: string[] = []
  if (name) parts.push(name)
  else parts.push(`${type[0].toUpperCase() + type.slice(1)} ${ordinal + 1}`)
  if (type === 'video' && width > 0 && height > 0) parts.push(`${width}×${height}`)
  if (language && type !== 'video') parts.push(language)
  if (type === 'audio' && Number.isFinite(channels) && channels > 0) parts.push(`${channels}ch`)
  parts.push(codec)
  return parts.join(' • ')
}

/**
 * ORDINALS ARE 0-BASED, mpv's TRACK IDS ARE 1-BASED.
 *
 * `MediaTrack.ordinal` stays 0-based and per-type, exactly as ffprobe's
 * parseMediaTracks produced it, so every renderer call site that already speaks
 * ordinals keeps working untouched. mpv's `aid`/`sid`/`vid` are 1-based per
 * type, so the conversion happens only at this boundary — see
 * mpvTrackIdForOrdinal below. Getting this wrong selects a neighbouring track
 * silently rather than failing, which is why both directions are unit-tested.
 */
export function tracksFromMpvTrackList(
  list: MpvTrackListEntry[] = [],
  durationSeconds?: number
): MediaTracks {
  const result: {
    video: MediaTrack[]
    audio: MediaTrack[]
    subtitle: MediaTrack[]
    probed: true
    durationSeconds?: number
  } = { video: [], audio: [], subtitle: [], probed: true }

  if (Number.isFinite(durationSeconds) && (durationSeconds as number) > 0) {
    result.durationSeconds = durationSeconds
  }

  for (const entry of list) {
    // mpv calls them 'sub'; the rest of this app calls them 'subtitle'.
    const rawType = String(entry.type || '')
    const type =
      rawType === 'video'
        ? 'video'
        : rawType === 'audio'
          ? 'audio'
          : rawType === 'sub'
            ? 'subtitle'
            : null
    if (!type) continue

    const ordinal = result[type].length
    const width = Number(entry['demux-w'])
    const height = Number(entry['demux-h'])
    result[type].push({
      ordinal,
      // `src-id` is the container's own stream index, the closest equivalent to
      // ffprobe's `index`. Absent for tracks mpv added itself (an external
      // subtitle loaded via sub-add), where -1 is the honest answer.
      index: Number.isFinite(Number(entry['src-id'])) ? Number(entry['src-id']) : -1,
      codec: String(entry.codec || 'unknown').toLowerCase(),
      language: String(entry.lang || ''),
      title: String(entry.title || ''),
      label: trackLabel(entry, type, ordinal),
      default: Boolean(entry.default),
      ...(type === 'video' && Number.isFinite(width) && width > 0 ? { width } : {}),
      ...(type === 'video' && Number.isFinite(height) && height > 0 ? { height } : {})
    })
  }
  return result
}

/** 0-based per-type ordinal -> mpv's 1-based `aid`/`sid`. `-1` means "none",
 *  which mpv spells `'no'`. */
export function mpvTrackIdForOrdinal(ordinal: number): number | 'no' {
  return Number.isInteger(ordinal) && ordinal >= 0 ? ordinal + 1 : 'no'
}

/** mpv's 1-based `aid`/`sid` -> 0-based per-type ordinal. mpv reports `false`
 *  for a disabled track and `'auto'` before one has been resolved. */
export function ordinalForMpvTrackId(id: unknown): number {
  const numeric = Number(id)
  return Number.isInteger(numeric) && numeric >= 1 ? numeric - 1 : -1
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export interface MpvSpawnOptions {
  /** Native window handle to embed into. Windows: the decimal HWND. */
  wid?: string
  onLog?: (line: string) => void
  spawnImpl?: typeof spawn
}

const COMMAND_TIMEOUT_MS = 15000

/**
 * Owns one long-lived mpv process. Long-lived deliberately: the process
 * survives across titles (verified — the same instance loads a second title
 * cleanly), so a title change is a `loadfile`, not a respawn. This also keeps
 * the process independent of any React lifecycle, so the renderer remounting
 * its player UI per title costs nothing.
 */
export class MpvPlayer {
  private child: ChildProcess | null = null
  private socket: net.Socket | null = null
  private readonly pending = new Map<number, PendingRequest>()
  private readonly observers = new Map<number, (value: unknown) => void>()
  private readonly eventHandlers = new Map<string, Array<(msg: Record<string, unknown>) => void>>()
  private buffer = ''
  private nextId = 1
  private pipeName = ''
  private onLog: (line: string) => void = () => {}

  get running(): boolean {
    return Boolean(this.child && !this.child.killed && this.socket)
  }

  async start(mpvPath: string, options: MpvSpawnOptions = {}): Promise<void> {
    if (!mpvPath) throw new Error('Playback is unavailable (mpv not found).')
    if (this.running) return

    const { wid, onLog, spawnImpl = spawn } = options
    this.onLog = onLog ?? (() => {})
    this.pipeName = `r3-media-hub-mpv-${crypto.randomBytes(12).toString('hex')}`

    const args = [
      `--input-ipc-server=\\\\.\\pipe\\${this.pipeName}`,
      // Security posture — see this file's header. --no-config also means the
      // app's playback behaviour can never be altered by a stray mpv.conf on
      // the user's machine, which matters for reproducibility as much as safety.
      '--no-config',
      '--load-scripts=no',
      '--ytdl=no',
      // Stay alive between titles, and create NO window until a file is
      // actually loaded. --force-window=no is what lets the app's own UI show
      // through when playback stops: mpv destroys its child window on `stop`,
      // with no native ShowWindow call needed on this side.
      '--idle=yes',
      '--force-window=no',
      '--keep-open=yes',
      // The app owns all input. Without these, mpv's own bindings would fight
      // the renderer's keyboard handling for the same keys.
      '--no-input-default-bindings',
      '--input-vo-keyboard=no',
      '--osc=no',
      '--osd-level=0',
      '--hwdec=auto-safe',
      // StreamCache already owns the real buffer and the single upstream
      // connection to the debrid link; mpv only needs a modest readahead on top
      // of the local loopback server, and must not duplicate it onto disk.
      '--cache=yes',
      '--cache-on-disk=no',
      '--msg-level=all=warn'
    ]
    if (wid) args.push(`--wid=${wid}`)

    const child = spawnImpl(mpvPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    child.stderr?.on('data', (chunk: Buffer) => {
      try {
        this.onLog(chunk.toString())
      } catch {
        // Logging must never break the playback it is observing.
      }
    })
    child.once('exit', () => {
      this.child = null
      this.failAllPending(new Error('mpv exited'))
    })

    await this.connect()
  }

  /** mpv creates the named pipe asynchronously after spawn, so the first
   *  connect attempts legitimately fail — retry rather than treat that as an
   *  error. Bounded so a genuinely dead process surfaces instead of hanging. */
  private async connect(retries = 100, delayMs = 100): Promise<void> {
    const pipePath = `\\\\.\\pipe\\${this.pipeName}`
    for (let attempt = 0; attempt < retries; attempt++) {
      if (!this.child) throw new Error('mpv exited before its IPC socket was ready.')
      try {
        await new Promise<void>((resolve, reject) => {
          const socket = net.connect({ path: pipePath })
          const onError = (error: Error): void => {
            socket.destroy()
            reject(error)
          }
          socket.once('error', onError)
          socket.once('connect', () => {
            socket.removeListener('error', onError)
            socket.setEncoding('utf8')
            socket.on('data', (chunk: string) => this.onData(chunk))
            // A socket error after connect means the process is going away; the
            // 'exit' handler above is what actually reports that.
            socket.on('error', () => {})
            this.socket = socket
            resolve()
          })
        })
        return
      } catch {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }
    throw new Error('Could not connect to the player process.')
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      try {
        this.dispatch(JSON.parse(line) as Record<string, unknown>)
      } catch {
        // A malformed line is mpv's problem, not a reason to tear down the
        // channel — the next newline-delimited message is still parseable.
      }
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    const requestId = message.request_id
    if (typeof requestId === 'number' && this.pending.has(requestId)) {
      const entry = this.pending.get(requestId)!
      this.pending.delete(requestId)
      clearTimeout(entry.timer)
      const error = message.error
      if (typeof error === 'string' && error !== 'success') entry.reject(new Error(error))
      else entry.resolve(message.data)
      return
    }
    if (message.event === 'property-change') {
      const handler = this.observers.get(Number(message.id))
      if (handler) handler(message.data)
      return
    }
    if (typeof message.event === 'string') {
      const handlers = this.eventHandlers.get(message.event)
      if (handlers) for (const handler of [...handlers]) handler(message)
    }
  }

  private failAllPending(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  command<T = unknown>(...args: Array<string | number | boolean>): Promise<T> {
    const socket = this.socket
    if (!socket) return Promise.reject(new Error('The player is not running.'))
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Player command timed out: ${String(args[0])}`))
      }, COMMAND_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer
      })
      socket.write(`${JSON.stringify({ command: args, request_id: id })}\n`)
    })
  }

  get<T = unknown>(property: string): Promise<T> {
    return this.command<T>('get_property', property)
  }

  set(property: string, value: string | number | boolean): Promise<unknown> {
    return this.command('set_property', property, value)
  }

  on(event: string, handler: (msg: Record<string, unknown>) => void): () => void {
    if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, [])
    this.eventHandlers.get(event)!.push(handler)
    return () => {
      const list = this.eventHandlers.get(event)
      if (!list) return
      const index = list.indexOf(handler)
      if (index >= 0) list.splice(index, 1)
    }
  }

  once(event: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new Error(`Timed out waiting for player event: ${event}`))
      }, timeoutMs)
      const off = this.on(event, (msg) => {
        clearTimeout(timer)
        off()
        resolve(msg)
      })
    })
  }

  async observe(property: string, handler: (value: unknown) => void): Promise<number> {
    const id = this.nextId++
    this.observers.set(id, handler)
    await this.command('observe_property', id, property)
    return id
  }

  /**
   * Loads a title. `startSeconds` is applied as mpv's `start` option rather
   * than a seek after load, so playback begins at the resume position instead
   * of visibly jumping there.
   */
  async loadFile(
    url: string,
    { startSeconds, audioLanguage, subtitleLanguage }: LoadFileOptions = {}
  ): Promise<void> {
    // Defense in depth immediately before the load — see assertPlayableUrl.
    assertPlayableUrl(url)
    if (audioLanguage) await this.set('alang', audioLanguage)
    if (subtitleLanguage) await this.set('slang', subtitleLanguage)
    await this.set(
      'start',
      Number.isFinite(startSeconds) && (startSeconds as number) > 0 ? (startSeconds as number) : 0
    )
    const loaded = this.once('file-loaded', 60000)
    await this.command('loadfile', url, 'replace')
    await loaded
  }

  /** Unloads the current file, which is also what destroys the embedded video
   *  window and reveals the app UI behind it. */
  async stopFile(): Promise<void> {
    if (!this.socket) return
    await this.command('stop').catch(() => {})
  }

  async quit(): Promise<void> {
    try {
      if (this.socket) await this.command('quit').catch(() => {})
    } finally {
      this.socket?.destroy()
      this.socket = null
      const child = this.child
      if (child && !child.killed) {
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
        child.kill()
        await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3000))])
      }
      this.child = null
      this.failAllPending(new Error('The player was shut down.'))
    }
  }
}

export interface LoadFileOptions {
  startSeconds?: number
  audioLanguage?: string
  subtitleLanguage?: string
}

/**
 * Scrub-bar preview frames, via a throwaway second mpv process.
 *
 * Deliberately NOT the playing instance: mpv's screenshot commands capture the
 * frame currently on screen, so using it would mean seeking the film the person
 * is watching to wherever their cursor happens to be hovering.
 *
 * Replaces the ffmpeg `captureFrame` this used to call, and returns the same
 * `data:image/jpeg;base64,...` contract so the renderer's cache and clamping
 * are untouched. Reading it out of a temp file rather than a pipe is not a
 * preference: mpv's encode mode writes to a real path, and it needs a real
 * extension to pick the muxer.
 *
 * `--ovcopts=strict=-1` is required, not decorative. Without it MJPEG refuses
 * limited-range YUV outright ("Non full-range YUV is non-standard") and mpv
 * exits having written nothing at all — which looks exactly like a missing
 * frame rather than a rejected one.
 *
 * Reads from StreamCache's local server, like every other consumer, so a
 * preview never costs a second connection to the remote link.
 */
export async function captureThumbnail(
  mpvExecutable: string,
  url: string,
  seconds: number,
  { timeout = 10000, spawnImpl = spawn }: { timeout?: number; spawnImpl?: typeof spawn } = {}
): Promise<string | null> {
  if (!mpvExecutable || !Number.isFinite(seconds) || seconds < 0) return null
  try {
    assertPlayableUrl(url)
  } catch {
    return null
  }

  const target = path.join(
    os.tmpdir(),
    `r3-thumb-${process.pid}-${crypto.randomBytes(6).toString('hex')}.jpg`
  )
  try {
    const exitCode = await new Promise<number>((resolve) => {
      const child = spawnImpl(
        mpvExecutable,
        [
          '--no-config',
          '--load-scripts=no',
          '--ytdl=no',
          '--really-quiet',
          '--no-audio',
          '--frames=1',
          `--start=${Math.floor(seconds)}`,
          '--vf=scale=160:-2',
          '--ovcopts=strict=-1',
          `--o=${target}`,
          url
        ],
        { windowsHide: true, stdio: 'ignore' }
      )
      const timer = setTimeout(() => {
        child.kill()
        resolve(-1)
      }, timeout)
      child.once('error', () => {
        clearTimeout(timer)
        resolve(-1)
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        resolve(code ?? -1)
      })
    })
    if (exitCode === -1) return null
    const bytes = await fsp.readFile(target)
    if (!bytes.length) return null
    return `data:image/jpeg;base64,${bytes.toString('base64')}`
  } catch {
    return null
  } finally {
    await fsp.rm(target, { force: true }).catch(() => {})
  }
}

export const mpvPath = findMpv()
