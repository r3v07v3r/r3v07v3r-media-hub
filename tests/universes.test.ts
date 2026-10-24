// The big collections: the bundled list, and the two orders it is shown in.
//
// The list is generated (scripts/build-universes.mjs) and then shipped, so
// what is pinned here is what a bad regeneration or a careless hand edit
// would break without anything failing to compile: an id the catalogue
// cannot open, a title listed twice, a date that is not a date — and the
// ordering rules themselves, on entries small enough to read.
//
// Run with: npx tsx tests/universes.test.ts

import assert from 'node:assert/strict'

import {
  UNIVERSES,
  addedCollectionId,
  findUniverse,
  parseTraktListLink,
  universeEntries,
  universeEntryKey,
  universeEntryReleased,
  universeEntryToCatalogItem,
  universePartLabel,
  universePartProgress,
  type UniverseDefinition,
  type UniverseEntry,
  type UniversePart
} from '../src/shared/media-hub/universes'
import type { HistoryEntry } from '../src/shared/media-hub/types'

// ---- The shipped list ----------------------------------------------------

assert.ok(UNIVERSES.length > 0, 'there are universes')
assert.equal(new Set(UNIVERSES.map((universe) => universe.id)).size, UNIVERSES.length)

for (const universe of UNIVERSES) {
  assert.match(universe.id, /^[a-z0-9-]+$/, `${universe.id} is a route segment`)
  assert.ok(universe.name && universe.blurb, `${universe.id} has a name and a blurb`)
  assert.ok(universe.entries.length >= 2, `${universe.id} is more than one title`)
  const keys = universe.entries.map(universeEntryKey)
  assert.equal(new Set(keys).size, keys.length, `${universe.id} lists no title twice`)
  // Two cards with one name and one kind cannot be told apart — Cinemeta
  // calls both the 1966 and the 1973 series "Star Trek", hence the labels.
  const names = universe.entries.map(
    (entry) =>
      `${entry.type} ${entry.title}${entry.part ? ` ${universePartLabel(entry.part)}` : ''}`
  )
  assert.equal(new Set(names).size, names.length, `${universe.id} has no two titles named alike`)
  for (const entry of universe.entries) {
    const where = `${universe.id} ${entry.id}`
    assert.match(entry.id, /^tt\d+$/, `${where} is an IMDb id`)
    assert.ok(entry.type === 'movie' || entry.type === 'series', `${where} has a kind`)
    assert.ok(entry.title, `${where} has a title`)
    assert.match(entry.year, /^\d{4}$/, `${where} has a year`)
    if (entry.released) {
      assert.match(entry.released, /^\d{4}-\d{2}-\d{2}$/, `${where} has a whole date`)
      assert.equal(entry.released.slice(0, 4), entry.year, `${where}: date and year agree`)
    }
    if (entry.part) {
      const { season, first, last } = entry.part
      assert.equal(entry.type, 'series', `${where}: only a series has seasons`)
      assert.ok(season >= 1 && first >= 1 && first <= last, `${where}: a real run of episodes`)
    }
  }
  // A series split by season is split all the way: no whole-series card
  // beside its own seasons, and its runs follow one another without a gap
  // or an overlap, in the order the story is written.
  const bySeries = new Map<string, UniverseEntry[]>()
  for (const entry of universe.entries) {
    bySeries.set(entry.id, [...(bySeries.get(entry.id) ?? []), entry])
  }
  for (const [id, stops] of bySeries) {
    if (stops.length === 1 && !stops[0].part) continue
    assert.ok(
      stops.every((stop) => stop.part),
      `${universe.id} ${id}: split, or listed once`
    )
    for (let index = 1; index < stops.length; index++) {
      const before = stops[index - 1].part!
      const after = stops[index].part!
      const follows =
        after.season === before.season
          ? after.first === before.last + 1 && !before.whole && !after.whole
          : after.season === before.season + 1 && after.first >= 1
      assert.ok(follows, `${universe.id} ${id}: ${universeEntryKey(stops[index])} follows on`)
    }
  }
}

