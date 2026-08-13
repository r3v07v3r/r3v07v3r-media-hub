// The single owner of the upstream connection to a debrid/streaming link.
// TorBox (like most debrid sources) caps concurrent connections per link —
// every other consumer that used to open its own connection to the same
// remote URL (ffmpeg's `-i`, the direct-mode Range proxy, embedded-subtitle
// extraction, thumbnail capture) now reads from the local chunk cache this
// module builds instead. A confirmed, reproduced bug motivated this: opening
// a second connection (extracting an embedded subtitle track) while a first
// was already live (video playing) either hung forever or evicted the live
// connection, which the <video> element's onError handler treats as fatal
// and closes the whole player mid-movie. Local disk reads never compete for
// that connection cap, no matter how many of them happen or how often ffmpeg
// restarts against them.
//
// Storage is a directory of fixed-size chunk files, not one big sparse file
// — avoids needing OS-level sparse-file/hole-punch APIs for eviction; a
// chunk that falls outside the retention window is just deleted. A chunk is
// only marked 'ready' after it's fully written and closed (never read while
// still being appended), so there's no Windows file-locking race between
// this module's writer and its own local server's reader.
//
// Three regions are pinned resident, not a pure FIFO window: the file's
// HEAD (container header/metadata — MKV's EBML/Segment/Tracks, or a
// faststart MP4's front-loaded moov) and TAIL (a non-faststart MP4's
// moov-at-end, or MKV's Cues-at-end — common on scene/P2P releases; a
// front-only design would regress these), plus a rolling window around
// wherever playback actually is right now. "Where playback is" is derived
// from the highest byte offset the local server has actually been asked
// for — ffmpeg/the <video> element naturally request roughly-sequential
// ranges as playback advances, so that's a reliable proxy for the playhead
// without needing an explicit position feed from the caller.

import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { app } from 'electron'

import { assertPublicMediaUrl, defaultResolveHost, fetchMediaWithRetry } from './playback'
import { logError } from './logger'
import { readSettings } from './settingsStore'

const CHUNK_BYTES = 4 * 1024 * 1024
const HEAD_BYTES = 16 * 1024 * 1024
const TAIL_BYTES = 4 * 1024 * 1024
const DEFAULT_BEHIND_SECONDS = 30
const DEFAULT_AHEAD_SECONDS = 300
/** Hard floor regardless of what the settings UI offers — see settingsStore.ts's streamCacheMaxGb. Computed from head+tail+behind+ahead at ~25Mbps with headroom for chunk-boundary rounding. */
export const MIN_CACHE_BYTES = 1.5 * 1024 * 1024 * 1024
const DISK_SAFETY_MARGIN_BYTES = 2 * 1024 * 1024 * 1024
const DISK_CHECK_INTERVAL_MS = 15_000
/** How far past the current fill frontier a request can land before it's treated as "just wait a beat" rather than "reposition the whole fetch." */
const REPOSITION_THRESHOLD_BYTES = CHUNK_BYTES * 2
const CHUNK_WAIT_TIMEOUT_MS = 20_000
/** Same TorBox-connection-teardown grace delay as playbackSession.ts's closeDirectProxyBeforeTranscode — the local proxy/fetch closing doesn't guarantee the upstream fetch has actually torn down on TorBox's end yet. */
const RECONNECT_GRACE_MS = 500

/**
 * Where the whole chunk cache lives on disk. Defaults to
 * app.getPath('userData'), same as every other on-disk cache in this app
 * (subtitleCacheDir, the settings file) — but honors settingsStore.ts's
 * streamCacheDir override (e.g. a secondary drive with more free space)
 * when one is configured. Always nests a 'stream-cache' subfolder inside
 * whatever base directory this resolves to, so a user-chosen folder's
 * OTHER contents are never something this module reads, writes, or
 * deletes — only its own subfolder.
 */
function cacheRootDir(): string {
  const configured = readSettings().streamCacheDir
  const base = typeof configured === 'string' && configured.trim() ? configured : app.getPath('userData')
  return path.join(base, 'stream-cache')
}

// Take `root` explicitly rather than calling cacheRootDir() themselves:
// a StreamCache instance captures its own root ONCE per start() (see
// `cacheRoot` in the closure below) rather than re-reading the setting on
// every single file operation — if the person changes the configured
// folder mid-download, a session already in flight must keep writing to
// wherever it started, not split its chunks across two directories.
// Changing the folder only takes effect for the NEXT title played.
function sessionDir(root: string, token: string): string {
  return path.join(root, token)
}

