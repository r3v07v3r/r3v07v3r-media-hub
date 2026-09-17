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
import { isDateOnly, releaseInstant } from '../../shared/media-hub/releaseDate'
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

/** The regular episodes of one season. */
function seasonEpisodes(videos: readonly Episode[], season: number): Episode[] {
  return videos.filter((v) => isRegularEpisode(v) && v.season === season)
}

/**
 * Whether AniList's schedule may be applied to this season at all — i.e.
 * whether the season's episodes are numbered the way the schedule's are.
 *
 * The schedule is read for the season's Kitsu member, and AniList numbers
 * that entry's episodes from 1 exactly as Kitsu's own /episodes and
 * normalizeKitsuAnime's placeholders do. A season buildGroupedAnimeVideos
 * took from TMDB instead is numbered TMDB's way, which need not agree: TMDB
 * models a two-cour show as one 24-episode season where Kitsu and AniList
 * have two 12-episode entries, so "episode 13 airs next" means different
 * episodes on the two lists — and a FINISHED for the first cour, applied
 * to the TMDB season, would wipe the second cour's real dates and offer
 * Play for episodes that have not aired.
 *
 * An UNGROUPED title has only ever one source, Kitsu, whose numbering the
 * schedule shares — so for it (`kitsuNumbered`) the schedule applies to any
 * season with episodes at all, and Kitsu's own calendar days are exactly
 * what it should refine into broadcast instants and correct after a delay.
 *
 * For a grouped title the season's source is not known here, and the tell
 * is the dates themselves. A bare calendar day comes from the season's own
 * source (Kitsu's airdate, TMDB's air_date); an ISO instant is one this
 * module learned from AniList. So the schedule applies when the season has
 * something only it can settle — an undated episode, or an instant it
 * wrote before — and never when the season's own source still dates an
 * episode ahead of now: that source has its own numbering and its own
 * plan, and the schedule must not overrule it. A season whose every date
 * is its own and in the past is settled either way. Exported for its tests.
 */
export interface SeasonNumbering {
  /** The season's episodes are numbered the way the schedule's are — true
   *  for an ungrouped title, whose only source is Kitsu. */
  kitsuNumbered?: boolean
}

export function seasonAcceptsSchedule(
  videos: readonly Episode[],
  season: number,
  now: number = Date.now(),
  numbering: SeasonNumbering = {}
): boolean {
  if (numbering.kitsuNumbered) return seasonEpisodes(videos, season).length > 0
  let evidence = false
  for (const v of seasonEpisodes(videos, season)) {
    const at = releaseInstant(v.released)
    if (at === null) {
      evidence = true
      continue
    }
    if (isDateOnly(v.released)) {
      if (at > now) return false
      continue
    }
    evidence = true
  }
  return evidence
}

/**
 * True while a regular episode of `season` has still to air by what the
 * schedule can speak to — no usable date at all, or an AniList instant
 * ahead of now. The first of the two reasons the schedule is worth asking
 * for (see scheduleWorthAsking): it can date a placeholder, and it can
 * MOVE an instant it gave last time (a delayed broadcast), which is why a
 * season whose every remaining episode already carries one keeps being
 * checked against the 12h schedule cache until the last one is out. A
 * bare calendar day ahead of now is the season's own source's plan, not
 * this module's to refresh — unless that source is Kitsu on an ungrouped
 * title (`kitsuNumbered`), whose day the schedule is exactly the thing to
 * sharpen into a broadcast instant; see seasonAcceptsSchedule. Exported
 * for its tests.
 */
export function seasonStillAiring(
  videos: readonly Episode[],
  season: number,
  now: number = Date.now(),
  numbering: SeasonNumbering = {}
): boolean {
  return seasonEpisodes(videos, season).some((v) => {
    const at = releaseInstant(v.released)
    if (at === null) return true
    return (numbering.kitsuNumbered || !isDateOnly(v.released)) && at > now
  })
}

