// Titles by id, from the index — the matching half of stage 4.
//
// The loaded catalog array used to serve two different jobs: ranking
// pools (rails, mood browser) and ID-MATCHING (My Stuff's tabs, the
// Planned row — "show me these exact titles"). Stage 4 bounds the array
// to a candidate pool, which is fine for ranking and wrong for
// matching: a tracked title has every right to live outside any pool.
// This hook is where matching moved — catalog:byIds reads the index,
// which holds everything the app has ever crawled or deep-scanned.
//
// Rows adapt through the context's adaptCatalogItems (the stage-3
// badge-consistency contract) and dedupe by id: a `tt` id can exist as
// both a movie and a series row, and for a personal collection the
// first row wins — the person tracked a title, not a kind.

import { useEffect, useMemo, useState } from 'react'
import type { CatalogItem } from '@shared/media-hub/types'
import type { MediaItem } from '@renderer/types'

/** Joins/splits the id key. Unit separator, because ids are free text
 *  from several id spaces and none of them may contain control chars. */
const SEP = String.fromCharCode(31)

export function useCatalogByIds(
  ids: ReadonlySet<string> | readonly string[],
  adapt: (items: CatalogItem[], completedIds?: string[]) => MediaItem[],
  /** Any value whose identity tracks the INDEX growing — the callers
   *  pass the catalog kind states. On a fresh database these queries
   *  can land before catalog:list has seeded anything; without a
   *  refetch when a kind settles, that early empty answer would stand
   *  until the ids themselves changed, and a full Planned list would
   *  render as an empty shelf. */
  revision: unknown = null
): { items: MediaItem[]; loading: boolean } {
  // A stable, sorted key so set identity churn (a fresh Set of the same
  // ids every render) never refetches, and a genuine membership change
  // always does.
  const idsKey = useMemo(() => [...ids].sort().join(SEP), [ids])

  const [rows, setRows] = useState<{
    key: string
    items: CatalogItem[]
    completedIds: string[]
  }>({
    key: '',
    items: [],
    completedIds: []
  })
  // Derived, not set: a fetch is outstanding exactly while the rows on
  // show belong to an older id set than the one wanted now.
  const loading = idsKey !== '' && rows.key !== idsKey

  useEffect(() => {
    if (!idsKey) return
    let cancelled = false
    window.api?.mediaHub?.catalog
      .byIds(idsKey.split(SEP))
      .then((result) => {
        if (cancelled) return
        // Dedupe by id, first row wins — see the header comment.
        const seen = new Set<string>()
        setRows({
          key: idsKey,
          items: result.items.filter((item) => {
            if (seen.has(item.id)) return false
            seen.add(item.id)
            return true
          }),
          completedIds: result.completedIds
        })
      })
      .catch(() => {
        // Keep whatever was showing; an id-match surface flashing empty
        // on a transient failure reads as "your list is gone". The
        // loading flag stays up (the key still lags), which is the
        // truthful description of an unanswered fetch.
      })
    return () => {
      cancelled = true
    }
  }, [idsKey, revision])

  const items = useMemo(() => {
    // An empty id set is empty by derivation, no state write needed; a
    // stale answer keeps showing until the fresh one lands — matching
    // surfaces should not blink. But stale rows are FILTERED to the ids
    // wanted NOW: a removed title must disappear on removal (not when
    // the refetch lands, and not never if it fails), and switching
    // remote lists must not flash the previous list's titles.
    if (!idsKey) return []
    const wanted = new Set(idsKey.split(SEP))
    return adapt(
      rows.items.filter((item) => wanted.has(item.id)),
      // Completion membership from the SQL side — index rows carry no
      // episode data, so the adapter cannot derive it. Extra stale ids
      // in the set are harmless: only rows on show consult it.
      rows.completedIds
    )
    // The adapter's identity changes with every watch-state edit, which
    // is exactly when badges must recompute — no refetch involved.
  }, [idsKey, rows.items, rows.completedIds, adapt])

  return { items, loading }
}
