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
  /** The daemon's identity for the item — MUST equal lanCacheContentKey(...),
   *  which is what stream:resolve's tier-2 lookup asks the daemon with. For
   *  anime this is NOT cacheContentKey's shape: the season is dropped. */
  contentKey: string
  title: string
  /**
   * WHY this title is wanted, which the two loops below already distinguish
   * and previously threw away.
   *
   * 'watching' — the next episode of something somebody is partway through.
   * 'prefetch' — from a watchlist: wanted, but not being watched right now.
   *
   * It travels to the daemon on the job so the cache list can say what each
   * entry is doing there. A queue with no reason attached cannot explain
   * itself, and "why is this on my server" is the first question anybody
   * asks of it.
   */
  reason: 'watching' | 'prefetch'
}

/** How many episodes ahead of the last watched one to warm. */
const EPISODES_AHEAD = 2
/** Wanted-list ceiling, so a huge watchlist cannot turn every pass into a
 *  hundred catalog keys. Tracked items are taken newest-first. */
const MAX_WANTED = 30

/**
 * The single source of the LAN-tier contentKey, used by both the feeder
 * below and stream:resolve's tier-2 lookup, so the two cannot disagree on
 * what a title is called on the daemon.
 *
 * Kitsu ids are already season-scoped, so anime is addressed
 * `kitsuId::episode` on the daemon: the season segment is empty whatever
 * season the caller holds. Movies are `id::`, series `id:season:episode`.
 *
 * This deliberately differs from streamCache.ts's cacheContentKey (tier 1,
 * the local cache), which keeps the season for anime.
 *
 * Returns '' when there is no id, which no daemon entry ever matches.
 */
export function lanCacheContentKey(input: {
  catalogId: string
  kind: string
  seasonNumber?: number | null
  episodeNumber?: number | null
}): string {
  // String(): the resolver's input arrives over IPC unvalidated, and a
  // malformed payload must produce a miss, not a throw.
  const id = String(input.catalogId ?? '')
    .trim()
    .toLowerCase()
  if (!id) return ''
  const season = input.kind === 'anime' || input.seasonNumber == null ? '' : input.seasonNumber
  const episode = input.episodeNumber == null ? '' : input.episodeNumber
  return `${id}:${season}:${episode}`
}

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
    if (!entry.contentKey) return
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
        // Anime addressing: kitsuId:episode, no season segment. Kitsu ids
        // are season-scoped, so the key drops the season, matching the
        // resolver's tier-2 lookup (the local-cache tier keeps the season).
        push({
          type: entry.type,
          resolveId: `${entry.id}:${nextEpisode}`,
          contentKey: lanCacheContentKey({
            catalogId: entry.id,
            kind: entry.type,
            seasonNumber: null,
            episodeNumber: nextEpisode
          }),
          title: entry.title ?? '',
          reason: 'watching'
        })
      } else {
        push({
          type: entry.type,
          resolveId: `${entry.id}:${position.season}:${nextEpisode}`,
          contentKey: lanCacheContentKey({
            catalogId: entry.id,
            kind: entry.type,
            seasonNumber: position.season,
            episodeNumber: nextEpisode
          }),
          title: entry.title ?? '',
          reason: 'watching'
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
        contentKey: lanCacheContentKey({ catalogId: item.id, kind: 'movie' }),
        title: item.title,
        reason: 'prefetch'
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
          contentKey: lanCacheContentKey({
            catalogId: item.id,
            kind: item.type,
            seasonNumber: null,
            episodeNumber: episode
          }),
          title: item.title,
          reason: 'prefetch'
        })
      } else {
        const season = position?.season ?? 1
        push({
          type: item.type,
          resolveId: `${item.id}:${season}:${episode}`,
          contentKey: lanCacheContentKey({
            catalogId: item.id,
            kind: item.type,
            seasonNumber: season,
            episodeNumber: episode
          }),
          title: item.title,
          reason: 'prefetch'
        })
      }
    }
  }

  return wanted
}
