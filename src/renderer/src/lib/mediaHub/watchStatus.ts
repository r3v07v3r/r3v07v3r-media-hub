import type { ContinueWatchingItem, MediaItem } from '@renderer/types'

export type WatchStatus =
  | { state: 'unwatched' }
  | { state: 'planned' }
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
 *
 * One card is never in `continueWatching` however far through it somebody
 * is: a later season of a merged anime, named by its own id. Continue
 * Watching lists its show, under the show's id. Such a card carries its own
 * progress instead — catalogItemToMediaItem sets `progressPercentage` for a
 * later season and for nothing else — and is in progress by that.
 *
 * 'planned' is the third fact a card can carry (the plan-to-watch list,
 * `inMyList`), and it ranks below the two above: something both planned
 * and seen reads as seen, the same precedence lib/mediaHub/titleStatus.ts
 * gives the status control.
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
  if (media.watched && media.progressPercentage != null) {
    return { state: 'in-progress', progressPercentage: media.progressPercentage }
  }
  if (media.inMyList) return { state: 'planned' }
  return { state: 'unwatched' }
}
