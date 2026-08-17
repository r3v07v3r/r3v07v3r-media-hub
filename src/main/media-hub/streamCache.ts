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
// every position currently being READ.
//
// "Every position being read", not one global high-water mark. That
// high-water mark was a real, reproduced bug: it only ever moved FORWARD
// (Math.max), so the single incidental tail read every MKV demux does —
// ffmpeg (or Chromium) jumping to the Cues/SeekHead near EOF before
// playback even starts — permanently pinned the retention centre at the
// end of the file. From then on evictOutsideRetained() deleted chunks
// around the actual playhead as fast as the fill wrote them, so a title
// played for as long as the pinned 16MB head lasted (a few seconds) and
// then died: the reader's next chunk was gone, the fill kept re-fetching
// and losing it, and the local server eventually answered 502 mid-body —
// which the <video> element reports as a fatal error. Retaining a window
// around each LIVE reader instead means the position actually being played
// is never the one evicted, no matter what else reads the file.

import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { app } from 'electron'

import { assertPublicMediaUrl, defaultResolveHost, fetchMediaWithRetry } from './playback'
import { logError } from './logger'
import { formatMegabytes, reportPreparation } from './playbackProgress'
import { readSettings } from './settingsStore'
import type { CacheSessionMeta, StreamCacheEntry } from '../../shared/media-hub/types'

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
/** How much one connection must have actually streamed before its position
 *  is trusted as the fallback retention centre for when no reader is live
 *  at all. A container-metadata probe (MKV Cues near EOF, an MP4 moov)
 *  reads a few MB and disconnects; real playback streams continuously —
 *  this is what tells them apart, and it's why the old forward-only
 *  high-water mark (see the module header) can no longer be dragged to the
 *  end of the file by a probe. */
const PLAYHEAD_MIN_SERVED_BYTES = CHUNK_BYTES * 2
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
  const base =
    typeof configured === 'string' && configured.trim() ? configured : app.getPath('userData')
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

function metaFilePath(root: string, token: string): string {
  return path.join(sessionDir(root, token), 'meta.json')
}

interface StoredMeta extends CacheSessionMeta {
  totalBytes: number | null
  createdAt: number
}

/**
 * Identity of the CONTENT a cache session holds, as opposed to the session.
 *
 * The remote link cannot be the key: TorBox mints a fresh, expiring
 * `requestdl` URL every play, so the same film has a different URL every time.
 * The catalog id (plus season/episode for an episode) is stable, which is what
 * makes reuse possible at all. Title is the fallback for a session written
 * before a catalog id was recorded.
 */
export function cacheContentKey(meta: CacheSessionMeta | undefined): string {
  if (!meta) return ''
  const id = String(meta.catalogId || meta.title || '')
    .trim()
    .toLowerCase()
  if (!id) return ''
  return `${id}:${meta.seasonNumber ?? ''}:${meta.episodeNumber ?? ''}`
}

/**
 * Finds an existing session on disk holding the same content, so a replay
 * continues the download instead of starting a second copy.
 *
 * The bar for adopting one is deliberately high, because the failure mode of
 * getting it wrong is silent corruption — playing one film's bytes believing
 * they are another's. Two independent things must agree: the content key, and
 * the exact total byte length of the remote file. A different release of the
 * same title has a different length and is correctly rejected.
 *
 * Returns the session's directory name (its token), or '' when nothing matches.
 */
export async function findReusableSession(
  root: string,
  meta: CacheSessionMeta | undefined,
  remoteTotalBytes: number | null,
  excludeToken = ''
): Promise<string> {
  const key = cacheContentKey(meta)
  if (!key || remoteTotalBytes === null) return ''
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return ''
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !SESSION_TOKEN_RE.test(entry.name)) continue
    if (entry.name === excludeToken) continue
    try {
      const stored = JSON.parse(
        await fsp.readFile(metaFilePath(root, entry.name), 'utf8')
      ) as StoredMeta
      if (stored.totalBytes !== remoteTotalBytes) continue
      if (cacheContentKey(stored) !== key) continue
      return entry.name
    } catch {
      // A session without readable meta cannot be identified, so it is not a
      // candidate. It stays on disk for pruneIdleSessions to deal with.
    }
  }
  return ''
}

