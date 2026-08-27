// Bringing a Trakt account's history in.
//
// The dangerous half of a two-way sync. It writes into the table every
// recommendation, badge and statistic is derived from, from data this app
// did not produce, and it is the one operation somebody is most likely to
// run twice — because the honest response to a partial import is to run it
// again. So the three things pinned here are: real dates survive, nothing
// already here is overwritten, and running it twice changes nothing.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDatabase } from '../src/main/media-hub/database'
import { parseTraktHistory, parseTraktRatings } from '../src/main/media-hub/trakt'

// ---------------------------------------------------------------------
// What Trakt's rows mean.
// ---------------------------------------------------------------------
const historyPayload = [
  {
    watched_at: '2019-04-02T21:15:00.000Z',
    type: 'movie',
    movie: { title: 'Dune', year: 2021, ids: { imdb: 'tt1160419', tmdb: 438631 } }
  },
  {
    watched_at: '2024-01-05T03:00:00.000Z',
    type: 'episode',
    episode: { season: 2, number: 7, ids: { imdb: 'tt99999' } },
    show: { title: 'Severance', year: 2022, ids: { imdb: 'tt11280740' } }
  },
  // Specials. Season 0 is a real season and must not become season 1.
  {
    watched_at: '2024-01-06T03:00:00.000Z',
    type: 'episode',
    episode: { season: 0, number: 1 },
    show: { title: 'Severance', ids: { imdb: 'tt11280740' } }
  },
  // Trakt's catalog is wider than this one: a row with no IMDb id has no id
  // this app is keyed by. Skipped and counted, never matched by title — a
  // confident wrong match writes somebody else's viewing into this history.
  {
    watched_at: '2024-02-01T00:00:00.000Z',
    type: 'movie',
    movie: { title: 'Some Obscure Short', ids: { tmdb: 12345 } }
  },
  // A date nothing can sort on is worse than no row: it goes straight into
  // a column every history view and statistic orders by.
  { watched_at: 'sometime', type: 'movie', movie: { title: 'X', ids: { imdb: 'tt5' } } }
]

const parsed = parseTraktHistory(historyPayload)
assert.equal(parsed.rows.length, 3)
assert.equal(parsed.skipped, 2)

// An EPISODE is filed under its SHOW's IMDb id — that is how this app keys
// watch history, and Trakt hands over both halves in the same row.
assert.deepEqual(parsed.rows[1], {
  id: 'tt11280740',
  type: 'series',
  title: 'Severance',
  year: '2022',
  season: 2,
  episode: 7,
  watchedAt: '2024-01-05T03:00:00.000Z'
})
assert.equal(parsed.rows[2].season, 0, 'season 0 is the specials convention, not a missing season')
assert.equal(parsed.rows[0].season, null, 'a film has no coordinates at all')

// Ratings come across on the same 1-10 scale, unrescaled — a rescale is a
// place for an off-by-one to change somebody's opinion.
const ratings = parseTraktRatings([
  { rating: 9, movie: { title: 'Dune', ids: { imdb: 'tt1160419' } } },
  { rating: 7, show: { title: 'Severance', ids: { imdb: 'tt11280740' } } },
  { rating: 11, movie: { title: 'Impossible', ids: { imdb: 'tt7' } } },
  { rating: 8, movie: { title: 'No id', ids: {} } }
])
assert.equal(ratings.rows.length, 2)
assert.equal(ratings.skipped, 2)
assert.deepEqual(
  ratings.rows.map((r) => [r.id, r.score, r.type]),
  [
    ['tt1160419', 9, 'movie'],
    ['tt11280740', 7, 'series']
  ]
)

// ---------------------------------------------------------------------
// What writing them does.
// ---------------------------------------------------------------------
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'r3-trakt-import-')), 'db.sqlite')
const db = createDatabase(file, 'profile-a')

// Something already watched HERE, today, that Trakt also knows about with a
// much older date.
db.markWatched({ id: 'tt1160419', type: 'movie', title: 'Dune' })
const localDate = db.history().find((entry) => entry.id === 'tt1160419')?.watchedAt
assert.ok(localDate)
db.rate('tt1160419', 4)

assert.equal(db.importWatched(parsed.rows), 3)
assert.equal(db.importRatings(ratings.rows), 1, 'the already-rated title keeps its local score')

// The local date wins. An import FILLS GAPS: the row already here is what
// somebody in this app actually saw happen, and the remote copy does not get
// to move it out of their recently-watched.
assert.equal(db.history().find((entry) => entry.id === 'tt1160419')?.watchedAt, localDate)

// Nor does it get to replace an opinion. 4 is what this person said here.
assert.equal(db.ratings().get('tt1160419'), 4)
assert.equal(db.ratings().get('tt11280740'), 7, 'a title with no local score does come across')

// Imported dates are the REAL ones, not today. This is the whole reason the
// import does not go through markWatched.
const plays = db.plays(50)
const severance = plays.find((play) => play.season === 2 && play.episode === 7)
assert.equal(severance?.watchedAt, '2024-01-05T03:00:00.000Z')

// Running it again writes nothing. The honest response to a partial import
// is to run it again, so a second run must not double every play row and
// report the whole library as rewatched.
assert.equal(db.importWatched(parsed.rows), 0)
assert.equal(db.importRatings(ratings.rows), 0)
assert.equal(db.plays(200).length, plays.length)

// A genuine rewatch still counts — it has its own timestamp, which is what
// makes it a different viewing rather than the same one seen twice.
assert.equal(db.importWatched([{ ...parsed.rows[1], watchedAt: '2026-05-05T20:00:00.000Z' }]), 1)

// ---------------------------------------------------------------------
// Whose history it is.
// ---------------------------------------------------------------------
db.setActiveProfile('profile-b')
assert.equal(db.history().length, 0, 'an import belongs to the profile that ran it')
assert.equal(db.ratings().size, 0)

console.log('trakt import tests passed')
