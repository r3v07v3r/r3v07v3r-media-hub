// Keeps a title the person just acted on where it was in the home feed.
//
// The stored recommendations are re-filtered against the plan, the watch
// history and the dislikes every time home:personalized answers
// (recommendations.ts's keepStored), so that a decision takes effect at
// once. That is right for the next visit and wrong for the card being
// clicked: a title planned, marked watched or marked Not interested from
// Home's Recommended row, a For You rail or the hero left on the next
// refresh, before its new badge could be seen or the click taken back, and
// on the hero the next title slid into its slot.
//
// AppStateContext records the ids toggleMyList, setTitleStatus and
// toggleDisliked touch, with what the change did to the title's own flags,
// and clears them when the route changes. useMediaHubHomeFeed passes each
// fresh feed through holdTouchedEntries, which puts those titles back at
// the index they had in the feed on screen. The route change also
// refetches, so the next visit shows the ranking as it stands.

import type { HomeRail, MediaItem, Recommendation } from '@renderer/types'

/** What a change is known to have done to a title's own flags, applied to
 *  the held copy: the copy was built before the change, and a title that
 *  has left the ranking is no longer in the feed's completion answer. */
export type HeldChange = Partial<Pick<MediaItem, 'watched' | 'completed'>>

export interface HoldableFeed {
  recommendations: Recommendation[]
  featured: MediaItem[]
  rails: HomeRail[]
}

/**
 * `next`, with every entry of `previous` whose id is held put back at the
 * index it had there. A held title that is also in `next` (a continuation
 * survives a plan) takes its old position, with the fresh copy. Entries not
 * held keep their order, and a held id that was not on screen before is
 * left where `next` put it.
 */
export function holdEntries<T>(
  previous: readonly T[],
  next: readonly T[],
  held: ReadonlySet<string>,
  idOf: (entry: T) => string,
  refresh: (entry: T) => T
): T[] {
  const shown = previous.filter((entry) => held.has(idOf(entry)))
  if (shown.length === 0) return [...next]
  const shownIds = new Set(shown.map(idOf))
  const fresh = new Map(next.map((entry) => [idOf(entry), entry]))
  const result = next.filter((entry) => !shownIds.has(idOf(entry)))
  // Ascending, so each insert lands at its old index once the earlier ones
  // are back in place.
  previous.forEach((entry, index) => {
    const id = idOf(entry)
    if (!shownIds.has(id)) return
    result.splice(Math.min(index, result.length), 0, refresh(fresh.get(id) ?? entry))
  })
  return result
}

/**
 * The fresh feed with the held titles back in the recommendations, the
 * hero's pool and the For You rails. A held copy takes its plan state from
 * the fresh answer's tracked ids and its watched state from the recorded
 * change. A rail the fresh feed no longer has is not brought back.
 */
export function holdTouchedEntries<F extends HoldableFeed>(
  previous: HoldableFeed,
  next: F,
  held: ReadonlyMap<string, HeldChange>,
  trackedIds: ReadonlySet<string>
): F {
  if (held.size === 0) return next
  const ids = new Set(held.keys())
  const patch = (media: MediaItem): MediaItem => ({
    ...media,
    ...held.get(media.id),
    inMyList: trackedIds.has(media.id)
  })
  const previousRails = new Map(previous.rails.map((rail) => [rail.id, rail]))
  return {
    ...next,
    recommendations: holdEntries(
      previous.recommendations,
      next.recommendations,
      ids,
      (rec) => rec.media.id,
      (rec) => ({ ...rec, media: patch(rec.media) })
    ),
    featured: holdEntries(previous.featured, next.featured, ids, (media) => media.id, patch),
    rails: next.rails.map((rail) => {
      const before = previousRails.get(rail.id)
      if (!before) return rail
      const items = holdEntries(before.items, rail.items, ids, (media) => media.id, patch)
      return items.length === rail.items.length && items.every((m, i) => m === rail.items[i])
        ? rail
        : { ...rail, items }
    })
  }
}
