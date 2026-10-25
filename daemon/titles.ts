// The daemon's title index: the household's copy of the upstream catalog,
// crawled once on this always-on box instead of once per device.
//
// Storage is NDJSON with append-on-change semantics: every row that
// CHANGES gets the next global sequence number and a new line; unchanged
// rows keep their line and their seq. That seq is the entire sync
// protocol — a client asks "everything after seq N" and gets exactly the
// rows it has not seen, however many crawls ran in between. Re-crawling
// an unchanged catalog therefore costs clients nothing, which is the
// property that makes a 6-hourly daemon crawl compatible with phones and
// laptops syncing over the LAN.
//
// One deliberate wrinkle: rank drift alone does not count as change.
// Cinemeta's ordering shuffles a little on every crawl, and if a
// 30-position wobble re-issued the row, every crawl would re-issue most
// of the index and the watermark would be worthless. A row's rank is
// updated (with a fresh seq) only when it moved far enough to matter to
// a "trending" sort — see RANK_DRIFT_SLACK.

import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import type { CatalogItem, MediaKind } from '../src/shared/media-hub/types'

export interface DaemonTitleRow {
  /** Global change sequence — the sync watermark. Monotonic, never reused. */
  seq: number
  kind: MediaKind
  /** Absolute position in the upstream catalog walk — the popularity order
   *  clients feed into their own index as a rank base. */
  rank: number
  item: CatalogItem
}

export interface TitleListPage {
  rows: DaemonTitleRow[]
  /** Pass this back as ?since= to continue. Equal to the request's since
   *  when there was nothing new. */
  nextSince: number
  more: boolean
  /** Live rows for this kind — what "the household index holds N titles"
   *  means, independent of how many changed lines history accumulated. */
  total: number
}

export interface TitleStore {
  /** Writes rows that actually changed; returns how many did. */
  upsert(kind: MediaKind, entries: Array<{ rank: number; item: CatalogItem }>): Promise<number>
  listSince(kind: MediaKind, since: number, limit: number): TitleListPage
  counts(): Record<MediaKind, number>
  lastRefreshAt(kind: MediaKind): number | null
  markRefreshed(kind: MediaKind, at: number): Promise<void>
  load(): Promise<void>
}

/** A rank wobble smaller than this is crawl noise, not news — the row
 *  keeps its seq and clients are not re-sent it. Big enough to absorb
 *  Cinemeta's page-to-page shuffle, small enough that a title genuinely
 *  climbing the charts still propagates. */
export const RANK_DRIFT_SLACK = 500

const KINDS: MediaKind[] = ['movie', 'series', 'anime']

/** Rewrite threshold: when the file carries more than twice as many lines
 *  as there are live rows (plus slack for small stores), compact it. */
const COMPACT_SLACK_LINES = 1000

/** Read size while loading. Big enough that the file is a few dozen reads,
 *  small enough that the buffer is a rounding error next to the index. */
const LOAD_CHUNK_BYTES = 1 << 20

// MEMORY. The rows themselves stay on disk; memory holds one small
// reference per title (seq, rank, a content hash, and where its line is in
// the file). This is not an optimisation for its own sake. The catalog is
// tens of thousands of rows and ~90 MB of JSON, and the daemon runs under
// a 512 MB cgroup on a box whose real job is something else, where Node
// sizes its heap to about half of that. Holding every row parsed (and
// loading by reading the whole file into one string and splitting it,
// which is two more full copies) ran out of heap three seconds into boot,
// so every build carrying the title tier crashed, was marked bad by the
// launcher, and r3-host fell back to its builtin build from August.
//
// A page of /api/titles reads its rows from disk: at most 500 short reads
// of a file the OS has cached, which is cheaper than it sounds and far
// cheaper than the alternative.
interface RowRef {
  seq: number
  rank: number
  /** Hash of the item's JSON: what "unchanged" is decided by, without
   *  keeping the item. */
  hash: string
  /** Byte position and length of this row's line, newline excluded. */
  offset: number
  length: number
}

/** The part of a file handle the loops below need, so a test can hand them
 *  one that reads or writes short. */
interface PositionalHandle {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ): Promise<{ bytesRead: number }>
  write(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ): Promise<{ bytesWritten: number }>
}

/** A read or write may move fewer bytes than asked and still succeed.
 *  Taking that for the whole buffer would drop the rest of a row silently,
 *  and during compaction the file it lands in replaces the intact one. */
