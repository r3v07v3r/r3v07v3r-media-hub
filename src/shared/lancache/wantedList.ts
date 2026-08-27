// The pure half of the cache-server feeder: which titles are worth
// holding on-site right now, given the watchlist and history. Lives in
// shared/ so it is testable without Electron and so the addressing rules
// (movie/series/anime contentKeys) sit next to the protocol they feed.

import type { HistoryEntry, TrackedItem } from '../media-hub/types'

export interface WantedTitle {
  /** movie | series | anime — the add-on route segment. */
  type: string
  /** The id the scrapers are asked about (movie id, id:s:e, kitsuId:e). */
  resolveId: string
  /** The daemon's identity for the item — MUST equal what play:stream
   *  stores on a cache session (cacheContentKey's shape) so all the tiers
   *  agree on what "this title" means. */
  contentKey: string
  title: string
}

/** How many episodes ahead of the last watched one to warm. */
const EPISODES_AHEAD = 2
/** Wanted-list ceiling, so a huge watchlist cannot turn every pass into a
 *  hundred catalog keys. Tracked items are taken newest-first. */
const MAX_WANTED = 30

const key = (id: string, season: number | '', episode: number | ''): string =>
  `${id.trim().toLowerCase()}:${season}:${episode}`

/**
 * Pure: the titles worth holding on the cache server right now, given the
 * watchlist and history. Exported for tests.
 */
export function computeWantedList(
  tracked: readonly TrackedItem[],
  history: readonly HistoryEntry[]
): WantedTitle[] {
  const wanted: WantedTitle[] = []
  const seen = new Set<string>()
  const push = (entry: WantedTitle): void => {
    if (seen.has(entry.contentKey) || wanted.length >= MAX_WANTED) return
    seen.add(entry.contentKey)
    wanted.push(entry)
  }

  // Last watched position per series/anime, from history (newest first).
  const lastSeen = new Map<string, { season: number | null; episode: number | null }>()
  for (const entry of history) {
    if (entry.episode === null) continue
    const prev = lastSeen.get(entry.id)
    const better =
      !prev ||
      (entry.season ?? 0) > (prev.season ?? 0) ||
      ((entry.season ?? 0) === (prev.season ?? 0) && (entry.episode ?? 0) > (prev.episode ?? 0))
    if (better) lastSeen.set(entry.id, { season: entry.season, episode: entry.episode })
  }

  // 1. Recently watched episodic titles first: the next episode of the show
  //    someone is actively in is the likeliest play of all.
  for (const entry of history.slice(0, 10)) {
    if (entry.episode === null) continue
    const position = lastSeen.get(entry.id)
    if (!position || position.episode === null) continue
    for (let ahead = 1; ahead <= EPISODES_AHEAD; ahead++) {
      const nextEpisode = position.episode + ahead
      if (entry.type === 'anime' || position.season === null) {
        // Anime addressing: kitsuId:episode, no season segment — the same
        // special case startPlayback and the local-cache tier handle.
        push({
          type: entry.type,
          resolveId: `${entry.id}:${nextEpisode}`,
          contentKey: key(entry.id, '', nextEpisode),
          title: entry.title ?? ''
        })
      } else {
        push({
          type: entry.type,
          resolveId: `${entry.id}:${position.season}:${nextEpisode}`,
          contentKey: key(entry.id, position.season, nextEpisode),
          title: entry.title ?? ''
        })
      }
    }
  }

  // 2. The watchlist. Movies are themselves; episodic titles get their
  //    next episodes (episode 1 when never started).
  for (const item of tracked) {
    if (item.type === 'movie') {
      push({
        type: 'movie',
        resolveId: item.id,
        contentKey: key(item.id, '', ''),
        title: item.title
      })
      continue
    }
    const position = lastSeen.get(item.id)
    const startEpisode = (position?.episode ?? 0) + 1
    for (let ahead = 0; ahead < EPISODES_AHEAD; ahead++) {
      const episode = startEpisode + ahead
      if (item.type === 'anime' || (position && position.season === null)) {
        push({
          type: item.type,
          resolveId: `${item.id}:${episode}`,
          contentKey: key(item.id, '', episode),
          title: item.title
        })
      } else {
        const season = position?.season ?? 1
        push({
          type: item.type,
          resolveId: `${item.id}:${season}:${episode}`,
          contentKey: key(item.id, season, episode),
          title: item.title
        })
      }
    }
  }

  return wanted
}
