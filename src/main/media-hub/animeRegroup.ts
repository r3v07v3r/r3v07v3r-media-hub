// Keeps anime watch history with its show when the grouping changes.
//
// A merged franchise is one show here: its rows are kept under the id of
// the member that fronts it, at season = the member's position in the group
// (see animeSeasons.ts). Both halves of that address come out of the
// grouping pass, and the pass does not always give the same answer: which
// member fronts a show, and the order of the rest, follow lookups (a
// TheTVDB mapping, AniList's broadcast dates) that are there on one run and
// missing on the next, and a member can enter or leave the crawl. Measured
// against a real library on 2026-10-04: of 286 groups recorded five weeks
// earlier, 62 had changed members or order and 43 were fronted by a
// different id.
//
// Nothing moved the rows when that happened. Under a new front they were
// left under an id no page reads; under a new order they were read as other
// seasons. So the grouping the rows are filed under is now recorded (the
// ledger: database.ts's animeGroupLedger), and when a pass lands a different
// one the two are compared here and the rows are moved.
//
// WHAT A SEASON NUMBER MEANS decides what may move, and it is not one thing.
// buildGroupedAnimeVideos fills season N from TMDB's season N whenever the
// show's first member has a TheTVDB mapping, whichever member sits at N; it
// uses the member's own episodes only when there is no mapping, or TMDB has
// no such season. So:
//
//  - A show with no TheTVDB mapping is numbered by its members. Season N is
//    member N's episodes on the page and in every sync. Its rows follow
//    their member to wherever it is now.
//  - A show with one is numbered by TMDB on the page. A member changing
//    place does not change what season N shows, so its rows stay at their
//    number; moving them by member would shift every watched mark on a page
//    that was right. Only a change of the id itself is followed, season
//    numbers kept. Two more things are followed where the per-entry
//    TheTVDB mappings show where each season goes (placeIsSeason): a show
//    that came apart altogether, and a later season that saved under its
//    own id until its place became its season.
//
// Anything else (a show that gained or lost its mapping between the two
// runs, a lookup that never answered) is left where it is and reported,
// never guessed: a wrong move lands rows on another season's and the
// collision drops them.
//
// No database and no network in the rules, so they can be tested as they
// run. The two functions that touch a database take it as an argument.

import type { CatalogItem } from '../../shared/media-hub/types'
import type { MediaHubDatabase } from './database'

/** One merged show, as the grouping pass left it. */
export interface AnimeGroupRecord {
  /** The id the show is kept under: its first member. */
  id: string
  /** Every member in season order, `id` first. */
  members: string[]
  /**
   * The TheTVDB series of the first member: '' when it has none, so the
   * show is numbered by its members; null when the lookup has never
   * answered, so nothing can be said.
   */
  series: string | null
}

/**
 * One instruction to move rows. Episodes keep their numbers.
 *
 *  - a season onto a season: that season of `fromId` becomes `toSeason` of
 *    `toId`.
 *  - `fromSeason` null, `toSeason` set: `fromId` stood alone, so every row
 *    under it is that one entry's whatever season it carries, and all of
 *    them become `toSeason`. Held back, per profile, for an id whose rows
 *    repeat an episode number across seasons: those are a whole show's, and
 *    only its season 1 is the entry's own (see remapContentIds).
 *  - both null: every row under `fromId` goes under `toId` at the season it
 *    already has.
 */
export interface AnimeHistoryMove {
  fromId: string
  fromSeason: number | null
  toId: string
  toSeason: number | null
  /** One profile only. Absent: every profile, as a regroup is true for all. */
  profileId?: string
}

export interface AnimeRegroupPlan {
  moves: AnimeHistoryMove[]
  /** A rating belongs to the show, so it goes where the show's id went. */
  ratings: { fromId: string; toId: string }[]
  /** Members whose rows could not be placed, and why. */
  left: { id: string; why: string }[]
}

/**
 * The groups in a grouped catalog, in the form the ledger keeps. Sorted, so
 * two passes that agree compare equal whatever order the crawl listed the
 * shows in.
 */
