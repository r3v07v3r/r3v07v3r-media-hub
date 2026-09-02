// The one decision in the deep scan that can destroy curated work,
// alone in a module with no Electron or network in reach so tests can
// hold it down — the same split watchlistRules and roomRules use, for
// the same reason.

import type { CatalogItem } from '../../shared/media-hub/types'

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