export async function readFully(
  handle: Pick<PositionalHandle, 'read'>,
  buffer: Buffer,
  position: number
): Promise<void> {
  for (let done = 0; done < buffer.length;) {
    const { bytesRead } = await handle.read(buffer, done, buffer.length - done, position + done)
    if (bytesRead <= 0) throw new Error('titles.ndjson ended inside a row')
    done += bytesRead
  }
}

export async function writeFully(
  handle: Pick<PositionalHandle, 'write'>,
  buffer: Buffer,
  position: number
): Promise<void> {
  for (let done = 0; done < buffer.length;) {
    const { bytesWritten } = await handle.write(buffer, done, buffer.length - done, position + done)
    if (bytesWritten <= 0) throw new Error('could not write titles.ndjson')
    done += bytesWritten
  }
}

function itemHash(item: CatalogItem): string {
  return crypto.createHash('sha1').update(JSON.stringify(item)).digest('base64')
}

export function createTitleStore(
  dataDir: string,
  /** Test seam: how lines are appended and the file cut back. A real
   *  append can write part of its data and then fail (a full disk), which
   *  is the case the tail handling exists for. */
  options: {
    appendFile?: (file: string, data: string) => Promise<void>
    truncate?: (file: string, size: number) => Promise<void>
  } = {}
): TitleStore {
  const appendFile =
    options.appendFile ?? ((file: string, data: string) => fsp.appendFile(file, data))
  const truncate = options.truncate ?? ((file: string, size: number) => fsp.truncate(file, size))
  const ndjsonPath = path.join(dataDir, 'titles.ndjson')
  const metaPath = path.join(dataDir, 'titles-meta.json')

  // kind -> id -> row. Later lines win on load, which is what append-on-
  // change means.
  const byKind = new Map<MediaKind, Map<string, RowRef>>(KINDS.map((kind) => [kind, new Map()]))
  // Sorted-by-seq view per kind, rebuilt lazily — invalidated on upsert.
  const sortedCache = new Map<MediaKind, RowRef[]>()
  let seqCounter = 0
  let lineCount = 0
  /** Where the next appended line starts. */
  let fileSize = 0
  /** Set when an append failed and the file could not be cut back to
   *  fileSize: the file may now end in part of a line, past fileSize. */
  let tailUnknown = false
  /** False until the file has been read to the end. While false, nothing
   *  knows where the file ends, so nothing may be appended: a write would
   *  land at the real end and be indexed from a position that is not it. */
  let loaded = false
  const refreshedAt: Partial<Record<MediaKind, number>> = {}

  // Every write (append, compaction) runs one at a time: each one decides
  // byte offsets from fileSize, and two crawls appending at once would
  // otherwise record overlapping positions.
  let writeChain: Promise<unknown> = Promise.resolve()
  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = writeChain.then(task, task)
    writeChain = run.catch(() => {})
    return run
  }

  async function persistMeta(): Promise<void> {
    const tmp = `${metaPath}.tmp`
    await fsp.writeFile(tmp, JSON.stringify({ refreshedAt }))
    await fsp.rename(tmp, metaPath)
  }

  function liveCount(): number {
    let n = 0
    for (const map of byKind.values()) n += map.size
    return n
  }

  /** Rewrites the file with live rows only, a row at a time. The old file
   *  and the old offsets stay valid until the synchronous swap at the end,
   *  so a page served while this runs reads consistent rows. */
  async function compactIfBloated(): Promise<void> {
    if (lineCount <= liveCount() * 2 + COMPACT_SLACK_LINES) return
    const tmp = `${ndjsonPath}.tmp`
    const moved = new Map<RowRef, number>()
    let written = 0
    const source = await fsp.open(ndjsonPath, 'r')
    try {
      // Opened inside the source's cleanup: a target that cannot be opened
      // (the tmp path taken) would otherwise leak the source handle, once
      // per changed upsert, since every one of them retries compaction.
      const target = await fsp.open(tmp, 'w')
      try {
        for (const map of byKind.values()) {
          for (const ref of map.values()) {
            const line = Buffer.alloc(ref.length + 1)
            await readFully(source, line.subarray(0, ref.length), ref.offset)
            line[ref.length] = 0x0a
            await writeFully(target, line, written)
            moved.set(ref, written)
            written += line.length
          }
        }
      } finally {
        await target.close()
      }
    } finally {
      await source.close()
    }
    // Synchronous from here: no request can run between the file changing
    // and the offsets that describe it changing.
    fs.renameSync(tmp, ndjsonPath)
    for (const [ref, offset] of moved) ref.offset = offset
    fileSize = written
    lineCount = moved.size
  }

  /** After an append failed and could not be cut back: learn where the file
   *  really ends, and close off any fragment so the next line starts clean
   *  (the fragment is a torn line, skipped on load). */
  async function settleTail(): Promise<void> {
    if (!tailUnknown) return
    let { size } = await fsp.stat(ndjsonPath)
    // Decided by the last byte, not by the size: a torn line found at load
    // sits INSIDE the size this store already knows.
    if (size > 0) {
      const last = Buffer.alloc(1)
      const handle = await fsp.open(ndjsonPath, 'r')
      try {
        await readFully(handle, last, size - 1)
      } finally {
        await handle.close()
      }
      if (last[0] !== 0x0a) {
        await appendFile(ndjsonPath, '\n')
        size += 1
      }
    }
    fileSize = size
    tailUnknown = false
  }

  function sorted(kind: MediaKind): RowRef[] {
    let rows = sortedCache.get(kind)
    if (!rows) {
      rows = [...(byKind.get(kind)?.values() ?? [])].sort((a, b) => a.seq - b.seq)
      sortedCache.set(kind, rows)
    }
    return rows
  }

  function readRows(refs: RowRef[]): DaemonTitleRow[] {
    if (!refs.length) return []
    const fd = fs.openSync(ndjsonPath, 'r')
    try {
      return refs.map((ref) => {
        const buffer = Buffer.alloc(ref.length)
        for (let done = 0; done < ref.length;) {
          const read = fs.readSync(fd, buffer, done, ref.length - done, ref.offset + done)
          if (read <= 0) throw new Error('titles.ndjson ended inside a row')
          done += read
        }
        return JSON.parse(buffer.toString('utf8')) as DaemonTitleRow
      })
    } finally {
      fs.closeSync(fd)
    }
  }

  /** Reads the file into a clean index. Run at load, and again before the
   *  first write when that load did not finish. */
  async function reload(): Promise<void> {
    loaded = false
    // Built on the side and published in one step. Rows in a compacted file
    // are not in seq order, so a half-read index can hold seq 10 without
    // seq 1; a sync page served from it would hand a client a watermark past
    // rows not yet read, and the client keeps that watermark for good.
    const fresh = new Map<MediaKind, Map<string, RowRef>>(KINDS.map((kind) => [kind, new Map()]))
    const read = await loadRows(fresh)
    for (const kind of KINDS) byKind.set(kind, fresh.get(kind) ?? new Map())
    seqCounter = read.maxSeq
    lineCount = read.lines
    fileSize = read.size
    tailUnknown = false
    sortedCache.clear()
    loaded = true
    // A file that ends mid-line (a crash during append) would glue the next
    // appended row onto that fragment. Close it off first. Marked before and
    // cleared only on success: if this append fails (a full disk at boot),
    // the next write must still close the line off.
    if (fileSize && read.lastByte !== 0x0a) {
      tailUnknown = true
      await appendFile(ndjsonPath, '\n')
      fileSize += 1
      tailUnknown = false
    }
  }

  /** Streams the file into `target`, indexing each line by its byte
   *  position. Only one chunk and one line are ever held at a time. */
  async function loadRows(
    target: Map<MediaKind, Map<string, RowRef>>
  ): Promise<{ maxSeq: number; lines: number; size: number; lastByte: number }> {
    let maxSeq = 0
    let lines = 0
    let handle: fsp.FileHandle
    try {
      handle = await fsp.open(ndjsonPath, 'r')
    } catch (error) {
      // No file is a first run. Any other failure is a file that is there
      // and could not be read, and must not pass for an empty one.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { maxSeq, lines, size: 0, lastByte: 0x0a }
      }
      throw error
    }
    let position = 0
    let carry = Buffer.alloc(0)
    let lastByte = 0x0a
    const index = (line: Buffer, offset: number): void => {
      if (!line.length) return
      lines += 1
      try {
        const row = JSON.parse(line.toString('utf8')) as DaemonTitleRow
        if (!row || typeof row.seq !== 'number' || !row.item?.id) return
        const map = target.get(row.kind)
        if (!map) return
        map.set(String(row.item.id), {
          seq: row.seq,
          rank: row.rank,
          hash: itemHash(row.item),
          offset,
          length: line.length
        })
        if (row.seq > maxSeq) maxSeq = row.seq
      } catch {
        // A torn tail line from a crash loses that one change; the next
        // crawl re-detects it.
      }
    }
    try {
      const chunk = Buffer.alloc(LOAD_CHUNK_BYTES)
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
        if (!bytesRead) break
        const data = carry.length
          ? Buffer.concat([carry, chunk.subarray(0, bytesRead)])
          : chunk.subarray(0, bytesRead)
        const dataStart = position - carry.length
        let lineStart = 0
        for (let at = data.indexOf(0x0a); at !== -1; at = data.indexOf(0x0a, at + 1)) {
          index(data.subarray(lineStart, at), dataStart + lineStart)
          lineStart = at + 1
        }
        // Copied: the chunk buffer is reused by the next read.
        carry = Buffer.from(data.subarray(lineStart))
        lastByte = data[data.length - 1]
        position += bytesRead
      }
      index(carry, position - carry.length)
    } finally {
      await handle.close()
    }
    return { maxSeq, lines, size: position, lastByte }
  }

  return {
    upsert(kind, entries) {
      return serialized(async () => {
        try {
          if (!loaded) await reload()
          await settleTail()
        } catch {
          return 0 // Still cannot tell where the file ends: write nothing.
        }
        // Looked up after any reload, which replaces the maps.
        const map = byKind.get(kind)
        if (!map) return 0
        const changed: Array<{ id: string; ref: RowRef; line: string }> = []
        let offset = fileSize
        for (const entry of entries) {
          const id = String(entry.item?.id || '')
          if (!id) continue
          const hash = itemHash(entry.item)
          const current = map.get(id)
          if (current) {
            const contentSame = current.hash === hash
            const rankClose = Math.abs(current.rank - entry.rank) <= RANK_DRIFT_SLACK
            if (contentSame && rankClose) continue
          }
          // New, content changed, or the title genuinely moved: new seq so
          // watermarked clients hear about it.
          const row: DaemonTitleRow = {
            seq: ++seqCounter,
            kind,
            rank: entry.rank,
            item: entry.item
          }
          const line = JSON.stringify(row)
          const length = Buffer.byteLength(line)
          changed.push({ id, line, ref: { seq: row.seq, rank: row.rank, hash, offset, length } })
          offset += length + 1
        }
        if (!changed.length) return 0
        try {
          await appendFile(ndjsonPath, changed.map((entry) => entry.line).join('\n') + '\n')
        } catch {
          // Nothing is indexed: the rows live on disk now, and an entry
          // pointing at bytes that never landed would serve garbage. The
          // next crawl re-detects the delta. But the append may have written
          // PART of its data before failing, so the file is cut back to
          // where it ended; otherwise every later row would land after the
          // fragment and be indexed at the wrong place.
          try {
            await truncate(ndjsonPath, fileSize)
          } catch {
            tailUnknown = true
          }
          return 0
        }
        for (const entry of changed) map.set(entry.id, entry.ref)
        fileSize = offset
        lineCount += changed.length
        sortedCache.delete(kind)
        try {
          await compactIfBloated()
        } catch {
          // Compaction is housekeeping: the appended file is still correct.
        }
        return changed.length
      })
    },

    listSince(kind, since, limit) {
      // Refused, not answered from what is there: a page from an index that
      // is not fully read can carry a watermark past rows it does not have
      // yet (see reload). The route answers 500, which the app's title sync
      // treats as "no rows this time" and asks again next pass.
      if (!loaded) throw new Error('The title index is still loading.')
      const rows = sorted(kind)
      // Rows are seq-ascending; binary search for the first > since.
      let lo = 0
      let hi = rows.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (rows[mid].seq > since) hi = mid
        else lo = mid + 1
      }
      const page = rows.slice(lo, lo + limit)
      return {
        rows: readRows(page),
        nextSince: page.length ? page[page.length - 1].seq : since,
        more: lo + limit < rows.length,
        total: rows.length
      }
    },

    counts() {
      const out = {} as Record<MediaKind, number>
      for (const kind of KINDS) out[kind] = byKind.get(kind)?.size ?? 0
      return out
    },

    lastRefreshAt(kind) {
      return refreshedAt[kind] ?? null
    },

    async markRefreshed(kind, at) {
      refreshedAt[kind] = at
      try {
        await persistMeta()
      } catch {
        // Freshness display degrades; the index itself is unaffected.
      }
    },

    async load() {
      try {
        const parsed = JSON.parse(await fsp.readFile(metaPath, 'utf8')) as {
          refreshedAt?: Partial<Record<MediaKind, number>>
        }
        for (const kind of KINDS) {
          const at = Number(parsed.refreshedAt?.[kind])
          if (Number.isFinite(at) && at > 0) refreshedAt[kind] = at
        }
      } catch {
        // First run.
      }
      await serialized(async () => {
        await reload()
        await compactIfBloated()
      }).catch(() => {
        // An index that could not be read serves what it has; the next write
        // retries the read before it appends anything (see `loaded`).
      })
    }
  }
}