function chunkFilePath(root: string, token: string, index: number): string {
  return path.join(sessionDir(root, token), `chunk-${index}.bin`)
}

export function chunkIndexForByte(byte: number, chunkBytes = CHUNK_BYTES): number {
  return Math.floor(byte / chunkBytes)
}

export interface RetentionParams {
  /** Every chunk index currently on disk — in fullRetention mode nothing is ever evicted, so the retained set is just this, verbatim. */
  presentChunkIndices: Iterable<number>
  fullRetention: boolean
  totalBytes: number | null
  /** Where playback actually is right now, in bytes — see the module header comment on why this is derived from the highest byte offset actually served rather than an explicit position feed. */
  centerByte: number
  behindSeconds: number
  aheadSeconds: number
  /** undefined when duration/totalBytes aren't known yet — falls back to a fixed chunk-count window rather than a time-based one. */
  bytesPerSecond: number | undefined
  headBytes?: number
  tailBytes?: number
  chunkBytes?: number
}

/**
 * Pure retention-window math, factored out of the StreamCache closure
 * specifically so it's unit-testable without mocking Electron's `app` (see
 * tests/streamCache.test.ts) — every other piece of this module needs a
 * real filesystem/HTTP server, but the "which chunks survive eviction"
 * decision itself doesn't, and it's the one part most worth pinning down
 * with real test cases (pinned regions never evicted, ahead-window shrinks
 * under pressure, etc.).
 */
export function computeRetainedChunkIndices(params: RetentionParams): Set<number> {
  const {
    presentChunkIndices,
    fullRetention,
    totalBytes,
    centerByte,
    behindSeconds,
    aheadSeconds,
    bytesPerSecond,
    headBytes = HEAD_BYTES,
    tailBytes = TAIL_BYTES,
    chunkBytes = CHUNK_BYTES
  } = params
  if (fullRetention) return new Set(presentChunkIndices)

  const out = new Set<number>()

  const headCount = Math.ceil(headBytes / chunkBytes)
  for (let i = 0; i < headCount; i++) out.add(i)

  if (totalBytes) {
    const lastIndex = chunkIndexForByte(totalBytes - 1, chunkBytes)
    const tailCount = Math.ceil(tailBytes / chunkBytes)
    const first = Math.max(0, lastIndex - tailCount + 1)
    for (let i = first; i <= lastIndex; i++) out.add(i)
  }

  const behindBytes =
    bytesPerSecond !== undefined ? Math.floor(bytesPerSecond * behindSeconds) : chunkBytes * 4
  const aheadBytes =
    bytesPerSecond !== undefined ? Math.floor(bytesPerSecond * aheadSeconds) : chunkBytes * 32
  const windowStart = Math.max(0, centerByte - behindBytes)
  const windowEnd = totalBytes
    ? Math.min(totalBytes - 1, centerByte + aheadBytes)
    : centerByte + aheadBytes
  for (
    let i = chunkIndexForByte(windowStart, chunkBytes);
    i <= chunkIndexForByte(windowEnd, chunkBytes);
    i++
  ) {
    out.add(i)
  }

  return out
}

// Tokens minted by THIS module's own crypto.randomBytes calls, currently
// backing a live session — the registry buildFfmpegArguments's guard checks
// against. Deliberately never satisfied by a bare shape/regex match alone:
// isOwnCacheUrl below requires the token to actually be registered here.
// This is the one boundary in this feature that touches the app's SSRF
// defense (see playback.ts's header comment) — a main-process-internal
// loopback handle StreamCache itself minted is a different trust boundary
// than the renderer-/TorBox-supplied strings that guard defends against,
// but the check still has to be for real, not just "looks like our URL."
const activeCacheTokens = new Set<string>()

const OWN_CACHE_URL_RE = /^http:\/\/127\.0\.0\.1:\d+\/stream\/([a-f0-9]{64})$/

export function isOwnCacheUrl(url: unknown): boolean {
  const match = OWN_CACHE_URL_RE.exec(String(url))
  return Boolean(match && activeCacheTokens.has(match[1]))
}

export interface StreamCacheStartResult {
  url: string
  totalBytes: number | null
  /** True when the configured cache size is large enough to eventually hold
   *  the whole file (cap is 0/unbounded, or >= totalBytes) — i.e. whether
   *  embedded-subtitle extraction will EVER become available for this
   *  title, regardless of whether the download has actually finished yet
   *  (see fullRetentionReady for that). The renderer uses this to grey out
   *  the "Embedded" subtitle menu upfront rather than only discovering it
   *  can't extract after the person has already clicked. */
  fullRetention: boolean
}

