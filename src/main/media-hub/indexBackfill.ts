// The one-time pass that gives every title somebody already has an index row.
//
// The grids, My Stuff and the Planned row read the catalog index by id. A
// title the crawl never reached gets its row when it is opened, tracked or
// pulled from a service's plan-to-watch (catalog.ts's indexTrackedTitle and
// the cached-entry path in metadata()). Titles tracked, watched, rated or
// marked Not for me before those rules existed have no row, and stay missing
// from all three surfaces until somebody happens to open each one again.
// This pass writes those rows once, for every profile in the database, and
// records that it has finished in the catalog_cache store so it never runs
// again.
//
// Each row is built from the title's cached meta entry where there is one
// (the same item a full open indexes), and otherwise from the tracking row
// alone: id, kind and title, with the poster arriving the first time the
// title is opened. An id known only by its rating has no kind of its own;
// it takes the kind of a cached meta entry, a Kitsu id is anime, and one
// with neither is left out, because a guessed kind puts a series in the
// movie grid.
//
// Run as a background job held to idle (backgroundJobs.ts), in chunks with
// a turn of the event loop between them. When the app stops being idle part
// way, the pass stops without its record; the next run starts over, and
// every row already written has left the candidate list.

import type { CatalogItem, MediaKind } from '../../shared/media-hub/types'
import { sanitizeDaemonTitleRow } from '../../shared/lancache/titleSync'
import type { MediaHubDatabase } from './database'
import { indexTitlesIfMissing } from './deepScanRules'
import { metaCacheKey } from './titleNames'

/** Where the finished pass is recorded. A new version re-runs it. */
export const INDEX_BACKFILL_KEY = 'catalog-index:backfill:v1'

/** Kept for as long as the database: the record is the "once". */
const RECORD_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000

/** Titles per chunk. Each chunk is a few cache reads per title and one
 *  index write per kind, short enough not to hold the main process. */
export const INDEX_BACKFILL_CHUNK = 50

const KINDS: readonly MediaKind[] = ['movie', 'series', 'anime']

export interface IndexBackfillDeps {
  db: Pick<
    MediaHubDatabase,
    | 'indexBackfillCandidates'
    | 'getCache'
    | 'putCache'
    | 'indexExistingIds'
    | 'indexMaxRank'
    | 'indexUpsert'
  >
  /** False once the app is no longer idle; checked between chunks. */
  stillIdle: () => boolean
  /** Lets other work run between chunks. */
  yieldTurn: () => Promise<void>
}

export interface IndexBackfillReport {
  /** Rows written by this run. */
  indexed: number
  /** Whether the pass finished, now or on an earlier run. */
  done: boolean
}

/** Whether this database has had the pass. */
export function indexBackfillDone(db: Pick<MediaHubDatabase, 'getCache'>): boolean {
  return Boolean(db.getCache(INDEX_BACKFILL_KEY, { allowExpired: true }))
}

function isKind(value: unknown): value is MediaKind {
  return value === 'movie' || value === 'series' || value === 'anime'
}

/** The cached meta entry for this id under this kind, if it has a name. */
function cachedMeta(deps: IndexBackfillDeps, kind: MediaKind, id: string): CatalogItem | null {
  const key = metaCacheKey(kind, id)
  // A live degraded marker means the entry is a stand-in, which a full
  // open does not index either; the bare row is used instead.
  if (deps.db.getCache<boolean>(`${key}:degraded`)) return null
  const item = deps.db.getCache<CatalogItem>(key, { allowExpired: true })
  return item && String(item.title ?? '').trim() ? item : null
}

/** The row one candidate becomes, or null when nothing says its kind. */
function backfillItem(
  deps: IndexBackfillDeps,
  candidate: { id: string; type: string | null; title: string | null }
): { kind: MediaKind; item: CatalogItem } | null {
  const { id } = candidate
  let kind: MediaKind | null = isKind(candidate.type) ? candidate.type : null
  let meta: CatalogItem | null = null
  if (kind) {
    meta = cachedMeta(deps, kind, id)
  } else if (id.startsWith('kitsu:')) {
    kind = 'anime'
    meta = cachedMeta(deps, kind, id)
  } else {
    for (const option of KINDS) {
      meta = cachedMeta(deps, option, id)
      if (meta) {
        kind = option
        break
      }
    }
  }
  if (!kind) return null
  if (meta) return { kind, item: { ...meta, id, type: kind } }
  // Only the tracking row: cut to the fields the index takes from outside
  // the crawl, as indexTrackedTitle does.
  const row = sanitizeDaemonTitleRow({
    seq: 1,
    rank: 0,
    kind,
    item: { id, type: kind, title: candidate.title ?? '' }
  })
  return row ? { kind, item: row.item as CatalogItem } : null
}

/**
 * Runs the pass, or does nothing when it has already finished. The record is
 * written only when every chunk was processed and no membership read failed.
 */
export async function runIndexBackfill(deps: IndexBackfillDeps): Promise<IndexBackfillReport> {
  if (indexBackfillDone(deps.db)) return { indexed: 0, done: true }
  const candidates = deps.db.indexBackfillCandidates()
  if (!candidates) return { indexed: 0, done: false }
  let indexed = 0
  let complete = true
  for (let start = 0; start < candidates.length; start += INDEX_BACKFILL_CHUNK) {
    if (start > 0) {
      await deps.yieldTurn()
      if (!deps.stillIdle()) return { indexed, done: false }
    }
    const byKind = new Map<MediaKind, CatalogItem[]>()
    for (const candidate of candidates.slice(start, start + INDEX_BACKFILL_CHUNK)) {
      const built = backfillItem(deps, candidate)
      if (!built) continue
      const list = byKind.get(built.kind) ?? []
      list.push(built.item)
      byKind.set(built.kind, list)
    }
    for (const [kind, items] of byKind) {
      const wrote = indexTitlesIfMissing(deps.db, kind, items)
      if (wrote === null) complete = false
      else indexed += wrote
    }
  }
  if (complete) {
    deps.db.putCache(INDEX_BACKFILL_KEY, { at: Date.now(), indexed }, RECORD_TTL_MS, {
      durable: true
    })
  }
  return { indexed, done: complete }
}
