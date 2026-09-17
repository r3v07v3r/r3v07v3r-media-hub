// Which episodes of a title have not come out yet, when the date alone
// cannot say.
//
// Cinemeta, TMDB and Kitsu all list episodes that have not aired — with a
// date when the schedule is known, and with no date at all when it is not:
// a season announced but unscheduled, or a Kitsu title whose /episodes
// resource has nothing yet, so its list is normalizeKitsuAnime's
// count-only placeholders. hasAired reads a missing date as "aired" (a
// metadata gap must not hide real episodes), which is right for a gap in
// the middle of a finished show and wrong for the tail of one still airing:
// the detail page offered a Play button for next week's episode, and the
// stream search found nothing and gave up.
//
// Two sources of "not yet", applied in this order:
//
//   1. The list's own shape (markUpcomingEpisodes). In a title that is
//      still running, an undated episode after the last dated one that has
//      aired is upcoming. In any title, an undated episode after a
//      future-dated one is upcoming too; in a title its source says has
//      not started, every undated episode is. Every other undated episode
//      stays what it always was: a gap, presumed aired.
//   2. AniList's airing schedule (applyAiringSchedule), anime only: the
//      exact episode number airing next, and an instant for every scheduled
//      episode after it. It overrides rule 1 for the season it covers — it
//      is the broadcaster's schedule, not an inference from the list.
//
// The verdict lands on Episode.upcoming, and a learned instant on
// Episode.released. Consumers read the DATE first and the flag only when
// there is no date (hasAired, isUpcomingEpisode): a date is time-sensitive
// and flips by itself the moment it passes, while the flag was decided when
// the metadata was assembled and only says what was true then.
//
// Pure — no clock unless injected, no Electron — so the rules are unit
// tested (tests/upcomingEpisodes.test.ts) and shared verbatim between main,
// which assembles the list, and the renderer, which draws it.

import { isRegularEpisode } from './catalog-logic'
import { releaseInstant } from './releaseDate'
import type { Episode } from './types'

/** A title that is no longer producing episodes — Kitsu's `finished`,
 *  Cinemeta/TheTVDB's `Ended`, TMDB's `Ended`/`Canceled`. Any other
 *  non-empty status (`current`, `Continuing`, `upcoming`, …) reads as still
 *  running; an EMPTY status reads as unknown, which is not the same thing. */
export function isFinishedStatus(status: string | undefined | null): boolean {
  return /^(finished|ended|completed|cancell?ed)$/i.test(String(status ?? '').trim())
}

/** A title its source says has not started — Kitsu's `upcoming`,
 *  `unreleased` and `tba`, or an "Upcoming"/"Not yet released" from
 *  elsewhere. Not one episode of it has aired, whatever its list says. */
export function isNotStartedStatus(status: string | undefined | null): boolean {
  return /^(upcoming|unreleased|tba|not[ _-]?yet[ _-]?released)$/i.test(String(status ?? '').trim())
}

/** The instant an episode's `released` names, or null for none/unparseable
 *  — the same parse hasAired and the renderer's tile apply
 *  (shared/media-hub/releaseDate.ts), so the three can never disagree
 *  about whether a date is a date, or which day a bare date means. */
function releasedAt(video: { released?: string }): number | null {
  return releaseInstant(video.released)
}

function byPosition(a: Episode, b: Episode): number {
  return a.season - b.season || a.episode - b.episode
}

/** Sets or clears the flag without disturbing anything else on the
 *  episode. Cleared means REMOVED, not `false`: the metadata cache stores
 *  these as JSON, and a `false` on every episode of every title is bytes
 *  for nothing. An episode that keeps its verdict keeps its identity. */
function withUpcoming(video: Episode, upcoming: boolean): Episode {
  if (upcoming) return video.upcoming === true ? video : { ...video, upcoming: true }
  if (video.upcoming === undefined) return video
  const rest = { ...video }
  delete rest.upcoming
  return rest
}

