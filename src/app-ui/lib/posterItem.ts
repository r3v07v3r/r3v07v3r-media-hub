import type { CatalogItem, MediaKind, TrackedItem } from '@shared/media-hub/types'

/** The small, display-only shape every poster row/grid in this app renders
 *  from — a deliberately thin slice of CatalogItem (never the whole thing)
 *  so a poster card doesn't have to know which backend shape it came from. */
export interface PosterItem {
  id: string
  kind: MediaKind
  title: string
  poster?: string
  /** A second line under the title — used by Home's Continue Watching row
   *  to show "S2 E4"; absent everywhere else. */
  subtitle?: string
}

export function toPosterItem(item: CatalogItem): PosterItem {
  return {
    id: item.id,
    kind: item.type,
    title: item.title,
    poster: item.poster || undefined
  }
}

/** The same slice from a tracked row — Home's Plan to Watch. A title a
 *  watchlist pull added can arrive as a name and a year with an empty
 *  poster, which the card must read as "no artwork", not as an image URL. */
export function trackedToPosterItem(item: TrackedItem): PosterItem {
  return {
    id: item.id,
    kind: item.type,
    title: item.title,
    poster: item.poster || undefined
  }
}
