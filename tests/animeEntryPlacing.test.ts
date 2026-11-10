// Where a service's anime entry is kept, asked of a real database.
//
// tests/simklAnime.test.ts pins the rule (serviceIds.ts) on hand-built
// lookups. This runs the functions every sync path actually calls
// (animeSeasons.ts) against the things they read: the grouped catalog in the
// cache, the `kitsu:tvdb:<id>` mappings beside it, and the marker that says
// the catalog has been grouped. The catch-up and the MyAnimeList import ask
// placeAnimeEntry, the pushes ask animeSeasonMembersWhenGrouped and
// animeEntriesFor, the Trakt import, the pages and the cards ask
// laterSeasonOf, and the library's filters and Home ask laterSeasons.
//
// The groups are shapes from a real library: My Hero Academia (an OVA among
// the seasons, later seasons Kitsu maps to nothing), Naruto behind Naruto:
// Shippuden (two series in one group), Bleach (films between the series and
// its sequel), and a show built from its members.
//
// Run with: npx tsx tests/animeEntryPlacing.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ANIME_GROUPED_KEY,
  animeEntriesFor,
  animeEpisodeStreamAddress,
  animeSeasonMembersWhenGrouped,
  invalidateAnimeGroupIndex,
  laterSeasonOf,
  laterSeasons,
  placeAnimeEntry,
  regroupPlaceIsSeason,
  seasonHasPlacedMember,
  seasonMatchesPage,
  unsentAnimeSeasons
} from '../src/main/media-hub/animeSeasons'
import { createDatabase } from '../src/main/media-hub/database'
import { setDatabase } from '../src/main/media-hub/dbState'
import { planMalPushes } from '../src/main/media-hub/mal'

let pass = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-anime-placing-'))
const db = createDatabase(path.join(dir, 'test.sqlite'), 'profile-placing')
setDatabase(db)

const DAY = 24 * 60 * 60 * 1000

// My Hero Academia: three mapped seasons, an OVA, then the fourth season
// with no mapping at all.
const MHA = 'kitsu:11469'
const MHA_2 = 'kitsu:12268'
const MHA_3 = 'kitsu:13881'
const MHA_OVA = 'kitsu:12511'
const MHA_4 = 'kitsu:41971'
// Naruto: Shippuden fronts the group; Naruto, a series of its own at
// TheTVDB, is its second member.
const SHIPPUDEN = 'kitsu:1555'
const NARUTO = 'kitsu:11'
// Bleach, a film, and the sequel series Kitsu maps to nothing.
const BLEACH = 'kitsu:244'
const BLEACH_FILM = 'kitsu:1515'
const BLEACH_TYBW = 'kitsu:43078'
// A show whose first member has no mapping: built from its members.
const SOLO = 'kitsu:46231'
const SOLO_2 = 'kitsu:48671'
// A recap in front of the show it recaps.
const RECAP = 'kitsu:8574'
const PSYCHO_PASS = 'kitsu:7000'
// Two cours Kitsu maps to one TheTVDB season, behind the first season.
const JOJO = 'kitsu:7158'
const JOJO_2B = 'kitsu:8743'
const JOJO_2A = 'kitsu:8063'
// A title that was never merged.
const FRIEREN = 'kitsu:46474'

function seed(grouped: boolean): void {
  db.putCache(
    'catalog:v2:anime',
    [
      { id: MHA, groupedIds: [MHA_2, MHA_3, MHA_OVA, MHA_4] },
      { id: SHIPPUDEN, groupedIds: [NARUTO] },
      { id: BLEACH, groupedIds: [BLEACH_FILM, BLEACH_TYBW] },
      { id: SOLO, groupedIds: [SOLO_2] },
      { id: RECAP, groupedIds: [PSYCHO_PASS] },
      { id: JOJO, groupedIds: [JOJO_2B, JOJO_2A] },
      { id: FRIEREN }
    ],
    DAY
  )
  db.putCache(ANIME_GROUPED_KEY, grouped, DAY)
  invalidateAnimeGroupIndex()
}

/** What kitsuTvdbMapping caches: the mapping, or its "Kitsu has none" mark.
 *  Like it, each write drops what was worked out from the old one. */
function mapping(id: string, seriesId: string, season: number, ttl = 30 * DAY): void {
  db.putCache(`kitsu:tvdb:${id.replace(/^kitsu:/, '')}`, { seriesId, season }, ttl)
  invalidateAnimeGroupIndex()
}
const NONE = { seriesId: '', season: -1 }
function unmapped(id: string): void {
  db.putCache(`kitsu:tvdb:${id.replace(/^kitsu:/, '')}`, NONE, 30 * DAY)
  invalidateAnimeGroupIndex()
}
function neverAsked(id: string): void {
  db.deleteCache(`kitsu:tvdb:${id.replace(/^kitsu:/, '')}`)
  invalidateAnimeGroupIndex()
}