export interface MarkUpcomingOptions {
  /** The title's own status string, as its source gave it — or, for a
   *  grouped anime, its LAST member's (see episodeAiring.ts): the one
   *  season that can still be airing has its own status, and the
   *  canonical member's says nothing about it. */
  status?: string | null
  /** The season `status` speaks for, when it is one member's rather than
   *  the whole title's. A not-started status then flags undated episodes
   *  from that season on only: the earlier seasons are other members',
   *  long finished, and their dateless placeholders are gaps, not the
   *  future. Unset, the status is the whole title's. */
  statusSeason?: number
  /** Injectable so a test can pin the clock. */
  now?: number
}

/**
 * Rule 1: decides `upcoming` for every undated regular episode from the
 * shape of the list, and clears it from every other. Idempotent — the
 * verdict is recomputed from dates and status each time, so running it over
 * a list that already carries flags (a cached title) is the same as running
 * it over one that does not.
 *
 * Only undated episodes are ever flagged. A dated episode is judged by its
 * date, which is both more precise and self-correcting (see the header).
 * Specials and synthetic entries (isRegularEpisode) are never touched: they
 * are outside the numbered run the walk reasons about.
 */
export function markUpcomingEpisodes(
  videos: readonly Episode[] | undefined | null,
  options: MarkUpcomingOptions = {}
): Episode[] {
  const list = videos ?? []
  const now = options.now ?? Date.now()
  const status = String(options.status ?? '').trim()
  const running = status !== '' && !isFinishedStatus(status)
  // A title that has not started has nothing aired: every undated episode
  // is upcoming, with no aired boundary needed to reason from. This is
  // what keeps a premiere's count-only placeholders off the Play button
  // when the schedule (rule 2) cannot be read.
  const notStarted = isNotStartedStatus(status)
  const notStartedFrom = options.statusSeason ?? Number.NEGATIVE_INFINITY

  const regular = list
    .filter((v) => isRegularEpisode(v) && Number.isFinite(v.season) && Number.isFinite(v.episode))
    .slice()
    .sort(byPosition)

  // The boundary: the last episode that is dated AND has aired. Everything
  // after it is, by construction, undated or in the future.
  let lastAired = -1
  regular.forEach((v, i) => {
    const at = releasedAt(v)
    if (at !== null && at <= now) lastAired = i
  })

  const upcoming = new Set<Episode>()
  let seenFuture = false
  regular.forEach((v, i) => {
    const at = releasedAt(v)
    if (at !== null) {
      if (at > now) seenFuture = true
      return
    }
    // Undated. After a future-dated episode it cannot have aired, whatever
    // the title's status says. After the last aired episode it has not
    // aired either — but only when the title is known to still be running:
    // a finished show with a dateless tail is a gap in the record, and
    // hiding real episodes behind "TBA" would be worse than the old
    // behaviour. No aired episode at all (a placeholder list with no dates
    // anywhere) leaves nothing to reason from; rule 2 handles that for
    // anime, and nothing else can.
    if (
      (notStarted && v.season >= notStartedFrom) ||
      seenFuture ||
      (running && lastAired !== -1 && i > lastAired)
    ) {
      upcoming.add(v)
    }
  })

  return list.map((v) => withUpcoming(v, upcoming.has(v)))
}

/** One season's broadcast schedule, as anilist.ts reads it off AniList. */
export interface AiringSchedule {
  /** AniList's own MediaStatus — RELEASING, FINISHED, NOT_YET_RELEASED,
   *  CANCELLED or HIATUS — or null when it gave none. */
  status: string | null
  /** The episode number airing next, or null when nothing is scheduled
   *  (finished, on hiatus, or simply not yet announced). */
  nextEpisode: number | null
  /** ISO instants for the scheduled, not-yet-aired episodes, by episode
   *  number. Keys are numbers in code and strings once JSON-cached; both
   *  index the same way. */
  airDates: Record<number, string>
  /** When AniList was first seen reporting this `status`, carried forward
   *  across re-reads while the status holds (anilist.ts). What a halted
   *  title's dates are judged against: nothing airs after a cancellation
   *  or into a hiatus, so an episode dated later than this never did —
   *  whatever the clock says now. Absent on rows cached before it existed;
   *  the clock stands in then. */
  since?: number
}

