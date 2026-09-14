// History rows written under Simkl's own numbering, and how they find
// their way back to the IMDb id everything else is keyed by.
//
// normalizeSimklCatalog (core.ts) mints `simkl:<n>` when a Simkl list or
// search result arrives without an IMDb id. Marking such a card watched
// writes a history row under that id; opening the same title through any
// IMDb-keyed surface writes a second row under `tt…`. Simkl's own library
// only ever reports the IMDb id back, so the `simkl:` row could never join
// the remote side and sat in the out-of-sync review forever — "Here:
// Watched, Simkl: Not watched" for a film Simkl had watched all along
// (John Wick, 2026-09-11, eight seconds apart). Two live copies of the
// same viewing is the corruption; this module is what folds them.
//
// Electron-free on purpose: tracking.ts is the only caller, but its
// `electron` import keeps it out of the unit tests, and the rule for
// "which real id is this" deserves one.

import type { HistoryEntry } from '../../shared/media-hub/types'

const SIMKL_KEYED = /^simkl:(\d+)$/
const IMDB = /^tt\d+$/i

export function isSimklKeyedId(id: string): boolean {
  return SIMKL_KEYED.test(id)
}

/**
 * The IMDb id a `simkl:<n>` history row should have been written under, or
 * null when nothing at hand can say. Two sources, both already paid for:
 * the connected account's own library (whose movies carry Simkl's number
 * next to the IMDb id — see watchedFromAllItems), and the metadata cache,
 * which stores a resolved title under the `simkl:` id the caller opened it
 * by as well as its real one. No request is made here: a row neither
 * source can place stays as it is and is pushed as `{simkl}`, and the next
 * snapshot — which then contains it, IMDb id and all — places it.
 */
export function imdbForSimklKeyedId(
  id: string,
  remote: Iterable<Pick<HistoryEntry, 'id' | 'simklId'>>,
  cachedId: (id: string) => string | null | undefined
): string | null {
  const match = SIMKL_KEYED.exec(id)
  if (!match) return null
  const number = Number(match[1])
  for (const entry of remote) {
    if (entry.simklId === number && IMDB.test(entry.id)) return entry.id
  }
  const cached = cachedId(id)
  return cached && IMDB.test(cached) ? cached : null
}
