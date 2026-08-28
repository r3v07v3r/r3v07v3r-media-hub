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
 * Ids are unique within a list (see hooks.ts's dedupeById), so the
 * position-wise comparison is exact. Costs one pass, and only when the
 * array identity already differed.
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
  let shared = 0
  for (const item of next) {
    if (prevIds.has(item.id)) shared++
  }
  return shared / Math.min(prev.length, next.length) >= SAME_LIST_OVERLAP ? 'edited' : 'different'
}
