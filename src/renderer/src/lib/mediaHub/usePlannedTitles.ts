// The list, on the way to the sofa.
//
// Plan-to-watch is where somebody has already done the deciding — often
// months ago, often in Trakt or Simkl rather than here. Leaving it two
// clicks away in My Stuff meant the thing they had explicitly said they
// wanted to watch was harder to reach than a row of guesses.
//
// This was PlannedRow, a second <section> on Home. It rendered into the
// same grid cell as RecommendationCarousel — it imported that component's
// stylesheet, `grid-area: picks` and all — so the two headings drew on top
// of each other ("Planned" over "Recommended For You", and one "See all"
// over the other) for anyone whose list was non-empty. Home is hard-clipped
// to no scroll and has no room for a fourth row, so the row is now a TAB
// inside that one cell and this is the data half of it.

import { useAppState } from '@renderer/context/AppStateContext'
import { useCatalogByIds } from './useCatalogByIds'
import type { MediaItem } from '@renderer/types'

export function usePlannedTitles(): MediaItem[] {
  const { myList, adaptCatalogItems, catalogKindStates } = useAppState()
  // From the INDEX by id (stage 4): the loaded catalog is a bounded
  // candidate pool now, and a planned title has every right to live
  // outside it — a row that silently dropped those would look like the
  // sync losing titles. Same source My Stuff uses, same adapter — so a
  // title pulled in from a service shows the artwork and ratings this app
  // resolved for it, not the thinner remote record.
  const { items } = useCatalogByIds(
    myList,
    adaptCatalogItems,
    // Refetch when a kind settles — on a fresh database this query can
    // land before the index is seeded, and the early empty answer must
    // not stand once titles exist.
    `${catalogKindStates.movie}:${catalogKindStates.series}:${catalogKindStates.anime}`
  )
  return items
}
