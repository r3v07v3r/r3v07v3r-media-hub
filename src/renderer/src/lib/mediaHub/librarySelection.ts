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

import type { MediaItem } from '@renderer/types'

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
