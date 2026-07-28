import type { ContinueWatchingItem, MediaItem } from '@renderer/types'

export type WatchStatus =
  | { state: 'unwatched' }
  | { state: 'in-progress'; progressPercentage: number }
  | { state: 'watched' }
  | { state: 'completed'; progressPercentage: number }

/**
 * Real backend-derived watch status for any MediaItem shown anywhere in the
 * app (grids, My Stuff, mood results) — not just the Continue Watching
 * panel's own list. Combines two real signals rather than inventing a
 * third: `continueWatching` (episode-precise progress, from
 * home:personalized) takes priority when the item is in it; otherwise
 * falls back to the plain catalog item's own `watched`/`completed` flags
 * (from tracking:list's history — see adapters.ts's
 * CatalogItemAdapterContext.watchedIds and hooks.ts's
 * useMediaHubWatchedIds). A movie that's watched shows as "watched" (no
 * meaningful progress fraction to show); a series/anime with all episodes
 * done — which drops out of Continue Watching once there's nothing left to
 * continue — shows as "completed" with a full progress bar, distinguishing
 * "this show is done" from "this movie has been watched" the way the
 * reference design does.
 */
export function getWatchStatus(
  media: MediaItem,
  continueWatching: ContinueWatchingItem[]
): WatchStatus {
  const inProgress = continueWatching.find((c) => c.media.id === media.id)
  if (inProgress) {
    return inProgress.media.completed
      ? { state: 'completed', progressPercentage: 100 }
      : { state: 'in-progress', progressPercentage: inProgress.media.progressPercentage ?? 0 }
  }
  if (media.completed) {
    return media.totalEpisodes != null
      ? { state: 'completed', progressPercentage: 100 }
      : { state: 'watched' }
  }
  return { state: 'unwatched' }
}