export interface StreamCache {
  start(
    remoteUrl: string,
    durationSeconds: number | undefined,
    maxBytes: number
  ): Promise<StreamCacheStartResult>
  /** Called before every ffmpeg restart (a seek/track/quality change) — proactively repositions the sequential fetch so the new position is ready by the time the restarted reader asks for it, instead of reacting only once the request itself lands. Best-effort/non-blocking by design. */
  seekHint(targetSeconds: number): void
  isOwnCacheUrl(url: string): boolean
  /** True once fullRetention mode (see start) has verified full byte-range coverage — the whole file is locally cached, so a single batched all-tracks subtitle extraction pass can run against it. */
  fullRetentionReady(): boolean
  /** Waits (bounded by timeoutMs) for fullRetentionReady() to become true, resolving true as soon as it does rather than only checking once. Resolves false immediately if this title was never in fullRetention mode to begin with. */
  waitForFullRetentionReady(timeoutMs: number): Promise<boolean>
  /** Aborts the fetch and closes the local server; chunk files stay on disk (see pruneIdleSessions for the actual cleanup backstop). */
  stop(): Promise<void>
  /** stop() + delete the session's chunk directory. */
  deleteSession(): Promise<void>
}

export interface CreateStreamCacheOptions {
  fetchImpl?: typeof fetch
  resolveHost?: (host: string) => Promise<string[]>
  randomBytesImpl?: typeof crypto.randomBytes
}

type ChunkStatus = 'pending' | 'ready' | 'failed'

interface ChunkWaiter {
  resolve: (status: ChunkStatus) => void
}