seed(true)
mapping(MHA, '305074', 1)
mapping(MHA_2, '305074', 2)
mapping(MHA_3, '305074', 3)
unmapped(MHA_OVA)
unmapped(MHA_4)
mapping(SHIPPUDEN, '79824', 1)
mapping(NARUTO, '78857', 1)
mapping(BLEACH, '74796', 1)
unmapped(BLEACH_FILM)
unmapped(BLEACH_TYBW)
unmapped(SOLO)
mapping(RECAP, '262090', 0)
mapping(PSYCHO_PASS, '262090', 1)
mapping(JOJO, '262954', 1)
mapping(JOJO_2B, '262954', 2)
mapping(JOJO_2A, '262954', 2)
// SOLO_2 is left never asked about: on a show built from its members that
// changes nothing.

console.log('which member is which season')

check('a well-ordered season is its season; an OVA and an unmapped season are not', () => {
  const seasons = animeSeasonMembersWhenGrouped()
  assert.ok(seasons)
  assert.deepEqual(seasons(MHA), [MHA, MHA_2, MHA_3, null, null])
  assert.deepEqual(seasons(SHIPPUDEN), [SHIPPUDEN, null])
  assert.deepEqual(seasons(BLEACH), [BLEACH, null, null])
  assert.deepEqual(seasons(SOLO), [SOLO, SOLO_2])
  assert.deepEqual(seasons(RECAP), [null, null])
  assert.deepEqual(seasons(JOJO), [JOJO, null, null])
  // Only an id that fronts a group has seasons to name.
  assert.equal(seasons(MHA_3), undefined)
  assert.equal(seasons(FRIEREN), undefined)
})

check('seasonMatchesPage is the same answer, one member at a time', () => {
  assert.equal(seasonMatchesPage(MHA, MHA_3, 3), true)
  assert.equal(seasonMatchesPage(MHA, MHA_4, 5), false)
  assert.equal(seasonMatchesPage(MHA, MHA_OVA, 4), false)
  assert.equal(seasonMatchesPage(SHIPPUDEN, NARUTO, 2), false)
  assert.equal(seasonMatchesPage(SOLO, SOLO_2, 2), true)
  assert.equal(seasonMatchesPage(MHA, MHA_3, 0), false)
})

check('seasonHasPlacedMember: some member is that season of the page', () => {
  assert.equal(seasonHasPlacedMember(MHA, 1), true)
  assert.equal(seasonHasPlacedMember(MHA, 3), true)
  assert.equal(seasonHasPlacedMember(MHA, 4), false)
  assert.equal(seasonHasPlacedMember(MHA, 5), false)
  assert.equal(seasonHasPlacedMember(RECAP, 1), false)
  assert.equal(seasonHasPlacedMember(SOLO, 2), true)
  // An id that fronts no group has no page seasons to place.
  assert.equal(seasonHasPlacedMember(MHA_4, 1), false)
  assert.equal(seasonHasPlacedMember(FRIEREN, 1), false)
})

console.log('\nthe seasons a page says are not sent')

check('unsentAnimeSeasons: the seasons no member can be shown to be', () => {
  const both = ['simkl', 'mal'] as const
  assert.deepEqual(unsentAnimeSeasons(MHA, both), [
    { season: 4, services: ['simkl', 'mal'] },
    { season: 5, services: ['simkl', 'mal'] }
  ])
  assert.deepEqual(
    unsentAnimeSeasons(JOJO, both).map((s) => s.season),
    [2, 3]
  )
  assert.deepEqual(
    unsentAnimeSeasons(RECAP, both).map((s) => s.season),
    [1, 2],
    'a show fronted by a recap'
  )
  // Only the services connected are named.
  assert.deepEqual(unsentAnimeSeasons(MHA, ['simkl']), [
    { season: 4, services: ['simkl'] },
    { season: 5, services: ['simkl'] }
  ])
  // The page's own seasons: a season past the members has no entry either,
  // and Specials are never said to be unsent.
  assert.deepEqual(
    unsentAnimeSeasons(MHA, both, [0, 1, 2, 3, 4, 5, 6]).map((s) => s.season),
    [4, 5, 6]
  )
})

check('unsentAnimeSeasons says nothing where nothing is unsent or known yet', () => {
  const both = ['simkl', 'mal'] as const
  assert.deepEqual(unsentAnimeSeasons(SOLO, both), [], 'built from its members')
  assert.deepEqual(unsentAnimeSeasons(FRIEREN, both), [], 'a title of its own')
  assert.deepEqual(unsentAnimeSeasons(MHA_4, both), [], 'a later season opened as itself')
  assert.deepEqual(unsentAnimeSeasons(MHA, []), [], 'no service connected')
  neverAsked(MHA_4)
  assert.deepEqual(unsentAnimeSeasons(MHA, both), [], 'a lookup is pending')
  unmapped(MHA_4)
  seed(false)
  assert.deepEqual(unsentAnimeSeasons(MHA, both), [], 'not grouped yet')
  seed(true)
  assert.equal(unsentAnimeSeasons(MHA, both).length, 2)
})