/** AniList's word that nothing more will air on this entry. */
export function isTerminalSchedule(last: AiringSchedule | null): last is AiringSchedule {
  return last?.status === 'FINISHED' || last?.status === 'CANCELLED'
}

/**
 * Whether to read the schedule afresh (from its 12h cache, or AniList) for
 * a season AniList has NOT called finished. (A finished or cancelled entry
 * is re-read on its own, weekly, cadence — see withUpcomingEpisodes.)
 *
 * Only for a season the schedule can be applied to (seasonAcceptsSchedule);
 * then either reason is sufficient:
 *
 *   - The list says the season is still airing (seasonStillAiring).
 *   - AniList itself last said the title was not finished. This is what
 *     catches a postponed finale: the stored instant passes, the list
 *     reads as fully aired, and by the first reason alone nothing would
 *     ever ask again — the finale would count as out, and Play would
 *     search for a stream that is not there, until the metadata entry
 *     expired (or forever, when Kitsu keeps the old date). The last read,
 *     expired or not, still says RELEASING, so the next read happens, and
 *     it carries the new instant. A finished title costs one request after
 *     its finale, then one a week while it is opened.
 *
 * Pure — the caller supplies what the cache last held — so it is tested.
 */
export function scheduleWorthAsking(
  videos: readonly Episode[],
  season: number,
  last: AiringSchedule | null,
  now: number = Date.now(),
  numbering: SeasonNumbering = {}
): boolean {
  // Read once: isTerminalSchedule is a type guard, and past its early
  // return TypeScript would narrow `last` to never.
  const status = last?.status ?? null
  if (status === 'FINISHED' || status === 'CANCELLED') return false
  if (!seasonAcceptsSchedule(videos, season, now, numbering)) return false
  if (seasonStillAiring(videos, season, now, numbering)) return true
  return status !== null
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
    const grouped = Boolean(item.groupedIds?.length)
    const { season, kitsuId } = airingSeason(item)
    // An ungrouped title's only source is Kitsu, so its season is numbered
    // the way the schedule is (seasonAcceptsSchedule); a grouped title's
    // last season may be TMDB's, and is judged by its dates.
    const numbering: SeasonNumbering = { kitsuNumbered: !grouped }
    // An ungrouped title's Kitsu status is its own and is trusted: a
    // finished show has nothing airing next, whatever its dates say, so it
    // is never ASKED about. (What AniList said before still applies below
    // — a cancelled title's pulled dates must stay pulled across the
    // metadata refresh that would otherwise restore them.) A grouped
    // title's status is season 1's (normalizeKitsuAnime of the canonical
    // member), which says nothing about the last season — so the gate
    // alone decides there.
    const settledByKitsu = !grouped && isFinishedStatus(item.status)
    if (kitsuId) {
      try {
        // Cache reads only, until the gate says to ask: an AniList id the
        // crawl never mapped is not looked up (a Kitsu request, once per
        // 30 days) for a title with nothing left to air.
        const known = cachedAnilistId(kitsuId)
        const last = known ? lastKnownAiringSchedule(known) : null
        if (isTerminalSchedule(last) && known) {
          // Nothing left to air — but what AniList said still applies
          // where the season accepts it: it clears any flag rule 1 raised
          // on dateless placeholders, and for a cancelled title it keeps
          // the pulled dates pulled. Re-read on the settled cadence
          // (anilist.ts's SETTLED_TTL_MS: the row is served from cache
          // until then), so a premature FINISHED corrects itself within a
          // week of the title being opened rather than never; a failed
          // re-read falls back to the last one.
          if (seasonAcceptsSchedule(videos, season, Date.now(), numbering)) {
            const schedule = (await anilistAiringSchedule(known, priority)) ?? last
            videos = applyAiringSchedule(videos, season, schedule)
          }
        } else if (
          !settledByKitsu &&
          scheduleWorthAsking(videos, season, last, Date.now(), numbering)
        ) {
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