export function createStreamCache({
  fetchImpl = globalThis.fetch,
  resolveHost = defaultResolveHost,
  randomBytesImpl = crypto.randomBytes
}: CreateStreamCacheOptions = {}): StreamCache {
  let token = ''
  // Captured once per start() — see sessionDir/chunkFilePath's own comment
  // on why this isn't just re-read from settings on every file operation.
  let cacheRoot = ''
  let server: http.Server | null = null
  let origin = ''
  let remoteUrl = ''
  let durationSeconds: number | undefined
  let totalBytes: number | null = null
  let maxBytes = MIN_CACHE_BYTES
  let fullRetention = false
  let downloadComplete = false
  let behindSeconds = DEFAULT_BEHIND_SECONDS
  let aheadSeconds = DEFAULT_AHEAD_SECONDS
  // Bumped on every stop()/reposition — lets a superseded fill loop
  // recognize itself as stale instead of racing a newer one for the same
  // chunk files (same ordering trick as vlc.ts's createFfmpegTranscoder:
  // bumped BEFORE the abort, so the old loop's own catch block already
  // sees the new generation when it wakes up).
  let generation = 0
  let currentAbort: AbortController | null = null
  let fillFrontierByte = 0
  let highWatermarkByte = 0
  let diskCheckTimer: ReturnType<typeof setInterval> | undefined

  const chunks = new Map<number, ChunkStatus>()
  const waiters = new Map<number, ChunkWaiter[]>()
  // Resolved once fullRetentionReady() actually becomes true — see
  // waitForFullRetentionReady, which playbackExtractSubtitle uses instead
  // of failing immediately just because the whole file hasn't finished
  // caching yet.
  let fullRetentionWaiters: Array<() => void> = []

  function bytesPerSecond(): number | undefined {
    if (!durationSeconds || durationSeconds <= 0 || !totalBytes) return undefined
    return totalBytes / durationSeconds
  }

  // Whether EVERY chunk from byte 0 through totalBytes-1 is actually
  // 'ready' — not just "the most recent fill reached EOF". A seek that
  // aborts the initial front-to-back fill before it finishes, followed by
  // a later ranged fill that reaches EOF from its own (later) starting
  // point, must NOT be read as "the whole file is cached": the skipped
  // middle chunks are still missing. Only ever called right as a fill
  // reaches EOF (not per-chunk), so the O(chunk count) scan is fine.
  function hasFullCoverage(): boolean {
    if (totalBytes === null) return false
    const lastIndex = chunkIndexForByte(totalBytes - 1)
    for (let i = 0; i <= lastIndex; i++) {
      if (chunks.get(i) !== 'ready') return false
    }
    return true
  }

  function notifyFullRetentionReady(): void {
    if (!fullRetention || !downloadComplete) return
    const pending = fullRetentionWaiters
    fullRetentionWaiters = []
    for (const resolve of pending) resolve()
  }

  function byteForSeconds(seconds: number): number | undefined {
    const rate = bytesPerSecond()
    if (rate === undefined) return undefined
    return Math.max(0, Math.floor(seconds * rate))
  }

  function retainedChunkIndices(): Set<number> {
    return computeRetainedChunkIndices({
      presentChunkIndices: chunks.keys(),
      fullRetention,
      totalBytes,
      centerByte: highWatermarkByte,
      behindSeconds,
      aheadSeconds,
      bytesPerSecond: bytesPerSecond()
    })
  }

  async function evictOutsideRetained(): Promise<void> {
    if (fullRetention) return
    const retained = retainedChunkIndices()
    const toEvict: number[] = []
    for (const index of chunks.keys()) {
      if (!retained.has(index)) toEvict.push(index)
    }
    for (const index of toEvict) {
      chunks.delete(index)
      try {
        await fsp.unlink(chunkFilePath(cacheRoot, token, index))
      } catch {
        // Already gone, or never fully written — either way, nothing to clean up.
      }
    }
  }

  /**
   * Shrinks the ahead-window (never the pinned regions or the behind-window
   * — rewind capability is worth more than look-ahead depth) when either
   * the configured cap or actual free disk space is under pressure. Called
   * proactively so playback degrades to a smaller buffer instead of pausing.
   */
  async function squeezeForPressure(): Promise<void> {
    const residentBytes = chunks.size * CHUNK_BYTES
    let freeBytes = Number.POSITIVE_INFINITY
    try {
      const stat = await fsp.statfs(cacheRoot)
      freeBytes = stat.bavail * stat.bsize
    } catch {
      // statfs unsupported/unavailable on this platform — fall back to the
      // configured cap alone rather than blocking the feature entirely.
    }
    const lowOnDisk = freeBytes < DISK_SAFETY_MARGIN_BYTES
    // fullRetention (an unbounded/large-enough cap) means evictOutsideRetained
    // is normally a deliberate no-op — the whole point is to keep everything
    // for a later batched subtitle extraction. But that must never win over
    // actually running out of disk: with nothing ever evicted, a title
    // bigger than the free space left the fill downloading straight through
    // the safety margin with no way to reclaim space or even stop. Once
    // disk pressure hits, permanently drop out of fullRetention for this
    // session — the ordinary windowed retention below then evicts normally,
    // and fullRetentionReady() (fullRetention && downloadComplete) correctly
    // stops promising whole-file coverage, which this session can no longer
    // guarantee anyway.
    if (fullRetention && lowOnDisk) {
      fullRetention = false
      await evictOutsideRetained()
      return
    }
    const overCap = residentBytes > maxBytes
    if ((overCap || lowOnDisk) && aheadSeconds > 5) {
      // Never touched: pinned head/tail regions, or behindSeconds — rewind
      // capability is worth more than look-ahead depth, so ahead-window is
      // always the first (and only) thing shrunk under pressure. Resets to
      // the default on the next start() — this is a within-session
      // degrade, not a permanent regression.
      aheadSeconds = Math.max(5, Math.floor(aheadSeconds / 2))
      await evictOutsideRetained()
    }
  }

  function notifyWaiters(index: number, status: ChunkStatus): void {
    const list = waiters.get(index)
    if (!list) return
    waiters.delete(index)
    for (const w of list) w.resolve(status)
  }

  function markChunk(index: number, status: ChunkStatus): void {
    chunks.set(index, status)
    notifyWaiters(index, status)
  }

  // Deliberately generation-agnostic: a chunk index is a content-addressed
  // byte position, ready under any generation's fill loop is still exactly
  // the bytes a caller waiting on that index wants — which generation
  // produced it doesn't matter. (Superseded-fetch detection lives inside
  // runFill itself, not here.)
  async function waitForChunk(index: number): Promise<ChunkStatus> {
    const existing = chunks.get(index)
    if (existing === 'ready' || existing === 'failed') return existing
    return new Promise<ChunkStatus>((resolve) => {
      const timer = setTimeout(() => {
        const list = waiters.get(index)
        if (list) {
          const i = list.findIndex((w) => w.resolve === resolveOnce)
          if (i >= 0) list.splice(i, 1)
        }
        resolve('failed')
      }, CHUNK_WAIT_TIMEOUT_MS)
      const resolveOnce = (status: ChunkStatus): void => {
        clearTimeout(timer)
        resolve(status)
      }
      const list = waiters.get(index) ?? []
      list.push({ resolve: resolveOnce })
      waiters.set(index, list)
    })
  }

  // Takes root/tok explicitly rather than reading the shared cacheRoot/
  // token closure vars itself — see runFill's own comment on why: a
  // superseded generation's in-flight write must land in (or be skippable
  // against) whatever session WAS active when IT started, never whatever
  // start()/reposition() has since reassigned those shared vars to.
  async function writeChunk(root: string, tok: string, index: number, data: Buffer): Promise<void> {
    await fsp.mkdir(sessionDir(root, tok), { recursive: true })
    const finalPath = chunkFilePath(root, tok, index)
    const tmpPath = `${finalPath}.tmp`
    await fsp.writeFile(tmpPath, data)
    await fsp.rename(tmpPath, finalPath)
  }

  /** Sequentially downloads from startByte onward, one connection, until aborted (reposition/stop) or EOF. */
  async function runFill(startByte: number, myGeneration: number): Promise<void> {
    const controller = new AbortController()
    currentAbort = controller
    fillFrontierByte = startByte
    let index = chunkIndexForByte(startByte)
    // A mid-chunk start (a reposition landing inside an already-partially-
    // downloaded region) still re-fetches that whole chunk from its aligned
    // boundary — simpler than stitching partial chunk buffers, and the
    // redundant handful of KB is negligible against the connection saved.
    const alignedStart = index * CHUNK_BYTES
    // Captured once, right now — not re-read from the shared closure vars
    // at write time. abort() on generation change doesn't guarantee an
    // in-flight reader.read() rejects promptly: a stale read can resolve
    // with real data after start()/reposition() has already reassigned
    // token/cacheRoot/cleared chunks for a NEW session (flagged in review,
    // not something caught live — but a real race given read() isn't
    // rechecked against generation until it resolves). Every generation
    // check below re-verifies before touching shared state, and every
    // write uses THESE captured values so even a late-resolving stale
    // write can only ever land in the session it actually belongs to,
    // never silently corrupt whatever session is active by the time it
    // finally settles.
    const myToken = token
    const myCacheRoot = cacheRoot
    try {
      const headers: Record<string, string> = { Range: `bytes=${alignedStart}-` }
      const response = await fetchMediaWithRetry(
        remoteUrl,
        { headers, signal: controller.signal },
        fetchImpl,
        resolveHost
      )
      if (generation !== myGeneration) return
      if (!response.body) return
      const reader = response.body.getReader()
      let buffered = Buffer.alloc(0)
      let bytePos = alignedStart
      for (;;) {
        if (generation !== myGeneration) return
        const { done, value } = await reader.read()
        if (generation !== myGeneration) return
        if (done) {
          if (buffered.length > 0) {
            await writeChunk(myCacheRoot, myToken, index, buffered)
            if (generation !== myGeneration) return
            markChunk(index, 'ready')
          }
          if (hasFullCoverage()) {
            downloadComplete = true
            notifyFullRetentionReady()
          }
          return
        }
        buffered = Buffer.concat([buffered, Buffer.from(value)])
        bytePos += value.byteLength
        fillFrontierByte = bytePos
        while (buffered.length >= CHUNK_BYTES) {
          if (generation !== myGeneration) return
          const chunkData = buffered.subarray(0, CHUNK_BYTES)
          buffered = Buffer.from(buffered.subarray(CHUNK_BYTES))
          await writeChunk(myCacheRoot, myToken, index, chunkData)
          if (generation !== myGeneration) return
          markChunk(index, 'ready')
          await evictOutsideRetained()
          await squeezeForPressure()
          index += 1
        }
      }
    } catch (error) {
      if (generation !== myGeneration) return
      if ((error as { name?: string } | undefined)?.name === 'AbortError') return
      logError('streamCache:fill', error)
      markChunk(index, 'failed')
    }
  }

  /** Aborts whatever fetch is running, waits the TorBox teardown grace delay, then starts a fresh fill at targetByte. */
  async function reposition(targetByte: number): Promise<void> {
    const myGeneration = ++generation
    const hadOpenFetch = Boolean(currentAbort)
    currentAbort?.abort()
    currentAbort = null
    if (hadOpenFetch) await new Promise((resolve) => setTimeout(resolve, RECONNECT_GRACE_MS))
    if (generation !== myGeneration) return
    void runFill(targetByte, myGeneration)
  }

  function isNearFillFrontier(byte: number): boolean {
    return byte >= fillFrontierByte - CHUNK_BYTES && byte <= fillFrontierByte + REPOSITION_THRESHOLD_BYTES
  }

  async function fetchTotalBytes(): Promise<number | null> {
    try {
      const head = await fetchMediaWithRetry(remoteUrl, { method: 'HEAD' }, fetchImpl, resolveHost)
      const len = head.headers.get('content-length')
      if (len) return Number(len)
    } catch {
      // Some hosts reject HEAD — fall through to a tiny ranged GET below.
    }
    try {
      const ranged = await fetchMediaWithRetry(
        remoteUrl,
        { headers: { Range: 'bytes=0-0' } },
        fetchImpl,
        resolveHost
      )
      const contentRange = ranged.headers.get('content-range')
      const match = /\/(\d+)$/.exec(contentRange ?? '')
      if (match) return Number(match[1])
    } catch (error) {
      logError('streamCache:fetchTotalBytes', error)
    }
    return null
  }

  // Not generation-gated: a reposition this SAME request triggers (to fetch
  // the bytes it itself needs) must not look like this request being
  // superseded — only the client actually disconnecting (aborted.flag,
  // e.g. ffmpeg getting killed as part of a restart, or the <video>
  // element aborting its own pending request on a seek) ends this loop.
  async function serveRange(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rangeHeader = String(req.headers.range || '')
    const rangeMatch = /bytes=(\d+)-/.exec(rangeHeader)
    const startByte = rangeMatch ? Number(rangeMatch[1]) : 0

    if (!chunks.has(chunkIndexForByte(startByte)) && !isNearFillFrontier(startByte)) {
      await reposition(chunkIndexForByte(startByte) * CHUNK_BYTES)
    }

    const totalLabel = totalBytes !== null ? String(totalBytes) : '*'
    res.writeHead(totalBytes !== null ? 206 : 200, {
      'content-type': 'application/octet-stream',
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'content-range': `bytes ${startByte}-${totalBytes !== null ? totalBytes - 1 : ''}/${totalLabel}`
    })

    let bytePos = startByte
    const aborted = { flag: false }
    req.on('close', () => {
      aborted.flag = true
    })
    while (!aborted.flag) {
      highWatermarkByte = Math.max(highWatermarkByte, bytePos)
      const index = chunkIndexForByte(bytePos)
      if (totalBytes !== null && bytePos >= totalBytes) {
        res.end()
        return
      }
      let status = chunks.get(index)
      if (status === undefined) {
        if (!isNearFillFrontier(bytePos)) await reposition(index * CHUNK_BYTES)
        status = await waitForChunk(index)
      } else if (status === 'pending') {
        status = await waitForChunk(index)
      }
      if (aborted.flag) {
        res.end()
        return
      }
      if (status !== 'ready') {
        // Genuinely stuck (fetch failing repeatedly for this region) —
        // surface as a real error rather than hanging the client forever.
        if (!res.headersSent) res.writeHead(502, { 'cache-control': 'no-store' })
        res.end()
        return
      }
      const chunkStartByte = index * CHUNK_BYTES
      const offsetInChunk = bytePos - chunkStartByte
      let data: Buffer
      try {
        data = await fsp.readFile(chunkFilePath(cacheRoot, token, index))
      } catch (error) {
        logError('streamCache:readChunk', error)
        if (!res.headersSent) res.writeHead(502, { 'cache-control': 'no-store' })
        res.end()
        return
      }
      const slice = offsetInChunk > 0 ? data.subarray(offsetInChunk) : data
      const canContinue = res.write(slice)
      bytePos = chunkStartByte + data.length
      if (!canContinue) {
        await new Promise<void>((resolve) => res.once('drain', () => resolve()))
      }
    }
    res.end()
  }

  async function listen(): Promise<void> {
    if (server) return
    server = http.createServer((req, res) => {
      const match = /^\/stream\/([a-f0-9]{64})$/.exec(new URL(req.url ?? '', 'http://127.0.0.1').pathname)
      if (!match || match[1] !== token || !['GET', 'HEAD'].includes(req.method ?? '')) {
        res.writeHead(404, { 'cache-control': 'no-store' })
        res.end()
        return
      }
      if (req.method === 'HEAD') {
        res.writeHead(totalBytes !== null ? 200 : 204, {
          'accept-ranges': 'bytes',
          ...(totalBytes !== null ? { 'content-length': String(totalBytes) } : {})
        })
        res.end()
        return
      }
      serveRange(req, res).catch((error) => {
        logError('streamCache:serve', error)
        if (!res.headersSent) res.writeHead(502, { 'cache-control': 'no-store' })
        res.end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      const activeServer = server as http.Server
      activeServer.once('error', reject)
      activeServer.listen(0, '127.0.0.1', () => {
        activeServer.off('error', reject)
        const address = activeServer.address()
        const port = typeof address === 'object' && address ? address.port : 0
        origin = `http://127.0.0.1:${port}`
        resolve()
      })
    })
  }

  async function start(
    inputRemoteUrl: string,
    inputDurationSeconds: number | undefined,
    inputMaxBytes: number
  ): Promise<StreamCacheStartResult> {
    await assertPublicMediaUrl(inputRemoteUrl, resolveHost)
    await stopInternal(false)
    token = randomBytesImpl(32).toString('hex')
    activeCacheTokens.add(token)
    // Captured once here, not re-read per file operation — see
    // sessionDir/chunkFilePath's own comment.
    cacheRoot = cacheRootDir()
    remoteUrl = inputRemoteUrl
    durationSeconds = inputDurationSeconds
    // 0 from the settings UI means "unbounded/drive-limited" — represented
    // as Infinity here (not clamped to the floor) so squeezeForPressure's
    // cap comparison and the fullRetention check below both read naturally;
    // only actual free-disk-space pressure ever squeezes an unbounded cache.
    maxBytes = inputMaxBytes === 0 ? Number.POSITIVE_INFINITY : Math.max(MIN_CACHE_BYTES, inputMaxBytes)
    downloadComplete = false
    behindSeconds = DEFAULT_BEHIND_SECONDS
    aheadSeconds = DEFAULT_AHEAD_SECONDS
    fillFrontierByte = 0
    highWatermarkByte = 0
    chunks.clear()
    waiters.clear()

    await listen()
    totalBytes = await fetchTotalBytes()
    fullRetention = totalBytes !== null && maxBytes >= totalBytes

    const myGeneration = ++generation
    void runFill(0, myGeneration)
    // Wait for at least the first chunk so the very first read from ffmpeg/
    // the <video> element doesn't land on nothing — mirrors the readiness
    // gate createFfmpegTranscoder already uses before its own start()
    // resolves (vlc.ts's READY_BYTES/MIN_BUFFER_MS).
    await waitForChunk(0)

    if (diskCheckTimer) clearInterval(diskCheckTimer)
    diskCheckTimer = setInterval(() => {
      void squeezeForPressure()
    }, DISK_CHECK_INTERVAL_MS)

    return { url: `${origin}/stream/${token}`, totalBytes, fullRetention }
  }

  function seekHint(targetSeconds: number): void {
    const targetByte = byteForSeconds(targetSeconds)
    if (targetByte === undefined) return
    // Move the retention window's center to the intended new playhead
    // RIGHT NOW, synchronously — not only once ffmpeg's restarted process
    // eventually issues a request that lands in serveRange. Without this,
    // chunks runFill downloads at the new target get deleted by
    // evictOutsideRetained() (still centered on the OLD position, since
    // nothing told it the playhead is about to move) almost as fast as
    // they're written. Found live: seeking forward played video but lost
    // audio — video kept retrying its way to a chunk that survived just
    // long enough, audio apparently didn't. Deliberately NOT done inside
    // reposition() itself: that function also runs for incidental
    // out-of-window reads (e.g. ffmpeg jumping to read Matroska Cues near
    // EOF for its OWN seek-index purposes) that are not the real playhead
    // and must not drag the retention window away from it.
    highWatermarkByte = targetByte
    if (chunks.get(chunkIndexForByte(targetByte)) === 'ready') return
    if (isNearFillFrontier(targetByte)) return
    void reposition(chunkIndexForByte(targetByte) * CHUNK_BYTES)
  }

  function fullRetentionReady(): boolean {
    return fullRetention && downloadComplete
  }

  /**
   * Waits for fullRetentionReady() to become true, up to timeoutMs, instead
   * of the caller failing immediately just because the whole file hasn't
   * finished caching yet. playbackExtractSubtitle uses this rather than
   * checking fullRetentionReady() once and giving up — the renderer already
   * shows a real "Extracting… this can take a while" busy state for the
   * whole duration of that call, so waiting here (bounded) turns what used
   * to be an immediate, misleading "no subtitle data was found" error into
   * the same wait the person already expects, or a real failure only if
   * caching genuinely never finishes (a small/capped cache, or a title too
   * big to ever qualify for fullRetention at all).
   */
  function waitForFullRetentionReady(timeoutMs: number): Promise<boolean> {
    if (fullRetentionReady()) return Promise.resolve(true)
    if (!fullRetention) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const i = fullRetentionWaiters.indexOf(resolveOnce)
        if (i >= 0) fullRetentionWaiters.splice(i, 1)
        resolve(fullRetentionReady())
      }, timeoutMs)
      const resolveOnce = (): void => {
        clearTimeout(timer)
        resolve(true)
      }
      fullRetentionWaiters.push(resolveOnce)
    })
  }

  async function stopInternal(closeServer: boolean): Promise<void> {
    generation += 1
    currentAbort?.abort()
    currentAbort = null
    if (diskCheckTimer) {
      clearInterval(diskCheckTimer)
      diskCheckTimer = undefined
    }
    // Nobody waiting on THIS (now-ending) session's full-retention state
    // should hang until their own timeout — resolve them now, one way or
    // the other, same as any other teardown.
    if (fullRetentionWaiters.length) {
      const pending = fullRetentionWaiters
      fullRetentionWaiters = []
      for (const resolve of pending) resolve()
    }
    if (token) activeCacheTokens.delete(token)
    if (closeServer && server) {
      const active = server
      server = null
      origin = ''
      await new Promise<void>((resolve) => active.close(() => resolve()))
    }
  }

  async function stop(): Promise<void> {
    await stopInternal(true)
  }

  async function deleteSession(): Promise<void> {
    const dir = token ? sessionDir(cacheRoot, token) : ''
    await stop()
    if (dir) {
      try {
        await fsp.rm(dir, { recursive: true, force: true })
      } catch (error) {
        logError('streamCache:deleteSession', error)
      }
    }
  }

  return {
    start,
    seekHint,
    isOwnCacheUrl,
    fullRetentionReady,
    waitForFullRetentionReady,
    stop,
    deleteSession
  }
}