export function chunkIndexForByte(byte: number, chunkBytes = CHUNK_BYTES): number {
  return Math.floor(byte / chunkBytes)
}

export interface RetentionParams {
  /** Every chunk index currently on disk — in fullRetention mode nothing is ever evicted, so the retained set is just this, verbatim. */
  presentChunkIndices: Iterable<number>
  fullRetention: boolean
  totalBytes: number | null
  /** Every position currently being read, in bytes — one per live reader,
   *  plus the last known playhead as a fallback centre (see the module
   *  header on why this is a set of positions and not one forward-only
   *  high-water mark). Each gets its own behind/ahead window; the retained
   *  set is their union with the pinned head/tail regions. */
  centerBytes: number[]
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
    centerBytes,
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
  // One window per centre, unioned. Two readers (e.g. the <video> element
  // playing while ffmpeg's demuxer probes elsewhere in the container) are
  // both real positions someone is waiting on — keeping only one of them
  // means the other's next chunk is evicted out from under it.
  for (const centerByte of centerBytes) {
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

// Same shape as the tokens minted above (crypto.randomBytes(32).toString
// ('hex')) — pruneIdleSessions/clearAllSessions both walk whatever
// directory the person has streamCacheDir pointed at, which (per the
// folder picker's own validation) can be ANY writable directory of their
// choosing, not necessarily one this app created from scratch. Without
// this check, a chosen folder that happens to already contain its own
// unrelated 'stream-cache' subfolder (someone else's data, a leftover
// from something else entirely) would have every child directory treated
// as a deletable session. Only ever touch entries that are actually
// shaped like a token this module would have minted.
const SESSION_TOKEN_RE = /^[a-f0-9]{64}$/

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
    maxBytes: number,
    meta?: CacheSessionMeta
  ): Promise<StreamCacheStartResult>
  /** Bare hex token of whatever session is currently loaded ('' when none) — lets the Downloads page's list/delete IPC handlers tell the live session apart from idle ones on disk (see listCacheSessions/deleteCacheSession below). */
  getActiveToken(): string
  /**
   * Supplies the media duration after start(), which is what the retention
   * window needs to convert its behind/ahead *seconds* into bytes.
   *
   * This exists because the duration now arrives later than it used to. ffprobe
   * ran against the remote link BEFORE the cache opened, so start() already had
   * a duration; mpv only reports one once it has opened the file, which is
   * after. Until this is called, bytesPerSecond() returns undefined and
   * computeRetainedChunkIndices falls back to its fixed chunk-count window
   * (see its `bytesPerSecond !== undefined` branches) — correct, just less
   * precisely sized, and only for the second or two before the file loads.
   *
   * Ignores anything that isn't a real positive number, so a live stream (mpv
   * reports no duration at all) simply leaves the fallback in place.
   */
  setDuration(durationSeconds: number | undefined): void
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
  // Where each live reader of the local server currently is, keyed by a
  // per-connection id (see serveRange). Every one of these is a retention
  // centre for as long as that connection is open, and the entry is
  // removed the moment it closes — which is what keeps an incidental
  // metadata probe from having any lasting effect on what's retained.
  const readerPositions = new Map<number, number>()
  let readerSequence = 0
  // Resolved once fullRetentionReady() actually becomes true (ready=true)
  // OR once it's known that it never will for this session — torn down
  // (a title change/stop) or downgraded out of fullRetention by disk
  // pressure (ready=false in both cases) — see waitForFullRetentionReady,
  // which playbackExtractSubtitle uses instead of failing immediately just
  // because the whole file hasn't finished caching yet. The bool param
  // matters: resolving every pending waiter as if it were a genuine
  // success, even during teardown, would let playbackExtractSubtitle
  // proceed against a session that's already gone or been replaced.
  let fullRetentionWaiters: Array<(ready: boolean) => void> = []

  /** The one place any of these waiters are ever resolved — keeps every call site honest about which outcome it's actually reporting. */
  function settleFullRetentionWaiters(ready: boolean): void {
    if (!fullRetentionWaiters.length) return
    const pending = fullRetentionWaiters
    fullRetentionWaiters = []
    for (const resolve of pending) resolve(ready)
  }

