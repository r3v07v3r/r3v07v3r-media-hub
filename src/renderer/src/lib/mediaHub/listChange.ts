import type { MediaItem } from '@renderer/types'

/** Above this much overlap, a new list counts as the same browse set with
 *  an edit applied rather than a different list entirely. */
const SAME_LIST_OVERLAP = 0.8

/**
 * How a newly-arrived `items` array relates to the one it replaced.
 *
 * - `same`: identical titles in identical order — the array is merely a
 *   fresh derivation upstream, and nothing about the view should move.
 * - `edited`: mostly the same titles, a few added or removed (someone
 *   marked one watched while a hide filter is on). The person is still
 *   looking at the same list and should keep their place.
 * - `different`: a new filter, sort, or search. Genuinely a fresh result
 *   list, and starting at the top with one batch is right.
 *
 * Two things a naive overlap ratio gets wrong, both fixed here:
 *
 * 1. A filter that narrows hundreds of titles down to a handful is a
 *    `different` view, not an `edited` one — but every one of those
 *    survivors was, tautologically, already present in the bigger list,
 *    so `shared / min(prev.length, next.length)` was always 1.0 for any
 *    subset no matter how drastic the narrowing. Dividing by
 *    `max(...)` instead means the ratio actually reflects how much of
 *    the LARGER list survived, so a 500 -> 50 filter reads as ~10%
 *    overlap and correctly resets.
 * 2. A sort touches every item's id (nothing added or removed) but
 *    changes their order — full id overlap, same lengths, yet still a
 *    `different` view per the definition above ("a new filter, sort, or
 *    search"). An ordinary edit (mark one watched, one new
 *    recommendation lands) never reorders the titles that survive it,
 *    so comparing the RELATIVE order of the ids both lists share tells
 *    the two apart: unchanged relative order is an edit, changed
 *    relative order is a resort.
 *
 * Ids are unique within a list (see hooks.ts's dedupeById).
 *
 * Shared by MediaGrid.tsx (the category pages' results grid) and
 * AnimeLibraryPage.tsx's EverythingSection (the Movies/Series/Anime
 * library pages' own paginated grid) — both reveal a large list in
 * batches and need the same "hold the person's place unless the list is
 * genuinely a different one" call. Lives here rather than in either
 * component file so it can be imported without pulling in a whole grid
 * component (and so React Fast Refresh doesn't balk at a component file
 * exporting a non-component).
 */
export function listChange(prev: MediaItem[], next: MediaItem[]): 'same' | 'edited' | 'different' {
  if (prev === next) return 'same'
  if (prev.length === next.length) {
    let identical = true
    for (let i = 0; i < prev.length; i++) {
      if (prev[i].id !== next[i].id) {
        identical = false
        break
      }
    }
    if (identical) return 'same'
  }
  if (!prev.length || !next.length) return 'different'

  const prevIds = new Set(prev.map((item) => item.id))
  const nextIds = new Set(next.map((item) => item.id))
  let shared = 0
  for (const item of next) {
    if (prevIds.has(item.id)) shared++
  }
  if (shared / Math.max(prev.length, next.length) < SAME_LIST_OVERLAP) return 'different'

  // High overlap alone doesn't rule out a pure resort — compare the
  // relative order of whichever ids both lists share.
  const prevSharedOrder = prev.filter((item) => nextIds.has(item.id))
  const nextSharedOrder = next.filter((item) => prevIds.has(item.id))
  for (let i = 0; i < prevSharedOrder.length; i++) {
    if (prevSharedOrder[i].id !== nextSharedOrder[i].id) return 'different'
  }
  return 'edited'
}