/**
 * Startup + hourly disk-hygiene backstop, independent of the watched-flag
 * deletion in playbackSession.ts's stopPlayback — a title that was closed
 * before being marked watched deliberately keeps its cache around (useful
 * for a near-term resume), but can't be kept forever. 24h is a pragmatic
 * default (this app doesn't currently model real TorBox link-expiry), not
 * a derived constraint — safe to retune later.
 */
export async function pruneIdleSessions(maxAgeMs = 24 * 60 * 60 * 1000): Promise<void> {
  const root = cacheRootDir()
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  const cutoff = Date.now() - maxAgeMs
  for (const entry of entries) {
    if (!entry.isDirectory() || activeCacheTokens.has(entry.name)) continue
    const dir = path.join(root, entry.name)
    try {
      const files = await fsp.readdir(dir)
      let newestMtime = 0
      for (const file of files) {
        const stat = await fsp.stat(path.join(dir, file))
        newestMtime = Math.max(newestMtime, stat.mtimeMs)
      }
      if (newestMtime === 0 || newestMtime < cutoff) {
        await fsp.rm(dir, { recursive: true, force: true })
      }
    } catch (error) {
      logError('streamCache:pruneIdleSessions', error)
    }
  }
}

/**
 * Manual "Clear cache" button backing (see playbackSession.ts's
 * streamCacheClear handler) — deletes every session directory under the
 * CURRENT streamCacheDir setting except whichever one (if any) is actively
 * playing right now, regardless of age (unlike pruneIdleSessions' 24h
 * threshold). Reads cacheRootDir() fresh rather than any single instance's
 * captured `cacheRoot`, since this is meant to act on wherever the person
 * has the cache configured RIGHT NOW — if they just changed the folder,
 * this clears the NEW location, not a stale one. Clearing the OLD location
 * after switching folders is not handled here; nothing in this app tracks
 * where a stream cache used to live once the setting has moved on.
 */
export async function clearAllSessions(): Promise<number> {
  const root = cacheRootDir()
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return 0
  }
  let freedBytes = 0
  for (const entry of entries) {
    if (!entry.isDirectory() || activeCacheTokens.has(entry.name)) continue
    const dir = path.join(root, entry.name)
    try {
      const files = await fsp.readdir(dir)
      for (const file of files) {
        try {
          freedBytes += (await fsp.stat(path.join(dir, file))).size
        } catch {
          // Already gone — nothing to count.
        }
      }
      await fsp.rm(dir, { recursive: true, force: true })
    } catch (error) {
      logError('streamCache:clearAllSessions', error)
    }
  }
  return freedBytes
}