console.log('\nwhere an import keeps an entry (the catch-up, the MyAnimeList import)')

check('a season of its show: under the show, at that season', () => {
  assert.deepEqual(placeAnimeEntry(MHA), { id: MHA, season: 1 })
  assert.deepEqual(placeAnimeEntry(MHA_3), { id: MHA, season: 3 })
  assert.deepEqual(placeAnimeEntry(SOLO_2), { id: SOLO, season: 2 })
  assert.deepEqual(placeAnimeEntry(FRIEREN), { id: FRIEREN, season: 1 })
})

check('a mis-ordered member: itself, never the season at its place', () => {
  // By place these were season 5 of My Hero Academia, season 2 of Naruto:
  // Shippuden and season 3 of Bleach.
  assert.deepEqual(placeAnimeEntry(MHA_4), { id: MHA_4, season: 1 })
  assert.deepEqual(placeAnimeEntry(NARUTO), { id: NARUTO, season: 1 })
  assert.deepEqual(placeAnimeEntry(BLEACH_TYBW), { id: BLEACH_TYBW, season: 1 })
  assert.deepEqual(placeAnimeEntry(MHA_OVA), { id: MHA_OVA, season: 1 })
  assert.deepEqual(placeAnimeEntry(PSYCHO_PASS), { id: PSYCHO_PASS, season: 1 })
})

check("a show's own id that is not its first season has no place", () => {
  assert.equal(placeAnimeEntry(RECAP), null)
})

console.log('\nwhat a page, a card and the Trakt import ask')

check('laterSeasonOf: the show for a season of it, nothing for anything else', () => {
  assert.deepEqual(laterSeasonOf(MHA_3), { id: MHA, season: 3 })
  assert.deepEqual(laterSeasonOf(SOLO_2), { id: SOLO, season: 2 })
  for (const id of [MHA_4, MHA_OVA, NARUTO, BLEACH_TYBW, PSYCHO_PASS, MHA, RECAP, FRIEREN]) {
    assert.equal(laterSeasonOf(id), null, id)
  }
  // The whole catalog at once is the same answer, id by id.
  const later = laterSeasons()
  assert.ok(later)
  assert.deepEqual(
    [...later].sort(([a], [b]) => (a < b ? -1 : 1)),
    [
      [MHA_2, { id: MHA, season: 2 }],
      [MHA_3, { id: MHA, season: 3 }],
      [SOLO_2, { id: SOLO, season: 2 }]
    ]
  )
})

console.log('\nwhat the MyAnimeList push asks')

check(
  'the regroup: the rule for the grouping that stands, the mappings for one that is gone',
  () => {
    // At a member's place in today's grouping it is seasonMatchesPage's
    // answer, so rows move under a show exactly where laterSeasonOf opens it.
    assert.equal(regroupPlaceIsSeason(MHA, MHA_3, 3), true)
    assert.equal(regroupPlaceIsSeason(MHA, MHA_4, 5), false)
    assert.equal(regroupPlaceIsSeason(SOLO, SOLO_2, 2), true)
    // The cour at place 2 maps to season 2, and so does another member.
    assert.equal(regroupPlaceIsSeason(JOJO, JOJO_2B, 2), false)
    assert.equal(seasonMatchesPage(JOJO, JOJO_2B, 2), false)
    // Asked of a season that is not the member's place — which season of the
    // page a member WAS, once its show has come apart — only the mappings can
    // answer. Psycho-Pass sits second behind a recap and is TheTVDB's season 1.
    assert.equal(regroupPlaceIsSeason(RECAP, PSYCHO_PASS, 1), true)
    assert.equal(seasonMatchesPage(RECAP, PSYCHO_PASS, 1), false)
    assert.equal(regroupPlaceIsSeason(RECAP, PSYCHO_PASS, 2), false)
    assert.equal(regroupPlaceIsSeason(RECAP, RECAP, 1), false)
    // A member with no mapping was no season of a page numbered by TMDB.
    assert.equal(regroupPlaceIsSeason(MHA, MHA_4, 4), false)
  }
)

const watched = (id: string, season: number, episode: number) => ({
  id,
  type: 'anime' as const,
  season,
  episode,
  watchedAt: '2026-01-01T00:00:00.000Z'
})

