// Where a service's anime entry is kept, asked of a real database.
//
// tests/simklAnime.test.ts pins the rule (serviceIds.ts) on hand-built
// lookups. This runs the functions every sync path actually calls
// (animeSeasons.ts) against the things they read: the grouped catalog in the
// cache, the `kitsu:tvdb:<id>` mappings beside it, and the marker that says
// the catalog has been grouped. The catch-up and the MyAnimeList import ask
// placeAnimeEntry, the pushes ask animeSeasonMembersWhenGrouped and
// animeEntriesFor, the Trakt import, the pages and the cards ask
// laterSeasonOf.
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
  animeSeasonMembersWhenGrouped,
  invalidateAnimeGroupIndex,
  laterSeasonLookup,
  laterSeasonOf,
  placeAnimeEntry,
  seasonMatchesPage
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
      { id: FRIEREN }
    ],
    DAY
  )
  db.putCache(ANIME_GROUPED_KEY, grouped, DAY)
  invalidateAnimeGroupIndex()
}

/** What kitsuTvdbMapping caches: the mapping, or its "Kitsu has none" mark. */
function mapping(id: string, seriesId: string, season: number): void {
  db.putCache(`kitsu:tvdb:${id.replace(/^kitsu:/, '')}`, { seriesId, season }, 30 * DAY)
}
const NONE = { seriesId: '', season: -1 }
function unmapped(id: string): void {
  db.putCache(`kitsu:tvdb:${id.replace(/^kitsu:/, '')}`, NONE, 30 * DAY)
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
  const lookup = laterSeasonLookup()
  assert.ok(lookup)
  assert.deepEqual(lookup(MHA_2), { id: MHA, season: 2 })
  assert.deepEqual(lookup(MHA_3), { id: MHA, season: 3 })
  assert.equal(lookup(MHA_4), null)
  assert.equal(lookup(NARUTO), null)
  assert.equal(lookup('tt0903747'), null)
})

console.log('\nwhat the MyAnimeList push asks')

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
  db.deleteCache('kitsu:tvdb:12511')
  const seasons = animeSeasonMembersWhenGrouped()
  assert.deepEqual(seasons?.(MHA), [null, null, null, null, null])
  assert.equal(laterSeasonOf(MHA_3), null)
  assert.deepEqual(placeAnimeEntry(MHA_3), { id: MHA_3, season: 1 })
  assert.equal(placeAnimeEntry(MHA), null)
  unmapped(MHA_OVA)
  assert.deepEqual(placeAnimeEntry(MHA_3), { id: MHA, season: 3 })
})

check('an expired mapping still counts: it is the one the page was built from', () => {
  db.putCache('kitsu:tvdb:13881', { seriesId: '305074', season: 3 }, -DAY)
  assert.deepEqual(placeAnimeEntry(MHA_3), { id: MHA, season: 3 })
  mapping(MHA_3, '305074', 3)
})

check('until the catalog is grouped nothing is a season of anything', () => {
  seed(false)
  assert.equal(animeSeasonMembersWhenGrouped(), undefined)
  assert.equal(laterSeasonLookup(), undefined)
  assert.equal(laterSeasonOf(MHA_3), null)
  assert.deepEqual(animeEntriesFor(MHA_3), { id: MHA_3, season: 1 })
  assert.deepEqual(animeEntriesFor(MHA), { id: MHA, season: 1 })
  seed(true)
  assert.deepEqual(laterSeasonOf(MHA_3), { id: MHA, season: 3 })
})

console.log(`\n${pass} passed`)
