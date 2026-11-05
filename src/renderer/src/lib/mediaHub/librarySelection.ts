// Which title the Movies/Series/Anime side panel shows.
//
// The panel used to look the selected id up in the shelves and the grid and
// fall back to the page's hero title when it was in none of them. A title
// leaves those as a direct result of acting on it from the panel or the card
// menu: marked Not interested or watched under a Hide filter, or dropped from
// the Recommended shelf by the next feed. The panel then jumped to an
// unrelated title, taking the Undo-able state out of view. The selection is
// now kept as the item that was selected; a fresh copy from the page is
// preferred while there is one, and the hero stands in only when nothing has
// been selected.
//
// That holding is for a title that left because of something done to it. A
// title the person hid themselves, by changing the page's query (a filter,
// a Hide toggle, a search), is not held: once the query has changed since
// it was selected, it is shown only while it is still on the page.
//
// "Since it was selected" is since it was last selected or last seen on the
// page (stampLibrarySelection). Stamped only when it was picked, a title
// still on the page after one filter change lost its hold for good: acting
// on it then moved the panel on, the jump this file exists to prevent. And
// only what decides which titles are on the page counts as the query, not
// the sort, which reorders them and hides none (libraryMembershipKey).

import type { MediaItem } from '@renderer/types'
import type { CategoryFilterState } from './categoryFilters'

/** The part of the page's query that decides which titles are on it: the
 *  filters, the Hide toggles and the search text. Not the sort. */
export function libraryMembershipKey(filters: CategoryFilterState, search: string): string {
  return `${JSON.stringify({ ...filters, sort: null })}|${search}`
}

/** The selection, and the membership key it was last made or seen under. */
export interface LibrarySelectionStamp {
  selection: MediaItem | null
  query: string
}

/**
 * The stamp for this render: a new selection is stamped with the current
 * query, and so is one still on the page under it (re-affirmed: the person
 * can see it, so it is held from here). One the current query has hidden
 * keeps its old stamp, so resolveLibrarySelection lets it go. The same
 * object comes back when nothing changed, for a render-time update.
 */
export function stampLibrarySelection(
  stamp: LibrarySelectionStamp,
  pools: ReadonlyArray<readonly MediaItem[]>,
  selection: MediaItem | null,
  query: string
): LibrarySelectionStamp {
  if (stamp.selection !== selection) return { selection, query }
  if (!selection || stamp.query === query) return stamp
  const onPage = pools.some((pool) => pool.some((item) => item.id === selection.id))
  return onPage ? { selection, query } : stamp
}

export function resolveLibrarySelection(
  pools: ReadonlyArray<readonly MediaItem[]>,
  selection: MediaItem | null,
  fallback: MediaItem | null,
  /** The page's query has changed since `selection` was made. */
  queryChanged = false
): MediaItem | null {
  if (!selection) return fallback
  for (const pool of pools) {
    const found = pool.find((item) => item.id === selection.id)
    if (found) return found
  }
  return queryChanged ? fallback : selection
}