  function bytesPerSecond(): number | undefined {
    if (!durationSeconds || durationSeconds <= 0 || !totalBytes) return undefined
    return totalBytes / durationSeconds
  }

  // Lowest chunk index in [0, totalBytes) that ISN'T 'ready' yet, or null
  // if totalBytes is unknown or every chunk in range already is. Only ever
  // called right as a fill reaches EOF (not per-chunk), so the O(chunk
  // count) scan is fine. Shared by hasFullCoverage (is there a gap at
  // all) and runFill's own post-EOF continuation (where is the gap, so it
  // can be filled instead of left behind).
  function firstMissingChunkIndex(): number | null {
    if (totalBytes === null) return null
    const lastIndex = chunkIndexForByte(totalBytes - 1)
    for (let i = 0; i <= lastIndex; i++) {
      if (chunks.get(i) !== 'ready') return i
    }
    return null
  }

  // Whether EVERY chunk from byte 0 through totalBytes-1 is actually
  // 'ready' — not just "the most recent fill reached EOF". A seek that
  // aborts the initial front-to-back fill before it finishes, followed by
  // a later ranged fill that reaches EOF from its own (later) starting
  // point, must NOT be read as "the whole file is cached": the skipped
  // middle chunks are still missing.
  function hasFullCoverage(): boolean {
    return totalBytes !== null && firstMissingChunkIndex() === null
  }