check('a season of the page goes to the member that is it, or nowhere', () => {
  const title = animeEntriesFor(MHA)
  assert.deepEqual(title, { id: MHA, members: [MHA, MHA_2, MHA_3, null, null], season: 1 })
  const history = [watched(MHA, 3, 1), watched(MHA, 4, 1), watched(MHA, 4, 2), watched(MHA, 5, 1)]
  // Seasons 4 and 5 of the page are TMDB's; the members at those places
  // are an OVA and the fourth season.
  assert.deepEqual(planMalPushes(history, title, { seasons: [3, 4, 5] }), [
    { id: MHA_3, watchedEpisodes: 1 }
  ])
})

check('a later season that is one sends its own season of the show', () => {
  const title = animeEntriesFor(MHA_3)
  assert.equal(title.id, MHA)
  assert.equal(title.season, 3)
  assert.deepEqual(
    planMalPushes([watched(MHA, 3, 1), watched(MHA, 3, 2)], title, { seasons: [title.season] }),
    [{ id: MHA_3, watchedEpisodes: 2 }]
  )
})

check('a mis-ordered member is one entry, counted over its own rows', () => {
  for (const id of [MHA_4, NARUTO, BLEACH_TYBW]) {
    assert.deepEqual(animeEntriesFor(id), { id, season: 1 }, id)
  }
  // The show's rows at "its" place are another season's, and are not its.
  const history = [watched(MHA, 5, 1), watched(MHA, 5, 2), watched(MHA_4, 1, 1)]
  assert.deepEqual(planMalPushes(history, animeEntriesFor(MHA_4), { seasons: [1] }), [
    { id: MHA_4, watchedEpisodes: 1 }
  ])
})

check('a first season the show cannot be shown to be is not sent', () => {
  const title = animeEntriesFor(RECAP)
  assert.deepEqual(title.members, [null, null])
  assert.deepEqual(planMalPushes([watched(RECAP, 1, 1)], title, { seasons: [1] }), [])
})

console.log('\nwhat is known and what is not')

check('a member nobody has looked up holds the whole show back', () => {
  neverAsked(MHA_OVA)
  const seasons = animeSeasonMembersWhenGrouped()
  assert.deepEqual(seasons?.(MHA), [null, null, null, null, null])
  assert.equal(laterSeasonOf(MHA_3), null)
  assert.deepEqual(placeAnimeEntry(MHA_3), { id: MHA_3, season: 1 })
  assert.equal(placeAnimeEntry(MHA), null)
  unmapped(MHA_OVA)
  assert.deepEqual(placeAnimeEntry(MHA_3), { id: MHA, season: 3 })
})

check('an expired mapping still counts: it is the one the page was built from', () => {
  mapping(MHA_3, '305074', 3, -DAY)
  assert.deepEqual(placeAnimeEntry(MHA_3), { id: MHA, season: 3 })
  mapping(MHA_3, '305074', 3)
})

check('until the catalog is grouped nothing is a season of anything', () => {
  seed(false)
  assert.equal(animeSeasonMembersWhenGrouped(), undefined)
  assert.equal(laterSeasons(), undefined)
  assert.equal(laterSeasonOf(MHA_3), null)
  assert.deepEqual(animeEntriesFor(MHA_3), { id: MHA_3, season: 1 })
  assert.deepEqual(animeEntriesFor(MHA), { id: MHA, season: 1 })
  seed(true)
  assert.deepEqual(laterSeasonOf(MHA_3), { id: MHA, season: 3 })
})

// What the stream add-ons are asked for an episode of the page: a later
// season is its own Kitsu entry. Solo Leveling S02E01 was searched as
// `kitsu:46231:1`, the first season's first episode, and played it.
check("a later season's episode is searched under that season's own entry", () => {
  seed(true)
  assert.equal(animeEpisodeStreamAddress(SOLO, 2, 1), `${SOLO_2}:1`)
  assert.equal(animeEpisodeStreamAddress(SOLO, 1, 1), `${SOLO}:1`)
  assert.equal(animeEpisodeStreamAddress(MHA, 3, 5), `${MHA_3}:5`)
})
check('a season no member can be shown to be is not searched at all', () => {
  seed(true)
  assert.equal(animeEpisodeStreamAddress(MHA, 4, 1), null, 'the OVA sits at place four')
  assert.equal(animeEpisodeStreamAddress(MHA, 9, 1), null, 'past the last member')
  assert.equal(animeEpisodeStreamAddress(JOJO, 2, 1), null, 'two cours claim season two')
})
check("a title that fronts no group keeps Kitsu's own numbering", () => {
  seed(true)
  assert.equal(animeEpisodeStreamAddress(FRIEREN, 2, 30), `${FRIEREN}:30`)
  assert.equal(animeEpisodeStreamAddress(SOLO_2, 2, 1), `${SOLO_2}:1`, 'asking again is harmless')
  assert.equal(animeEpisodeStreamAddress(SOLO, undefined, 4), `${SOLO}:4`)
})

console.log(`\n${pass} passed`)