// The two the feature was asked for by name, and the fact about each that
// release order alone would get wrong.
const starWars = findUniverse('star-wars')
assert.ok(starWars?.hasStoryOrder)
const story = universeEntries(starWars, 'story').map((entry) => entry.title)
const release = universeEntries(starWars, 'release').map((entry) => entry.title)
const phantomMenace = 'Star Wars: Episode I - The Phantom Menace'
const newHope = 'Star Wars: Episode IV - A New Hope'
assert.ok(story.indexOf(phantomMenace) < story.indexOf(newHope), 'Episode I is before IV')
assert.ok(release.indexOf(newHope) < release.indexOf(phantomMenace), '1977 is before 1999')
assert.equal(release[0], newHope)
assert.deepEqual([...story].sort(), [...release].sort(), 'both orders hold the same titles')

const marvel = findUniverse('marvel-cinematic-universe')
assert.ok(marvel?.hasStoryOrder)
assert.equal(universeEntries(marvel, 'release')[0].title, 'Iron Man')
assert.equal(universeEntries(marvel, 'story')[0].title, 'Captain America: The First Avenger')
assert.ok(
  marvel.entries.some((entry) => entry.type === 'series'),
  'a universe holds series as well as films'
)

// The point of splitting: Agents of S.H.I.E.L.D. turns with the films it
// shares a story with, so each film sits between the two runs of the season
// it lands in.
const marvelStory = universeEntries(marvel, 'story')
const place = (title: string, season?: number, first?: number): number =>
  marvelStory.findIndex(
    (entry) =>
      entry.title === title &&
      (season === undefined ||
        (entry.part?.season === season && (first === undefined || entry.part.first === first)))
  )
const shield = "Marvel's Agents of S.H.I.E.L.D."
for (const [film, season, after] of [
  ['Captain America: The Winter Soldier', 1, 17],
  ['Avengers: Age of Ultron', 2, 20],
  ['Captain America: Civil War', 3, 20],
  ['Avengers: Infinity War', 5, 20]
] as const) {
  const at = place(film)
  assert.ok(place(shield, season, 1) < at, `S.H.I.E.L.D. season ${season} starts before ${film}`)
  assert.ok(place(shield, season, after) > at, `and goes on from episode ${after} after it`)
}
assert.ok(place(shield, 7) < place('Avengers: Endgame'), 'the last season is before Endgame')
assert.ok(
  place("Marvel's Daredevil", 3) > place("Marvel's The Defenders"),
  'a later Netflix season is after the team-up'
)

assert.equal(findUniverse('no-such-universe'), undefined)

// ---- The ordering rules --------------------------------------------------

const sample: UniverseDefinition = {
  id: 'sample',
  name: 'Sample',
  blurb: 'A sample.',
  hasStoryOrder: true,
  entries: [
    { id: 'tt3', type: 'movie', title: 'Prequel', year: '2010', released: '2010-06-01' },
    { id: 'tt1', type: 'movie', title: 'Original', year: '2000', released: '2000-06-01' },
    { id: 'tt4', type: 'series', title: 'Year only', year: '2000', released: '' },
    { id: 'tt2', type: 'series', title: 'Same day', year: '2000', released: '2000-06-01' }
  ]
}
const ids = (order: 'story' | 'release', universe = sample): string[] =>
  universeEntries(universe, order).map((entry) => entry.id)

assert.deepEqual(ids('story'), ['tt3', 'tt1', 'tt4', 'tt2'], 'story order is the list as written')
// Same day keeps the written order; a year with no date goes to that
// year's end, not its start.
assert.deepEqual(ids('release'), ['tt1', 'tt2', 'tt4', 'tt3'])
assert.notEqual(
  universeEntries(sample, 'story'),
  sample.entries,
  'the list itself is not handed out'
)

// A universe with no story order has only one real order, whatever is asked.
const unordered = { ...sample, hasStoryOrder: false }
assert.deepEqual(ids('story', unordered), ids('release', unordered))

// ---- Seasons ------------------------------------------------------------

const seasonTwo: UniverseEntry & { part: UniversePart } = {
  id: 'tt9',
  type: 'series',
  title: 'Show',
  year: '2015',
  released: '2015-05-05',
  part: { season: 2, first: 20, last: 22, whole: false }
}
assert.equal(universeEntryKey(seasonTwo), 'tt9:2:20-22')
assert.equal(universeEntryKey(sample.entries[0]), 'tt3', 'a whole title is keyed by its id alone')
assert.equal(universePartLabel(seasonTwo.part), 'Season 2 · Episodes 20–22')
assert.equal(universePartLabel({ season: 4, first: 1, last: 22, whole: true }), 'Season 4')
assert.equal(
  universePartLabel({ season: 1, first: 9, last: 9, whole: false }),
  'Season 1 · Episode 9'
)

