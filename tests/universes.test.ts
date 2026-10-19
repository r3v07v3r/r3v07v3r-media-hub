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
  findUniverse,
  universeEntries,
  universeEntryReleased,
  universeEntryToCatalogItem,
  type UniverseDefinition
} from '../src/shared/media-hub/universes'

// ---- The shipped list ----------------------------------------------------

assert.ok(UNIVERSES.length > 0, 'there are universes')
assert.equal(new Set(UNIVERSES.map((universe) => universe.id)).size, UNIVERSES.length)

for (const universe of UNIVERSES) {
  assert.match(universe.id, /^[a-z0-9-]+$/, `${universe.id} is a route segment`)
  assert.ok(universe.name && universe.blurb, `${universe.id} has a name and a blurb`)
  assert.ok(universe.entries.length >= 2, `${universe.id} is more than one title`)
  const ids = universe.entries.map((entry) => entry.id)
  assert.equal(new Set(ids).size, ids.length, `${universe.id} lists no title twice`)
  // Two cards with one name and one kind cannot be told apart — Cinemeta
  // calls both the 1966 and the 1973 series "Star Trek", hence the labels.
  const names = universe.entries.map((entry) => `${entry.type} ${entry.title}`)
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

console.log('universes: ok')
