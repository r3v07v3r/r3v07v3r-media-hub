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
 * is still loading rather than "Nothing here yet" until it has waited past
 * its limit (see browseEmptyNote), and starts over when the index changes
 * (see indexMayHaveGrown).
 */
export function browseWaitingForIndex(grid: {
  done: boolean
  loading: boolean
  error: string | null
  count: number
}): boolean {
  return grid.done && !grid.loading && !grid.error && grid.count === 0
}

/**
 * When this visit's empty grid began waiting on the index, which the
 * screen's limit on "still loading" is measured from. Kept through the
 * start-overs an index write causes: a write for ANY kind starts the grid
 * over (indexMayHaveGrown cannot tell kinds apart), and a wait measured from
 * the last of them would go on for as long as the deep scan or a household
 * sync kept writing. `now` the first time the grid waits, and null again
 * once titles arrive or a failure says so itself. A kind change starts it
 * over too (Browse.tsx).
 */
export function browseWaitStart(
  since: number | null,
  grid: { done: boolean; loading: boolean; error: string | null; count: number },
  now: number
): number | null {
  if (grid.count > 0 || grid.error) return null
  if (since !== null) return since
  return browseWaitingForIndex(grid) ? now : null
}

/**
 * What an empty grid says about itself. "Still loading" (LoadingNote) for as
 * long as it is fetching, about to fetch or waiting on the index: the first
 * crawl lands as several index writes over up to a minute, and the grid
 * starts over on each, so calling it empty in between read as a dead end.
 * "Nothing here yet" only once it has waited on the index past the screen's
 * limit (`waitedTooLong`), so a crawl that found nothing is not reported as
 * loading for ever. Null with titles on screen, or when a failure says so
 * itself.
 */
export function browseEmptyNote(
  grid: { done: boolean; loading: boolean; error: string | null; count: number },
  waitedTooLong: boolean
): 'loading' | 'nothing' | null {
  if (grid.count > 0 || grid.error) return null
  return browseWaitingForIndex(grid) && waitedTooLong ? 'nothing' : 'loading'
}

/** Whether a library:changed event can have added titles to a Browse grid:
 *  the index scope (a crawl, the deep scan, the household sync, a search
 *  title indexed when opened) or a wholesale change. */
export function indexMayHaveGrown(event: LibraryChangedEvent): boolean {
  return event.scopes.some((scope) => scope === 'index' || scope === 'all')
}