const seen = (season: number | null, episode: number | null, id = 'tt9'): HistoryEntry => ({
  id,
  type: 'series',
  season,
  episode,
  watchedAt: null
})
const progress = universePartProgress(seasonTwo, [
  seen(2, 20),
  seen(2, 20), // watched twice is still one episode
  seen(2, 19), // the run before the film
  seen(3, 21), // the same number in another season
  seen(2, 21, 'tt8'), // another show
  seen(2, null)
])
assert.deepEqual(progress, { watched: 1, total: 3, next: 21 }, 'Play starts at the first unseen')
assert.equal(universePartProgress(seasonTwo, []).next, 20, 'an untouched run starts at its first')
assert.equal(
  universePartProgress(seasonTwo, [seen(2, 20), seen(2, 21), seen(2, 22)]).next,
  20,
  'a finished run starts again from its first'
)
assert.equal(
  universePartProgress(seasonTwo, [seen(2, 20), seen(2, 22)]).next,
  21,
  'a gap is filled before going on'
)

// ---- Out yet -------------------------------------------------------------

const film = sample.entries[0]
assert.equal(universeEntryReleased(film, '2010-06-01'), true, 'out on the day')
assert.equal(universeEntryReleased(film, '2010-05-31'), false)
const yearOnly = sample.entries[2]
assert.equal(universeEntryReleased(yearOnly, '2000-01-01'), true, 'a year counts as out during it')
assert.equal(universeEntryReleased(yearOnly, '1999-12-31'), false)

// ---- The stand-in card ---------------------------------------------------

// Every field CatalogItem declares: the renderer's adapter reads `genres`
// and `videos` unguarded (see collection.ts on what a partial one did).
const card = universeEntryToCatalogItem(film)
assert.equal(card.id, 'tt3')
assert.equal(card.type, 'movie')
assert.equal(card.year, '2010')
assert.equal(card.releaseDate, '2010-06-01')
assert.deepEqual([card.genres, card.videos, card.trailers], [[], [], []])
assert.ok(card.poster.includes('/tt3/'), 'artwork is addressed by the same id')
assert.equal(new URL(card.poster).hostname, 'images.metahub.space', 'a host the page may load')

// ---- A pasted Trakt list link -------------------------------------------

assert.deepEqual(parseTraktListLink('https://trakt.tv/lists/1338'), { listId: 1338 })
assert.deepEqual(parseTraktListLink('  trakt.tv/lists/55?sort=rank,asc '), { listId: 55 })
assert.deepEqual(
  parseTraktListLink('https://trakt.tv/users/sean/lists/star-wars-in-machete-order?sort=rank,asc'),
  { owner: 'sean', slug: 'star-wars-in-machete-order' }
)
assert.deepEqual(parseTraktListLink('https://app.trakt.tv/users/sean/lists/stargate/'), {
  owner: 'sean',
  slug: 'stargate'
})
assert.deepEqual(parseTraktListLink('https://www.trakt.tv/lists/7'), { listId: 7 })
assert.equal(parseTraktListLink('https://simkl.com/5/list/2707/mcu'), null, 'Simkl is not read')
assert.equal(parseTraktListLink('https://trakt.tv.evil.example/lists/1'), null, 'host is exact')
assert.equal(parseTraktListLink('https://trakt.tv/movies/inception-2010'), null, 'not a list')
assert.equal(parseTraktListLink('https://trakt.tv/lists/official/abc'), null, 'id must be a number')
assert.equal(parseTraktListLink(''), null)
assert.equal(parseTraktListLink('not a link at all'), null)
assert.equal(addedCollectionId(1338), 'trakt-1338')
assert.match(addedCollectionId(1338), /^[a-z0-9-]+$/, 'a route segment, like the bundled ids')
assert.ok(!UNIVERSES.some((universe) => universe.id.startsWith('trakt-')), 'no clash with added')

console.log('universes: ok')
