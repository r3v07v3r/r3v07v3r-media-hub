// The one decision in the deep scan that can destroy curated work,
// alone in a module with no Electron or network in reach so tests can
// hold it down — the same split watchlistRules and roomRules use, for
// the same reason.

import type { CatalogItem, MediaKind } from '../../shared/media-hub/types'
import { isIndexableTitleId } from '../../shared/lancache/titleSync'

/**
 * Which freshly scanned rows may be written to the index.
 *
 * The rule with teeth: A DEEP SCAN NEVER OVERWRITES WHAT THE CRAWL
 * CURATED. Rows already in the index are skipped, and for anime that is
 * load-bearing, not politeness — deep rows arrive UNGROUPED, and
 * upserting one over a franchise-grouped row would silently undo the
 * grouping pass (the single largest piece of background work this app
 * does). The standing crawl keeps curated rows fresh; the scan only
 * ever ADDS what nothing else has seen.
 */
export function planDeepScanBatch(
  items: CatalogItem[],
  existingIds: ReadonlySet<string>
): { add: CatalogItem[]; skipped: number } {
  const add: CatalogItem[] = []
  let skipped = 0
  const seen = new Set<string>()
  for (const item of items) {
    if (!item.id || seen.has(item.id)) continue
    seen.add(item.id)
    if (existingIds.has(item.id)) {
      skipped += 1
      continue
    }
    add.push(item)
  }
  return { add, skipped }
}

/** The index methods indexTitleIfMissing uses: a slice of the database, so
 *  this module still has none of its own in reach. */
export interface IndexWriter {
  indexHasRow(kind: MediaKind, id: string): boolean | null
  indexExistingIds(kind: MediaKind, ids: readonly string[]): Set<string> | null
  indexMaxRank(kind: MediaKind): number
  indexUpsert(
    kind: MediaKind,
    items: readonly CatalogItem[],
    opts?: { source?: string; rankBase?: number }
  ): boolean
}

/**
 * Writes one title into the index when the index has no row for it: a title
 * found only by a remote search, then opened or tracked.
 *
 * Without this such a title opened and played, but every surface that reads
 * the index missed it: the browse grids, and My Stuff's tabs and the Planned
 * row, which match tracked ids through catalog:byIds and have nothing to show
 * for an id the index does not hold. A title somebody tracked could vanish
 * from their own list.
 *
 * The deep scan's rule, through the same function: a row that exists (an
 * anime season grouped under its show counts, see indexExistingIds) is never
 * touched, so nothing the crawl curated is overwritten. The row is ranked
 * below everything already indexed and tagged source 'search'; a later crawl
 * that lists the title rewrites both. True when a row was written.
 *
 * The id must belong to the kind's catalog: Kitsu ids for anime, IMDb ids for
 * movies and series. A caller that defaulted a missing type (the status
 * handler reads a typeless payload as a movie) would otherwise put a Kitsu
 * title in the movie grid, or an IMDb one in the Kitsu-keyed anime grid.
 *
 * This runs on every open and every watched mark, so the common answer, a
 * row under this id already, is one primary-key lookup; the grouped-sibling
 * pass inside indexExistingIds parses every grouped row of the kind and runs
 * only when there is no direct row.
 */
export function indexTitleIfMissing(db: IndexWriter, kind: MediaKind, item: CatalogItem): boolean {
  const id = String(item?.id ?? '')
  if (!isIndexableTitleId(id) || !String(item.title ?? '').trim()) return false
  if (id.startsWith('kitsu:') !== (kind === 'anime')) return false
  const hasRow = db.indexHasRow(kind, id)
  // Null is membership unknown, which the check below also refuses.
  if (hasRow !== false) return false
  const existing = db.indexExistingIds(kind, [id])
  // Membership unknown: writing could duplicate a grouped season.
  if (existing === null) return false
  const { add } = planDeepScanBatch([{ ...item, id }], existing)
  if (!add.length) return false
  return db.indexUpsert(kind, add, { source: 'search', rankBase: db.indexMaxRank(kind) + 1 })
}