/**
 * Rule 2: overrides rule 1 for one season with what the broadcaster's
 * schedule says. Episode numbers on AniList count within the entry, exactly
 * as Kitsu's do within a title and a TMDB season's do within the season, so
 * `season` is the one whose episodes are numbered the way the schedule is.
 *
 *   - A scheduled instant replaces whatever date the episode had: AniList's
 *     is the exact broadcast moment, where Kitsu's is a calendar day.
 *   - With a next episode named, everything from it onward is upcoming and
 *     everything before it has aired — whatever rule 1 concluded. An
 *     episode from it onward that still carries a date behind now which
 *     the schedule did not supply (the season's source dated it before a
 *     postponement) loses that date and is flagged; an instant the
 *     schedule supplied is kept, and judges itself once it passes.
 *   - FINISHED clears every flag in the season, and touches no date: a
 *     status is the title's word, not an episode's, and a FINISHED entered
 *     a little early on a community-edited database must not turn a
 *     finale still dated ahead into a Play button.
 *   - NOT_YET_RELEASED with no schedule flags every episode, and clears a
 *     date already behind now — a premiere pushed back after the season's
 *     source dated it, which would otherwise read as aired. A date still
 *     ahead is kept.
 *   - An episode the schedule names as aired — below the next one to air
 *     — loses a date still ahead of now. That date came from an earlier
 *     read (or from Kitsu) and the broadcast has since been moved
 *     earlier; a date wins over the flag everywhere else, so left in
 *     place it would keep the tile blocked and the episode out of the
 *     aired count until the old instant passed. Cleared, the episode is
 *     dateless and unflagged: aired, as the schedule says — and, until a
 *     later read dates it, absent from the calendar's window, which reads
 *     dates only. The old date was wrong and the new one is unknown; no
 *     date is the truthful state.
 *   - CANCELLED and HIATUS say nothing about which undated episodes are
 *     out, so rule 1's verdict stands for those. But nothing airs after a
 *     cancellation or into a hiatus, so an episode DATED later than the
 *     moment AniList first reported the halt (`since`) never aired: its
 *     date — a broadcast that was scheduled and then pulled — goes, and
 *     it is flagged. Judged against `since`, not the clock, because a
 *     cancelled title is never read again (see episodeAiring.ts) and its
 *     pulled dates would otherwise "pass" and read as aired.
 *
 * As with rule 1, only an undated episode ends up carrying the flag; a
 * dated one is judged by its date — the two cases above that remove a date
 * are the only ways this function changes what a date says. `now` is
 * injectable for the tests.
 */
export function applyAiringSchedule(
  videos: readonly Episode[] | undefined | null,
  season: number,
  schedule: AiringSchedule,
  now: number = Date.now()
): Episode[] {
  const finished = schedule.status === 'FINISHED'
  const notStarted = schedule.status === 'NOT_YET_RELEASED'
  const halted = schedule.status === 'CANCELLED' || schedule.status === 'HIATUS'
  const haltedAt = schedule.since ?? now
  return (videos ?? []).map((v) => {
    if (!isRegularEpisode(v) || v.season !== season || !Number.isFinite(v.episode)) return v
    const scheduled = schedule.airDates[v.episode]
    const dated = scheduled && scheduled !== v.released ? { ...v, released: scheduled } : v

    if (finished) return withUpcoming(dated, false)

    // An episode the schedule says has NOT aired, carrying a date already
    // behind now that the schedule did not supply: the season's source
    // dated it before a postponement, and left in place the date would
    // read as aired. It goes, and the episode is flagged. An instant the
    // schedule itself supplied is never stale this way — once it passes,
    // the episode really has aired, and blocking it until the schedule
    // cache refreshed would be the old bug in reverse.
    const notYet = (): Episode => {
      const at = releasedAt(dated)
      const stale = at !== null && at <= now && !scheduled
      return withUpcoming(stale ? { ...dated, released: '' } : dated, at === null || stale)
    }

    if (schedule.nextEpisode !== null) {
      if (v.episode >= schedule.nextEpisode) return notYet()
      const at = releasedAt(dated)
      const stale = at !== null && at > now
      return withUpcoming(stale ? { ...dated, released: '' } : dated, false)
    }
    // Nothing has aired: every episode is not yet, and a premiere date that
    // passed without a premiere is stale exactly as above.
    if (notStarted) return notYet()
    if (!halted) return dated
    const at = releasedAt(dated)
    return at !== null && at > haltedAt ? withUpcoming({ ...dated, released: '' }, true) : dated
  })
}
