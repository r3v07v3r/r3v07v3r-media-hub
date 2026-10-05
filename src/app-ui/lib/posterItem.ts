import type {
  AnimeTimelineEntry,
  CatalogItem,
  MediaKind,
  TrackedItem
} from '@shared/media-hub/types'
import { mergedSeasonsLabel } from '@shared/media-hub/catalogFields'

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
  /** "3 seasons" on a merged anime's poster — see mergedSeasonsLabel. */
  seasons?: string
}

export function toPosterItem(item: CatalogItem): PosterItem {
  const seasons = mergedSeasonsLabel(
    item.type,
    item.episodeCounts?.totalSeasons ??
      (item.groupedIds?.length ? item.groupedIds.length + 1 : undefined)
  )
  return {
    id: item.id,
    kind: item.type,
    title: item.title,
    poster: item.poster || undefined,
    ...(seasons ? { seasons } : {})
  }
}

/** Kitsu's kinds of entry that are not a TV series, as people say them. */
const EXTRA_KIND: Record<string, string> = {
  movie: 'Film',
  ova: 'OVA',
  ona: 'ONA',
  special: 'Special',
  music: 'Music video'
}

/**
 * The films, OVAs and specials filed with a merged anime, from catalog.story's
 * release-order timeline, each saying where it falls among the show's
 * seasons ("Film · after season 2"). They are titles of their own, not
 * seasons; the seasons themselves are the page's tabs, so they are left out.
 */
export function timelineExtrasToPosterItems(timeline: readonly AnimeTimelineEntry[]): PosterItem[] {
  const items: PosterItem[] = []
  let lastSeason: number | null = null
  for (const entry of timeline) {
    if (entry.season !== undefined) {
      lastSeason = entry.season
      continue
    }
    const kind = EXTRA_KIND[entry.item.subtype ?? '']
    const place = lastSeason === null ? 'before the first season' : `after season ${lastSeason}`
    items.push({
      ...toPosterItem(entry.item),
      subtitle: kind ? `${kind} · ${place}` : place[0].toUpperCase() + place.slice(1)
    })
  }
  return items
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
