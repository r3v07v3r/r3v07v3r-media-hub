// Stamps "not aired yet" onto a resolved title's episode list — the
// main-process hands for the rules in shared/media-hub/upcomingEpisodes.ts,
// which are pure and say what to conclude; this is the part that knows
// where the title came from and can ask AniList.
//
// Applied by catalog.ts's resolveMetadata on BOTH paths, fresh fetch and
// cache hit, the same way withCredits is: rule 1 is a cheap pure pass that
// is idempotent over its own output, and rule 2's schedule has its own,
// shorter cache than the title (AIRING_TTL_MS in anilist.ts), so an episode
// list a day old still learns that this week's episode landed.

import type { CatalogItem, Episode } from '../../shared/media-hub/types'
import { isRegularEpisode } from '../../shared/media-hub/catalog-logic'
import {
  applyAiringSchedule,
  isFinishedStatus,
  markUpcomingEpisodes,
  type AiringSchedule
} from '../../shared/media-hub/upcomingEpisodes'
import {
  anilistAiringSchedule,
  anilistIdForKitsu,
  cachedAnilistId,
  lastKnownAiringSchedule
} from './anilist'
import { logError } from './logger'
import type { TaskPriority } from './taskScheduler'

/**
 * True while a regular episode of `season` has still to air — no usable
 * date at all, or a date ahead of now. The first of the two reasons the
 * schedule is worth asking for (see scheduleWorthAsking): it can date a
 * placeholder, and it can MOVE a date it gave last time (a delayed
 * broadcast), which is why a season whose every remaining episode already
 * carries an AniList instant keeps being checked against the 12h schedule
 * cache until the last one is out. Exported for its tests.
 */
export function seasonStillAiring(
  videos: readonly Episode[],
  season: number,
  now: number = Date.now()
): boolean {
  return videos.some((v) => {
    if (!isRegularEpisode(v) || v.season !== season) return false
    if (!v.released) return true
    const at = new Date(v.released).getTime()
    return !Number.isFinite(at) || at > now
  })
}

/** AniList's word that nothing more will air on this entry. */
export function isTerminalSchedule(last: AiringSchedule | null): boolean {
  return last?.status === 'FINISHED' || last?.status === 'CANCELLED'
}

/**
 * Whether to read the schedule afresh (from its 12h cache, or AniList) for
 * this season now.
 *
 * Never once AniList has called the entry FINISHED or CANCELLED: nothing
 * more will air, whatever the list looks like — and a grouped franchise
 * whose last season is dateless Kitsu placeholders looks "still airing"
 * forever by the list alone, which would have kept it on the request lane
 * every 12h for good. That last read still gets APPLIED (see
 * withUpcomingEpisodes), so a flag rule 1 raised on such placeholders is
 * cleared exactly as a fresh read would clear it.
 *
 * Otherwise, either reason is sufficient:
 *
 *   - The list says the season is still airing (seasonStillAiring).
 *   - AniList itself last said the title was not finished. This is what
 *     catches a postponed finale: the stored air time passes, the list
 *     reads as fully aired, and by the first reason alone nothing would
 *     ever ask again — the finale would count as out, and Play would
 *     search for a stream that is not there, until the metadata entry
 *     expired (or forever, when Kitsu keeps the old date). The last read,
 *     expired or not, still says RELEASING, so the next read happens, and
 *     it carries the new instant. A finished title costs one request after
 *     its finale, then none.
 *
 * Pure — the caller supplies what the cache last held — so it is tested.
 */
export function scheduleWorthAsking(
  videos: readonly Episode[],
  season: number,
  last: AiringSchedule | null,
  now: number = Date.now()
): boolean {
  if (isTerminalSchedule(last)) return false
  if (seasonStillAiring(videos, season, now)) return true
  return last?.status != null
}

/**
 * The season AniList can speak for, and the Kitsu id that season is on
 * AniList as. Kitsu models each season as its own entry (see
 * CatalogItem.groupedIds), and buildGroupedAnimeVideos numbers a group's
 * seasons by position, so the LAST member is the highest-numbered season —
 * the only one that can still be airing once a sequel exists. An ungrouped
 * title is its own season 1. Episode numbers on that member's AniList entry
 * count from 1 exactly as the season's own do, whether the season's
 * episodes came from Kitsu's /episodes or from normalizeKitsuAnime's
 * placeholders; a TMDB-sourced season carries dates and never gets here.
 */
function airingSeason(item: CatalogItem): { season: number; kitsuId: string } {
  const members = [item.id, ...(item.groupedIds ?? [])]
  const last = members[members.length - 1]
  return { season: members.length, kitsuId: String(last).replace(/^kitsu:/, '') }
}

/**
 * The title with every episode's `upcoming` (and, where AniList knows one,
 * `released`) decided. Never throws: a title whose schedule cannot be read
 * keeps rule 1's verdict, which is the pre-existing behaviour at worst.
 */
export async function withUpcomingEpisodes(
  item: CatalogItem,
  priority: TaskPriority
): Promise<CatalogItem> {
  let videos = markUpcomingEpisodes(item.videos, { status: item.status })
  if (item.type === 'anime' && videos.length) {
    const { season, kitsuId } = airingSeason(item)
    // An ungrouped title's Kitsu status is its own and is trusted: a
    // finished show has nothing airing next, whatever its dates say. A
    // grouped title's status is season 1's (normalizeKitsuAnime of the
    // canonical member), which says nothing about the last season — so
    // the gate alone decides there.
    const finished = !item.groupedIds?.length && isFinishedStatus(item.status)
    if (!finished && kitsuId) {
      try {
        // Cache reads only, until the gate says to ask: an AniList id the
        // crawl never mapped is not looked up (a Kitsu request, once per
        // 30 days) for a title with nothing left to air.
        const known = cachedAnilistId(kitsuId)
        const last = known ? lastKnownAiringSchedule(known) : null
        if (isTerminalSchedule(last)) {
          // Nothing left to air, so nothing to ask — but what it said still
          // applies, clearing any flag rule 1 raised on dateless placeholders.
          videos = applyAiringSchedule(videos, season, last as AiringSchedule)
        } else if (scheduleWorthAsking(videos, season, last)) {
          const anilistId = known ?? (await anilistIdForKitsu(kitsuId, priority))
          // A refresh that fails (AniList down, rate-limited) falls back to
          // the schedule last read, however old: its instants still judge
          // themselves against the clock, and its verdicts are the best
          // there are. With nothing applied at all, a not-yet-released
          // title's undated placeholders — whose cached flags rule 1 has
          // just cleared, having no dated boundary to reason from — would
          // read as aired, and every tile as playable, until AniList came
          // back.
          const schedule =
            (anilistId ? await anilistAiringSchedule(anilistId, priority) : null) ?? last
          if (schedule) videos = applyAiringSchedule(videos, season, schedule)
        }
      } catch (error) {
        logError('anime:episode-airing', error)
      }
    }
  }
  return { ...item, videos }
}