export function animeGroupRecordsOf(
  items: readonly Pick<CatalogItem, 'id' | 'groupedIds'>[],
  seriesOf: (id: string) => string | null
): AnimeGroupRecord[] {
  const groups: AnimeGroupRecord[] = []
  for (const item of items) {
    if (!item.groupedIds?.length) continue
    const id = String(item.id)
    groups.push({ id, members: [id, ...item.groupedIds.map(String)], series: seriesOf(id) })
  }
  return groups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

interface Place {
  show: string
  season: number
  group: AnimeGroupRecord
}

function placesOf(groups: readonly AnimeGroupRecord[]): Map<string, Place> {
  const places = new Map<string, Place>()
  for (const group of groups) {
    group.members.forEach((member, index) => {
      if (!places.has(member)) places.set(member, { show: group.id, season: index + 1, group })
    })
  }
  return places
}

const byMember = (group: AnimeGroupRecord): boolean => group.series === ''

/**
 * Where a show went whose front id is in no show now: the one show every
 * other member of it that is still in a show is in — or nothing, when they
 * are in none or in more than one.
 */
function successorOf(group: AnimeGroupRecord, now: Map<string, Place>): Place | undefined {
  let went: Place | undefined
  for (const member of group.members.slice(1)) {
    const place = now.get(member)
    if (!place) continue
    if (went && went.show !== place.show) return undefined
    went = went ?? now.get(place.show)
  }
  return went
}

/**
 * Whether a member's place in its show is also its season on the show's
 * page — animeSeasons.ts's seasonMatchesPage. It is what decides whether a
 * later season's rows are the show's at all: where the answer is no, such a
 * season still opens and saves as itself (laterSeasonOf), and its rows have
 * to stay with it.
 */
export type PlaceIsSeason = (showId: string, memberId: string, season: number) => boolean

/**
 * What has to move for rows filed under `before` to be right under `after`.
 *
 * An id in neither list stands alone: its rows are under its own id, and it
 * needs nothing until a grouping takes it in.
 *
 * Without `placeIsSeason` only a show numbered by its members is known to
 * keep a later season at its place, which is the half of the rule that
 * needs no lookup.
 */
export function planAnimeRegroup(
  before: readonly AnimeGroupRecord[],
  after: readonly AnimeGroupRecord[],
  placeIsSeason?: PlaceIsSeason
): AnimeRegroupPlan {
  const was = placesOf(before)
  const now = placesOf(after)
  const plan: AnimeRegroupPlan = { moves: [], ratings: [], left: [] }

  for (const group of before) {
    const show = group.id
    const front = now.get(show)

    if (!byMember(group)) {
      // Numbered by TMDB, or not known: the rows stay at their numbers, and
      // only follow the id when the show it fronts is the same series.
      //
      // The id that fronted it can also have left every show while the rest
      // of it is fronted by another: a film TheTVDB files at season 0 sorted
      // first and fronted its show, until the grouping stopped counting films
      // as seasons. Its rows are still the show's TMDB seasons (its page never
      // showed the film), so they go where the rest of the show went.
      const went = front ?? successorOf(group, now)
      if (!went && group.members.every((member) => !now.has(member))) {
        cameApart(group, plan, placeIsSeason)
        continue
      }
      const showTo = went?.show ?? show
      if (showTo === show) continue
      if (group.series && went?.group.series === group.series) {
        plan.moves.push({ fromId: show, fromSeason: null, toId: showTo, toSeason: null })
        plan.ratings.push({ fromId: show, toId: showTo })
      } else {
        plan.left.push({ id: show, why: 'fronted by another id, and not provably the same series' })
      }
      continue
    }

    group.members.forEach((member, index) => {
      const season = index + 1
      const to = now.get(member)
      if (!to) {
        // It stands alone now: its season goes back under its own id. The
        // member that fronted the show already is under its own id.
        if (member !== show) {
          plan.moves.push({ fromId: show, fromSeason: season, toId: member, toSeason: 1 })
        }
        return
      }
      if (to.show === show && to.season === season) return
      if (!byMember(to.group)) {
        plan.left.push({ id: member, why: 'its show is not numbered by its members any more' })
        return
      }
      plan.moves.push({ fromId: show, fromSeason: season, toId: to.show, toSeason: to.season })
    })
    // What is the show's rather than a member's goes where its id went:
    // the specials a Trakt import filed at season 0, and the rating. An id
    // that left every show (a film that sorted first and fronted it, until
    // films stopped being seasons) went where the rest of the show went.
    const went = front ?? successorOf(group, now)
    if (went && went.show !== show && byMember(went.group)) {
      plan.moves.push({ fromId: show, fromSeason: 0, toId: went.show, toSeason: 0 })
      plan.ratings.push({ fromId: show, toId: went.show })
    }
  }

  // Ids that stood alone and are part of a show now.
  for (const group of after) {
    group.members.forEach((member, index) => {
      const old = was.get(member)
      if (old) {
        // A later season that was in a show, at a place that was not its
        // season on the page, opened and saved as itself: its rows are under
        // its own id. Where its place now is its season (another member
        // leaving moved it there, as a film leaving a show numbered by TMDB
        // does), it opens as the show and the grid no longer lists it, so
        // its rows join the show as a newly joined member's would.
        if (
          index > 0 &&
          placeIsSeason &&
          old.show !== member &&
          !placeIsSeason(old.show, member, old.season) &&
          placeIsSeason(group.id, member, index + 1)
        ) {
          plan.moves.push({ fromId: member, fromSeason: null, toId: group.id, toSeason: index + 1 })
          plan.ratings.push({ fromId: member, toId: group.id })
        }
        return
      }
      if (index === 0) {
        // It fronts a show it used to be the whole of. Its own episodes are
        // season 1 there; a row carrying Kitsu's label for the entry (a 2 or
        // a 3) would read as another member's season.
        if (byMember(group)) {
          plan.moves.push({ fromId: member, fromSeason: null, toId: member, toSeason: 1 })
        }
        return
      }
      // A later season is kept under its show at its place only where that
      // place is its season on the show's page: the rule every write under
      // such an id follows (tracking.ts's underShow, through laterSeasonOf).
      // On a show numbered by TMDB the member at place N is often not
      // season N — a film or an OVA sits among the seasons — and its rows
      // moved there would mark another season watched. Such a member still
      // opens and saves as itself, so its rows stay where they are.
      const season = index + 1
      const kept = placeIsSeason ? placeIsSeason(group.id, member, season) : byMember(group)
      if (!kept) return
      plan.moves.push({ fromId: member, fromSeason: null, toId: group.id, toSeason: season })
      plan.ratings.push({ fromId: member, toId: group.id })
    })
  }

  return plan
}

/**
 * A show numbered by TMDB whose members all stand alone now: fewer than two
 * of them are TV entries, as when a one-season show's film or OVA (which
 * TheTVDB files at season 0, so it sorted first and fronted the show) stops
 * being a season. Its rows are under the old front at TMDB's season
 * numbers, and no page reads them there any more.
 *
 * A season goes to the one former member shown to be that season on the old
 * page (placeIsSeason), at its own season 1, and the rating with season 1.
 * Nothing else can be placed: season 0, a season no member or more than one
 * is shown to be, and the front's own seasons other than 1 stay where they
 * are, and the show is reported. Only places up to the member count are
 * asked: a member TheTVDB numbers past them is among what is reported.
 */
function cameApart(
  group: AnimeGroupRecord,
  plan: AnimeRegroupPlan,
  placeIsSeason?: PlaceIsSeason
): void {
  const show = group.id
  for (let season = 1; placeIsSeason && season <= group.members.length; season++) {
    const owners = group.members.filter((member) => placeIsSeason(show, member, season))
    if (owners.length !== 1 || owners[0] === show) continue
    plan.moves.push({ fromId: show, fromSeason: season, toId: owners[0], toSeason: 1 })
    if (season === 1) plan.ratings.push({ fromId: show, toId: owners[0] })
  }
  plan.left.push({
    id: show,
    why: 'its show came apart; rows at a season no former member is shown to be stay under it'
  })
}

/**
 * Brings the rows in `db` from the grouping they are filed under to `after`,
 * and records `after` as the grouping they are filed under now.
 *
 * The first run has nothing to compare against: it records and moves
 * nothing. Rows stranded before then are animeSyncRepair.ts's to place.
 * Safe to call again with the same grouping; it finds no difference.
 */
export function followAnimeRegroup(
  db: Pick<MediaHubDatabase, 'animeGroupLedger' | 'moveAnimeHistory'>,
  after: readonly AnimeGroupRecord[],
  placeIsSeason?: PlaceIsSeason
): { moved: number; left: AnimeRegroupPlan['left'] } {
  const before = db.animeGroupLedger()
  if (!before) {
    db.moveAnimeHistory({ moves: [] }, [...after])
    return { moved: 0, left: [] }
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return { moved: 0, left: [] }
  const plan = planAnimeRegroup(before, after, placeIsSeason)
  // The moves and the new ledger commit together: a ledger that ran ahead
  // of the rows would describe an order they were never moved to.
  const landed = db.moveAnimeHistory(plan, [...after])
  return {
    moved: landed.history + landed.plays + landed.positions + landed.ratings,
    left: plan.left
  }
}

/** The rows one profile holds under an id, for one season. */
export interface HeldSeason {
  season: number
  /** How many episodes are marked. */
  episodes: number
  /** The lowest and highest episode numbers marked. */
  first: number
  last: number
}

/**
 * Where the seasons under an id that once fronted its show belong now.
 *
 * Such an id is a later season today, and its rows are the whole show's in
 * an order nothing recorded at the time (they predate the ledger). Its own
 * season 1 is placed by remapContentIds. For the rest this works out which
 * member each season was, from two things that can be checked:
 *
 *  - how many episodes each member has. A season marked 1..N, all of them,
 *    is a member with exactly N episodes.
 *  - `remembered`: the siblings the id had when it fronted the show, in
 *    order, where the catalog index still holds them (its grouped_ids
 *    column is written for a fronting id and never cleared). It is believed
 *    only when no season under the id contradicts it.
 *
 * With a believed order, a season is placed when it is watched in full and
 * the member the order names is exactly that long: two things agreeing.
 *
 * With lengths alone, N episodes marked could also be the first N of a
 * longer season. So the seasons are placed only all together: every one
 * watched in full, each with exactly one member of its length, no member
 * taken twice. One season that fails any of that and none are placed. A
 * show watched right through passes; a coincidence would need every season
 * to line up at once.
 *
 * Whatever is not placed is left where it is, with the reason.
 */
export function placeStrandedSeasons(input: {
  /** The id that once fronted the show. */
  id: string
  /** One profile's rows under it. Season 1 and below are not considered. */
  seasons: readonly HeldSeason[]
  /** The show's members now, with each one's own episode count where known. */
  members: readonly { id: string; episodes: number | null }[]
  remembered?: readonly string[]
}): { placed: { season: number; member: string }[]; left: { season: number; why: string }[] } {
  const others = input.members.filter((member) => member.id !== input.id)
  const episodesOf = new Map(others.map((member) => [member.id, member.episodes] as const))
  const held = input.seasons.filter((season) => season.season >= 2 && season.episodes > 0)

  // The remembered order names a member for season s at index s - 2. It is
  // set aside whole when any season holds an episode its named member does
  // not have, or names an id that is no part of the show now: an order that
  // is wrong about one season was not the order these rows were written in.
  const named = (season: number): string | undefined => input.remembered?.[season - 2]
  const believed =
    Boolean(input.remembered?.length) &&
    held.every((season) => {
      const member = named(season.season)
      if (!member || !episodesOf.has(member)) return false
      const count = episodesOf.get(member)
      return count == null || season.last <= count
    })

  const placed: { season: number; member: string }[] = []
  const left: { season: number; why: string }[] = []
  for (const season of held) {
    const whole = season.first === 1 && season.last === season.episodes
    if (!whole) {
      left.push({ season: season.season, why: 'not watched in full, so its length says nothing' })
      continue
    }
    const fits = others.filter((member) => member.episodes === season.episodes)
    if (!fits.length) {
      left.push({ season: season.season, why: `no season has ${season.episodes} episodes` })
      continue
    }
    if (believed) {
      const member = named(season.season) as string
      if (fits.some((fit) => fit.id === member)) placed.push({ season: season.season, member })
      else left.push({ season: season.season, why: 'the season remembered there is not this long' })
      continue
    }
    if (fits.length === 1) placed.push({ season: season.season, member: fits[0].id })
    else {
      left.push({
        season: season.season,
        why: `${fits.length} seasons have ${season.episodes} episodes`
      })
    }
  }

  // Two seasons on one member: at most one of them is, and nothing says which.
  const claims = new Map<string, number>()
  for (const place of placed) claims.set(place.member, (claims.get(place.member) || 0) + 1)
  let kept = placed.filter((place) => claims.get(place.member) === 1)
  for (const place of placed) {
    if (claims.get(place.member) !== 1) {
      left.push({ season: place.season, why: 'another season fits the same member' })
    }
  }
  if (!believed && left.length) {
    for (const place of kept) {
      left.push({
        season: place.season,
        why: 'fits one season by length, but not every season under the id could be placed'
      })
    }
    kept = []
  }
  return { placed: kept, left: left.sort((a, b) => a.season - b.season) }
}

/**
 * The moves that place the seasons stranded under `id` — see
 * placeStrandedSeasons — for every profile whose rows there are a whole
 * show's.
 *
 * Only for a show numbered by its members: on one numbered by TMDB a
 * member's position is not what its season number means on the page.
 */
export function strandedSeasonMoves(
  db: Pick<MediaHubDatabase, 'wholeShowRowsUnder'>,
  id: string,
  show: {
    group: AnimeGroupRecord
    episodesOf: (member: string) => number | null
    remembered?: readonly string[]
  }
): { moves: AnimeHistoryMove[]; left: { id: string; why: string }[] } {
  const moves: AnimeHistoryMove[] = []
  const left: { id: string; why: string }[] = []
  const held = db.wholeShowRowsUnder(id)
  if (!held.length) return { moves, left }
  if (!byMember(show.group)) {
    left.push({ id, why: 'its show is numbered by TMDB seasons, not by its members' })
    return { moves, left }
  }
  const members = show.group.members.map((member) => ({
    id: member,
    episodes: show.episodesOf(member)
  }))
  for (const profile of held) {
    const result = placeStrandedSeasons({
      id,
      seasons: profile.seasons,
      members,
      remembered: show.remembered
    })
    for (const place of result.placed) {
      moves.push({
        fromId: id,
        fromSeason: place.season,
        toId: show.group.id,
        toSeason: show.group.members.indexOf(place.member) + 1,
        profileId: profile.profileId
      })
    }
    for (const miss of result.left) left.push({ id: `${id} season ${miss.season}`, why: miss.why })
  }
  return { moves, left }
}
