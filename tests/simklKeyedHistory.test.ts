// A history row written under Simkl's own number (`simkl:<n>`) for a title
// this app and Simkl both hold under its IMDb id: how it is recognised,
// how it is pushed, and how the database folds it into the real row.
// Run with: npx tsx tests/simklKeyedHistory.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDatabase } from '../src/main/media-hub/database'
import { historyPayload, idsForCatalogId, watchedFromAllItems } from '../src/main/media-hub/simkl'
import { hasExpressibleSimklId } from '../src/shared/media-hub/serviceIds'
import { imdbForSimklKeyedId, isSimklKeyedId } from '../src/main/media-hub/simklKeyedHistory'

const PROFILE = 'profile-simkl-keyed'
function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-simkl-keyed-'))
  return createDatabase(path.join(dir, 'test.sqlite'), PROFILE)
}

// --- the id is a real one, expressible to Simkl as itself ------------------

assert.deepEqual(idsForCatalogId('simkl:342994'), { simkl: 342994 })
assert.equal(hasExpressibleSimklId('simkl:342994'), true)
assert.equal(hasExpressibleSimklId('simkl:'), false)
assert.deepEqual(
  historyPayload({ id: 'simkl:342994', type: 'movie', title: 'John Wick', year: '2014' }),
  { movies: [{ title: 'John Wick', year: 2014, ids: { simkl: 342994 } }] }
)

// --- the snapshot carries the pairing --------------------------------------

const snapshot = watchedFromAllItems({
  movies: [
    {
      movie: { ids: { imdb: 'tt2911666', simkl: 342994 } },
      last_watched_at: '2026-09-11T21:10:00Z'
    },
    { movie: { ids: { imdb: 'tt4425200' } } }
  ]
})
assert.equal(snapshot[0].simklId, 342994)
assert.equal(snapshot[1].simklId, null)

// --- finding the real id -----------------------------------------------------

assert.equal(isSimklKeyedId('simkl:342994'), true)
assert.equal(isSimklKeyedId('tt2911666'), false)
assert.equal(isSimklKeyedId('kitsu:42'), false)

// The account's own library places it.
assert.equal(
  imdbForSimklKeyedId('simkl:342994', snapshot, () => null),
  'tt2911666'
)
// Failing that, the metadata cache the detail page filled.
assert.equal(
  imdbForSimklKeyedId('simkl:999', snapshot, (id) => (id === 'simkl:999' ? 'tt0000999' : null)),
  'tt0000999'
)
// A cache entry that is not an IMDb id is no answer.
assert.equal(
  imdbForSimklKeyedId('simkl:999', snapshot, () => 'simkl:999'),
  null
)
// Nothing at hand: leave it — it is pushable as {simkl} and the next
// snapshot will carry the pairing.
assert.equal(
  imdbForSimklKeyedId('simkl:999', snapshot, () => null),
  null
)
assert.equal(
  imdbForSimklKeyedId('tt2911666', snapshot, () => 'tt2911666'),
  null
)

// --- folding the duplicate into the real row --------------------------------

{
  const db = tempDb()
  const wick = { type: 'movie' as const, title: 'John Wick', year: '2014' }
  db.markWatched({ id: 'simkl:342994', ...wick })
  db.markWatched({ id: 'tt2911666', ...wick })
  db.rate('simkl:342994', 9)
  assert.equal(db.history().filter((h) => h.type === 'movie').length, 2)

  const affected = db.mergeContentId('simkl:342994', 'tt2911666')
  // The real row was already there, so the duplicate yields to it — and
  // the caller still learns a row was folded, so the renderer is told.
  assert.equal(affected, 1)
  const movies = db.history().filter((h) => h.type === 'movie')
  assert.deepEqual(
    movies.map((h) => h.id),
    ['tt2911666']
  )
  // The rating follows, the viewing is not doubled, and nothing is left
  // under the old id.
  assert.equal(db.ratings().get('tt2911666'), 9)
  assert.equal(db.ratings().has('simkl:342994'), false)
  assert.equal(db.plays().filter((p) => p.contentId === 'simkl:342994').length, 0)
  // Two marks seconds apart are one viewing, not a rewatch.
  assert.equal(db.plays().filter((p) => p.contentId === 'tt2911666').length, 1)
}

{
  // No real row yet: the row moves, keeping its type and date, and reads
  // back under the real id.
  const db = tempDb()
  db.markWatched({ id: 'simkl:471618', type: 'movie', title: 'John Wick: Chapter 2' })
  const before = db.history()[0].watchedAt
  assert.equal(db.mergeContentId('simkl:471618', 'tt4425200'), 1)
  const [row] = db.history()
  assert.equal(row.id, 'tt4425200')
  assert.equal(row.type, 'movie')
  assert.equal(row.watchedAt, before)
  assert.equal(db.mergeContentId('tt4425200', 'tt4425200'), 0)
}

console.log('simklKeyedHistory: ok')