  function notifyFullRetentionReady(): void {
    if (!fullRetention || !downloadComplete) return
    settleFullRetentionWaiters(true)
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
      // highWatermarkByte is always a centre, not just a fallback for when
      // nothing is reading: seekHint() writes the intended NEW playhead
      // there while the OLD ffmpeg process is still connected and reading
      // the old position (the restart kills it moments later). Both have
      // to be retained across that handover, or the chunks being fetched
      // for the seek target are evicted before the restarted reader ever
      // asks for them — the exact failure seekHint itself exists to fix.
      centerBytes: [highWatermarkByte, ...readerPositions.values()],
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
      // Readiness is now provably impossible for this session — anyone
      // already waiting in waitForFullRetentionReady must find out right
      // now, not sit until their own (up to 20-minute) timeout expires
      // when the outcome is already known.
      settleFullRetentionWaiters(false)
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

  /**
   * Marks every chunk already on disk for the current session as ready.
   *
   * Only a file of exactly the expected size counts. A short chunk is a
   * half-written file from a session that was killed mid-write, and trusting it
   * would serve a hole in the middle of the film; leaving it unmarked means the
   * fill simply overwrites it. The final chunk is legitimately short, so its
   * expected size is computed from totalBytes rather than assumed.
   */
  async function adoptExistingChunks(): Promise<void> {
    if (totalBytes === null) return
    const lastIndex = chunkIndexForByte(totalBytes - 1)
    let files: string[]
    try {
      files = await fsp.readdir(sessionDir(cacheRoot, token))
    } catch {
      return
    }
    let adopted = 0
    for (const file of files) {
      const match = /^chunk-(\d+)\.bin$/.exec(file)
      if (!match) continue
      const index = Number(match[1])
      if (!Number.isInteger(index) || index < 0 || index > lastIndex) continue
      const expected = index === lastIndex ? totalBytes - index * CHUNK_BYTES : CHUNK_BYTES
      try {
        const stat = await fsp.stat(chunkFilePath(cacheRoot, token, index))
        if (stat.size !== expected) continue
      } catch {
        continue
      }
      chunks.set(index, 'ready')
      adopted += 1
    }
    if (adopted > 0) {
      reportPreparation(
        'buffer',
        `Reusing ${formatMegabytes(adopted * CHUNK_BYTES)} already downloaded`
      )
    }
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
            return
          }
          // Reached EOF without full coverage — a seek aborted the
          // original front-to-back fill before it got here, so an earlier
          // range is still missing (that's exactly what hasFullCoverage
          // caught). Only worth chasing down in fullRetention mode: that's
          // the only case anything (whole-file subtitle extraction) is
          // actually waiting on full coverage ever being reached — for an
          // ordinary windowed cache, gaps outside the retention window are
          // intentional (evicted), not a bug to fix. Continuing under the
          // SAME generation (not through reposition(), which exists for
          // the abort-then-reconnect case — this fetch just completed
          // cleanly, nothing to wait out) means one more contiguous read
          // from the gap through EOF, which covers every later gap too
          // since a fill is sequential once started. If another seek
          // interrupts this pass, its own reposition() bumps generation
          // and this continuation naturally stops at the next check, same
          // as any other superseded fill.
          if (fullRetention) {
            const gapIndex = firstMissingChunkIndex()
            if (gapIndex !== null) {
              void runFill(gapIndex * CHUNK_BYTES, myGeneration)
            }
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
    return (
      byte >= fillFrontierByte - CHUNK_BYTES &&
      byte <= fillFrontierByte + REPOSITION_THRESHOLD_BYTES
    )
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
    let servedBytes = 0
    /** Which chunk index this connection has already re-fetched once after a
     *  failed read — see the readFile catch below. */
    let retriedIndex = -1
    const readerId = ++readerSequence
    const aborted = { flag: false }
    req.on('close', () => {
      aborted.flag = true
      // Dropped from the retention centres immediately, not only when the
      // loop below next wakes up — it can be parked in a 20s waitForChunk,
      // and a closed connection's position must not keep chunks pinned
      // (or, worse, keep dragging the window away from a live reader).
      readerPositions.delete(readerId)
    })
    try {
      while (!aborted.flag) {
        // This connection's own window, kept alive for exactly as long as
        // it is — see retainedChunkIndices.
        readerPositions.set(readerId, bytePos)
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
        if (status === 'failed' && !aborted.flag) {
          // A 'failed' mark is sticky (waitForChunk returns it instantly),
          // so a single transient upstream error — one dropped connection,
          // one 20s wait that just missed — used to poison that byte range
          // for the rest of the session: every later read of it hard-failed
          // the stream even though a retry would have succeeded. Clear the
          // mark and genuinely refetch once before giving up.
          chunks.delete(index)
          await reposition(index * CHUNK_BYTES)
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
          // This chunk was 'ready' a moment ago, so the file went away
          // under us — an eviction landing between the check and the read.
          // Refetching once is far better than failing the stream: a 502
          // here is fatal to the <video> element, and the bytes are
          // trivially re-obtainable. Bounded to one retry per position so a
          // genuinely unreadable cache still fails instead of spinning.
          if (retriedIndex !== index) {
            retriedIndex = index
            chunks.delete(index)
            await reposition(index * CHUNK_BYTES)
            continue
          }
          if (!res.headersSent) res.writeHead(502, { 'cache-control': 'no-store' })
          res.end()
          return
        }
        const slice = offsetInChunk > 0 ? data.subarray(offsetInChunk) : data
        const canContinue = res.write(slice)
        bytePos = chunkStartByte + data.length
        servedBytes += slice.length
        // The fallback centre for when nothing is reading at all (between
        // an ffmpeg restart's kill and reconnect, or between two of
        // Chromium's own connections). Only adopted from a connection that
        // has actually streamed a real amount, so a container-metadata
        // probe — which reads a few MB near EOF and disconnects — can't
        // leave the retention centre stranded at the end of the file the
        // way the old forward-only high-water mark did.
        if (servedBytes >= PLAYHEAD_MIN_SERVED_BYTES) highWatermarkByte = bytePos
        if (!canContinue) {
          await new Promise<void>((resolve) => res.once('drain', () => resolve()))
        }
      }
      res.end()
    } finally {
      readerPositions.delete(readerId)
    }
  }

  async function listen(): Promise<void> {
    if (server) return
    server = http.createServer((req, res) => {
      const match = /^\/stream\/([a-f0-9]{64})$/.exec(
        new URL(req.url ?? '', 'http://127.0.0.1').pathname
      )
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

  // Takes root/tok explicitly, same reasoning as writeChunk above — called
  // fire-and-forget from start() right after cacheRoot/token are assigned
  // for the new session, so a late-resolving call from a superseded
  // generation must still only ever touch the session it was minted for.
  async function writeMeta(
    meta: CacheSessionMeta | undefined,
    root: string,
    forToken: string
  ): Promise<void> {
    if (!meta) return
    try {
      await fsp.mkdir(sessionDir(root, forToken), { recursive: true })
      const stored: StoredMeta = { ...meta, totalBytes, createdAt: Date.now() }
      await fsp.writeFile(metaFilePath(root, forToken), JSON.stringify(stored))
    } catch (error) {
      logError('streamCache:writeMeta', error)
    }
  }

  async function start(
    inputRemoteUrl: string,
    inputDurationSeconds: number | undefined,
    inputMaxBytes: number,
    meta?: CacheSessionMeta
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
    maxBytes =
      inputMaxBytes === 0 ? Number.POSITIVE_INFINITY : Math.max(MIN_CACHE_BYTES, inputMaxBytes)
    downloadComplete = false
    behindSeconds = DEFAULT_BEHIND_SECONDS
    aheadSeconds = DEFAULT_AHEAD_SECONDS
    fillFrontierByte = 0
    highWatermarkByte = 0
    chunks.clear()
    waiters.clear()
    readerPositions.clear()

    await listen()
    reportPreparation('connect', 'Connecting to the source')
    totalBytes = await fetchTotalBytes()

    // REUSE AN EXISTING CACHE FOR THIS CONTENT, if there is one.
    //
    // Without this, replaying a title downloaded a second full copy while the
    // first sat on disk beside it. stopPlayback deliberately KEEPS the cache
    // for "a likely near-term resume", and the Downloads page lists it, but
    // nothing ever read it back — the retention had no consumer.
    //
    // Adoption is gated on two independent things agreeing (see
    // findReusableSession): the content key, and the exact total byte length of
    // the remote file. Length is what makes this safe rather than merely
    // convenient — a different release of the same title is a different length
    // and is rejected, so the cache cannot be crossed with the wrong bytes.
    const reusableToken = await findReusableSession(cacheRoot, meta, totalBytes, token)
    if (reusableToken) {
      activeCacheTokens.delete(token)
      token = reusableToken
      activeCacheTokens.add(token)
      await adoptExistingChunks()
    }

    fullRetention = totalBytes !== null && maxBytes >= totalBytes
    void writeMeta(meta, cacheRoot, token)

    const myGeneration = ++generation
    // Start at the first byte NOT already on disk. The fill is sequential from
    // there, and the existing gap-chase (see runFill's fullRetention branch)
    // picks up anything further along, so a resumed title downloads only what
    // it is missing.
    const firstGap = firstMissingChunkIndex()
    void runFill(firstGap === null ? 0 : firstGap * CHUNK_BYTES, myGeneration)
    // Wait for at least the first chunk so the very first read from ffmpeg/
    // the <video> element doesn't land on nothing — mirrors the readiness
    // gate createFfmpegTranscoder already uses before its own start()
    // resolves (vlc.ts's READY_BYTES/MIN_BUFFER_MS).
    //
    // On a slow link that first 4MB is a real wait with nothing else to
    // show for it, so it's reported as it fills (fillFrontierByte is the
    // live download position) rather than as one silent pause.
    const firstChunk = waitForChunk(0)
    const fillTicker = setInterval(() => {
      reportPreparation(
        'buffer',
        `Downloading the start of the file — ${formatMegabytes(Math.min(fillFrontierByte, CHUNK_BYTES))} of ${formatMegabytes(CHUNK_BYTES)}`
      )
    }, 700)
    fillTicker.unref?.()
    try {
      await firstChunk
    } finally {
      clearInterval(fillTicker)
    }

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
        const i = fullRetentionWaiters.indexOf(resolveWith)
        if (i >= 0) fullRetentionWaiters.splice(i, 1)
        resolve(fullRetentionReady())
      }, timeoutMs)
      // `ready` here is exactly what settleFullRetentionWaiters passed —
      // true only from notifyFullRetentionReady's genuine success path;
      // false from teardown (title changed/stopped) or a disk-pressure
      // downgrade out of fullRetention, both of which mean this session
      // will never become ready and the caller must not proceed as if it
      // had (see settleFullRetentionWaiters' own comment).
      const resolveWith = (ready: boolean): void => {
        clearTimeout(timer)
        resolve(ready)
      }
      fullRetentionWaiters.push(resolveWith)
    })
  }

