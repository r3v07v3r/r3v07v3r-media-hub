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

function sameItem(a: CatalogItem, b: CatalogItem): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function createTitleStore(dataDir: string): TitleStore {
  const ndjsonPath = path.join(dataDir, 'titles.ndjson')
  const metaPath = path.join(dataDir, 'titles-meta.json')

  // kind -> id -> row. Later lines win on load, which is what append-on-
  // change means.
  const byKind = new Map<MediaKind, Map<string, DaemonTitleRow>>(
    KINDS.map((kind) => [kind, new Map()])
  )
  // Sorted-by-seq view per kind, rebuilt lazily — invalidated on upsert.
  const sortedCache = new Map<MediaKind, DaemonTitleRow[]>()
  let seqCounter = 0
  let lineCount = 0
  const refreshedAt: Partial<Record<MediaKind, number>> = {}

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

  async function compactIfBloated(): Promise<void> {
    if (lineCount <= liveCount() * 2 + COMPACT_SLACK_LINES) return
    const lines: string[] = []
    for (const map of byKind.values()) {
      for (const row of map.values()) lines.push(JSON.stringify(row))
    }
    const tmp = `${ndjsonPath}.tmp`
    await fsp.writeFile(tmp, lines.length ? lines.join('\n') + '\n' : '')
    await fsp.rename(tmp, ndjsonPath)
    lineCount = lines.length
  }

  function sorted(kind: MediaKind): DaemonTitleRow[] {
    let rows = sortedCache.get(kind)
    if (!rows) {
      rows = [...(byKind.get(kind)?.values() ?? [])].sort((a, b) => a.seq - b.seq)
      sortedCache.set(kind, rows)
    }
    return rows
  }

  return {
    async upsert(kind, entries) {
      const map = byKind.get(kind)
      if (!map) return 0
      const changedLines: string[] = []
      for (const entry of entries) {
        const id = String(entry.item?.id || '')
        if (!id) continue
        const current = map.get(id)
        if (current) {
          const contentSame = sameItem(current.item, entry.item)
          const rankClose = Math.abs(current.rank - entry.rank) <= RANK_DRIFT_SLACK
          if (contentSame && rankClose) continue
          // Content changed, or the title genuinely moved: new seq so
          // watermarked clients hear about it.
          const row: DaemonTitleRow = {
            seq: ++seqCounter,
            kind,
            rank: contentSame && rankClose ? current.rank : entry.rank,
            item: entry.item
          }
          map.set(id, row)
          changedLines.push(JSON.stringify(row))
        } else {
          const row: DaemonTitleRow = {
            seq: ++seqCounter,
            kind,
            rank: entry.rank,
            item: entry.item
          }
          map.set(id, row)
          changedLines.push(JSON.stringify(row))
        }
      }
      if (changedLines.length) {
        sortedCache.delete(kind)
        try {
          await fsp.appendFile(ndjsonPath, changedLines.join('\n') + '\n')
          lineCount += changedLines.length
          await compactIfBloated()
        } catch {
          // Disk trouble loses durability, not correctness: the in-memory
          // store still serves, and the next crawl re-detects the delta.
        }
      }
      return changedLines.length
    },

    listSince(kind, since, limit) {
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
        rows: page,
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
      try {
        const text = await fsp.readFile(ndjsonPath, 'utf8')
        for (const line of text.split('\n')) {
          if (!line.trim()) continue
          lineCount += 1
          try {
            const row = JSON.parse(line) as DaemonTitleRow
            if (!row || typeof row.seq !== 'number' || !row.item?.id) continue
            const map = byKind.get(row.kind)
            if (!map) continue
            map.set(String(row.item.id), row)
            if (row.seq > seqCounter) seqCounter = row.seq
          } catch {
            // A torn tail line from a crash loses that one change; the next
            // crawl re-detects it.
          }
        }
        await compactIfBloated()
      } catch {
        // First run.
      }
    }
  }
}
