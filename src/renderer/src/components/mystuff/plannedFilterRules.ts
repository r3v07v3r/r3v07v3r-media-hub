// The state and the rules behind the Planned filter bar.
//
// Split from the component that draws it because a file exporting both
// components and plain functions loses fast refresh, and this pair is
// edited together often enough for that to matter.

import type { MediaItem } from '@renderer/types'
import type { PlannedServiceId } from '@shared/media-hub/types'

export interface PlannedFilterState {
  kind: 'all' | 'movie' | 'series' | 'anime'
  genre: string | null
  minRating: number | null
  /** Which service a title came from, or 'here' for anything marked in
   *  this app and nowhere else. */
  source: 'all' | PlannedServiceId | 'here'
}

export const EMPTY_PLANNED_FILTERS: PlannedFilterState = {
  kind: 'all',
  genre: null,
  minRating: null,
  source: 'all'
}

/**
 * The kind a filter should judge an item by.
 *
 * mediaType collapses anime into series (see MediaItem), so anything that
 * wants to tell the three apart has to prefer mediaKind and fall back —
 * and it is worth one function rather than the same ternary at every site
 * that asks.
 */
export function kindOf(media: MediaItem): 'movie' | 'series' | 'anime' {
  if (media.mediaKind) return media.mediaKind
  return media.mediaType === 'movie' ? 'movie' : 'series'
}

export function applyPlannedFilters(
  items: MediaItem[],
  filters: PlannedFilterState,
  sources: Record<string, PlannedServiceId[]>
): MediaItem[] {
  return items.filter((media) => {
    if (filters.kind !== 'all' && kindOf(media) !== filters.kind) return false
    if (filters.genre && !media.genres?.includes(filters.genre)) return false
    if (filters.minRating !== null) {
      const rating = media.imdbRating ?? media.communityRating
      // An unrated title fails a rating floor rather than passing it. The
      // filter is read as "at least this good", and nothing is not.
      if (rating === undefined || rating < filters.minRating) return false
    }
    if (filters.source !== 'all') {
      const on = sources[media.id] ?? []
      if (filters.source === 'here' ? on.length > 0 : !on.includes(filters.source)) return false
    }
    return true
  })
}