  async function stopInternal(closeServer: boolean): Promise<void> {
    generation += 1
    currentAbort?.abort()
    currentAbort = null
    // This session's readers are no longer anything to retain around —
    // whatever is still draining belongs to a session that's ending.
    readerPositions.clear()
    if (diskCheckTimer) {
      clearInterval(diskCheckTimer)
      diskCheckTimer = undefined
    }
    // Nobody waiting on THIS (now-ending) session's full-retention state
    // should hang until their own timeout — and it must resolve as NOT
    // ready: the session this waiter cares about is gone (title changed)
    // or about to be (stop()), so proceeding as if it had actually
    // finished caching would mean extracting against activeCacheUrl/track
    // state that's already been cleared or replaced by the next title.
    settleFullRetentionWaiters(false)
    if (token) activeCacheTokens.delete(token)
    // Cleared here, not just removed from activeCacheTokens above —
    // getActiveToken() otherwise kept reporting this now-stopped session as
    // the active one forever (until the next start() happened to overwrite
    // it), which made listCacheSessions() mislabel a title that was merely
    // closed-but-kept-for-resume as "Playing now" and made the Downloads
    // page's delete handler refuse to delete it. Safe to clear
    // unconditionally: start()'s own stopInternal(false) call immediately
    // reassigns token on the very next line, so this is never observably
    // empty there — only a real stop()/deleteSession() (closeServer: true,
    // no follow-up start()) leaves it cleared.
    token = ''
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
    getActiveToken: () => token,
    setDuration: (value: number | undefined) => {
      const seconds = Number(value)
      if (Number.isFinite(seconds) && seconds > 0) durationSeconds = seconds
    },
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
    if (!entry.isDirectory() || !SESSION_TOKEN_RE.test(entry.name)) continue
    if (activeCacheTokens.has(entry.name)) continue
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
 * Powers the Downloads page's "Cached Streams" list. Only directories with
 * a readable `meta.json` are included — sessions started before this
 * feature existed have none and are left for pruneIdleSessions' existing
 * 24h backstop to clean up rather than showing up as unlabeled entries.
 * Reads cacheRootDir() fresh (not any single instance's captured
 * `cacheRoot`) so the list always reflects wherever the cache is CURRENTLY
 * configured to live, same as pruneIdleSessions/clearAllSessions below.
 */
export async function listCacheSessions(activeToken: string): Promise<StreamCacheEntry[]> {
  const root = cacheRootDir()
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const result: StreamCacheEntry[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !SESSION_TOKEN_RE.test(entry.name)) continue
    const dir = path.join(root, entry.name)
    try {
      const raw = await fsp.readFile(metaFilePath(root, entry.name), 'utf8')
      const meta = JSON.parse(raw) as StoredMeta
      const files = await fsp.readdir(dir)
      let cachedBytes = 0
      for (const file of files) {
        if (!file.startsWith('chunk-') || !file.endsWith('.bin')) continue
        const stat = await fsp.stat(path.join(dir, file))
        cachedBytes += stat.size
      }
      result.push({
        token: entry.name,
        title: meta.title,
        posterUrl: meta.posterUrl,
        catalogId: meta.catalogId,
        mediaKind: meta.mediaKind,
        seasonNumber: meta.seasonNumber,
        episodeNumber: meta.episodeNumber,
        cachedBytes,
        totalBytes: meta.totalBytes,
        isActive: entry.name === activeToken
      })
    } catch {
      // No meta.json, or it's unreadable/corrupt — skip rather than show an unlabeled entry.
    }
  }
  return result
}

/** Deletes an idle (non-active) session's directory outright — safe without
 *  going through the live StreamCache instance since an idle directory has
 *  no open server/fetch to tear down. Callers must check the token isn't
 *  the currently active one first (see playbackSession.ts's IPC handler).
 *  Reads cacheRootDir() fresh, same reasoning as listCacheSessions above. */
export async function deleteCacheSession(token: string): Promise<void> {
  if (!SESSION_TOKEN_RE.test(token)) throw new Error('Invalid cache session token.')
  await fsp.rm(sessionDir(cacheRootDir(), token), { recursive: true, force: true })
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
    if (!entry.isDirectory() || !SESSION_TOKEN_RE.test(entry.name)) continue
    if (activeCacheTokens.has(entry.name)) continue
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
