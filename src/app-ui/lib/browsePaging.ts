// When the phone's Browse grid stops paging, and when it starts again.
//
// Pure, so tests can hold it down without a DOM (Browse.tsx is the only
// caller).

import type { LibraryChangedEvent } from '@shared/media-hub/types'

/**
 * Whether the grid has nothing more to page in after a page of `pageLength`
 * rows: the index ran out, the total is reached, or the screen's cap is.
 *
 * An empty FIRST page counts as done for paging, because the load-more
 * sentinel would otherwise sit on screen and re-fire on every render. It is
 * not final: on a fresh install the first crawl has simply not landed yet,
 * and the grid reloads when the index says it changed (see
 * indexMayHaveGrown).
 */
export function browsePagingDone(
  loaded: number,
  pageLength: number,
  total: number,
  max: number
): boolean {
  return pageLength === 0 || loaded >= total || loaded >= max
}

/**
 * Whether the grid is empty because the index has nothing for it YET: paging
 * stopped on an empty first page with nothing failing and nothing still
 * loading. That is the first crawl not having landed, so the screen says it
 * is still loading rather than "Nothing here yet", and starts over when the
 * index changes (see indexMayHaveGrown).
 */
export function browseWaitingForIndex(grid: {
  done: boolean
  loading: boolean
  error: string | null
  count: number
}): boolean {
  return grid.done && !grid.loading && !grid.error && grid.count === 0
}

/** Whether a library:changed event can have added titles to a Browse grid:
 *  the index scope (a crawl, the deep scan, the household sync, a search
 *  title indexed when opened) or a wholesale change. */
export function indexMayHaveGrown(event: LibraryChangedEvent): boolean {
  return event.scopes.some((scope) => scope === 'index' || scope === 'all')
}
