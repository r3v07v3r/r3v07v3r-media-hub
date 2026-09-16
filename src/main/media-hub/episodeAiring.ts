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
  markUpcomingEpisodes
} from '../../shared/media-hub/upcomingEpisodes'
import { anilistAiringSchedule, anilistIdForKitsu } from './anilist'
import { logError } from './logger'
import type { TaskPriority } from './taskScheduler'

/** True when a date-less regular episode sits in `season` — the only
 *  situation the schedule can improve on. Dated episodes are judged by
 *  their dates already (hasAired), and asking AniList about a season whose
 *  every episode carries one would be a request for nothing. */
function seasonHasUndatedEpisode(videos: readonly Episode[], season: number): boolean {
  return videos.some((v) => {
    if (!isRegularEpisode(v) || v.season !== season) return false
    if (!v.released) return true
    return !Number.isFinite(new Date(v.released).getTime())
  })
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
    // the undated-episode gate alone decides there.
    const finished = !item.groupedIds?.length && isFinishedStatus(item.status)
    if (!finished && kitsuId && seasonHasUndatedEpisode(videos, season)) {
      try {
        const anilistId = await anilistIdForKitsu(kitsuId, priority)
        const schedule = anilistId ? await anilistAiringSchedule(anilistId, priority) : null
        if (schedule) videos = applyAiringSchedule(videos, season, schedule)
      } catch (error) {
        logError('anime:episode-airing', error)
      }
    }
  }
  return { ...item, videos }
}
