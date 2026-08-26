// Unit tests for the stored suggestion list
// (src/main/media-hub/recommendations.ts).
//
// The whole design rests on one split, and that is what these tests are
// really about: the RANKING is allowed to be hours old, the MEMBERSHIP is
// not. A stored list that keeps offering a title after it has been watched,
// saved to My List or marked "not interested" is the failure that would
// make the Home row feel broken — worse than the launch stall the store
// exists to remove, because it is wrong rather than merely slow.
//
// So the read path is exercised against a REAL database (createDatabase is
// pure node:sqlite — see databasePruning.test.ts, which does the same) with
// real track/dislike/markWatched writes behind it, rather than a fake that
// could agree with a wrong assumption about how getCache round-trips a
// payload.
//
// Run with: npx tsx tests/recommendations.test.ts   (or npm.cmd test)

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase, type MediaHubDatabase } from '../src/main/media-hub/database'
import { setDatabase } from '../src/main/media-hub/dbState'
import {
  SERVED_COUNT,
  STORED_COUNT,
  STORE_KEY,
  liveExclusions,
  onRebuildRequested,
  readStoredRecommendations,
  requestRecommendationsRebuild,
  storeRecommendations
} from '../src/main/media-hub/recommendations'
import type { CatalogItem, HistoryEntry } from '../src/shared/media-hub/types'
import type { ScoredRecommendation } from '../src/shared/media-hub/catalog-logic'

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

function item(id: string): CatalogItem {
  return {
    id,
    title: `Title ${id}`,
    type: 'movie',
    poster: '',
    background: '',
    logo: '',
    year: '2024',
    description: '',
    rating: '7',
    runtime: '',
    genres: ['Action'],
    videos: [],
    trailers: []
  }
}

function items(count: number): CatalogItem[] {
  return Array.from({ length: count }, (_, i) => item(`id-${i}`))
}

/** Ranked entries, best first — descending scores so the stored order is unambiguous. */
function ranked(count: number): ScoredRecommendation[] {
  return items(count).map((entry, i) => ({ item: entry, score: 1000 - i }))
}

// No history means no cadence signal, so these cases exercise the stored
// order itself rather than the time-of-day pass over it — which has its
// own tests in catalogRecommendations.test.ts.
const NO_HISTORY: HistoryEntry[] = []

/** A fresh database per case, so one test's tracked/disliked rows cannot leak into the next. */
function freshDatabase(): MediaHubDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-recommendations-test-'))
  // Scoped to a profile from the moment it opens (see createDatabase). Which
  // profile does not matter here, only that writes and reads share one.
  const db = createDatabase(path.join(dir, 'test.sqlite'), 'profile-test')
  setDatabase(db)
  return db
}

/** Counts rebuild requests for one case, and unwires itself afterwards. */
function countingListener(): { count: () => number; stop: () => void } {
  let seen = 0
  onRebuildRequested(() => {
    seen += 1
  })
  return { count: () => seen, stop: () => onRebuildRequested(null) }
}

check('serves the stored ranking, in order, without reaching for a catalog', () => {
  freshDatabase()
  storeRecommendations(ranked(STORED_COUNT), ['Action'])

  const served = readStoredRecommendations(
    { watchedIds: new Set(), trackedIds: new Set(), dislikedIds: new Set() },
    NO_HISTORY
  )

  assert.ok(served, 'expected the stored list to be served')
  assert.equal(served.items.length, SERVED_COUNT)
  assert.equal(served.items[0].id, 'id-0', 'stored order must survive the round trip')
  assert.equal(served.items[SERVED_COUNT - 1].id, `id-${SERVED_COUNT - 1}`)
  assert.deepEqual(served.preferredGenres, ['Action'])
})

check('drops what has been watched, saved or hidden since the list was built', () => {
  const db = freshDatabase()
  storeRecommendations(ranked(STORED_COUNT), ['Action'])

  // Exactly the three things that can happen to a suggestion between two
  // rebuilds, each through the real handler path the app uses.
  db.markWatched(item('id-0'), {})
  db.track(item('id-1'))
  db.dislike(item('id-2'))

  const served = readStoredRecommendations(liveExclusions(db.history()), db.history())

  assert.ok(served, 'three exclusions out of forty must still fill the row')
  const ids = served.items.map((x) => x.id)
  for (const gone of ['id-0', 'id-1', 'id-2']) {
    assert.ok(!ids.includes(gone), `${gone} should not be served after being excluded`)
  }
  assert.equal(served.items.length, SERVED_COUNT, 'the buffer should absorb the exclusions')
  assert.equal(ids[0], 'id-3', 'the next-best surviving title takes the top slot')
})

check('reports a miss when too little of the stored list survives', () => {
  freshDatabase()
  // Only just enough to fill the row before exclusions, so a handful of
  // them takes it under.
  storeRecommendations(ranked(SERVED_COUNT + 2), [])

  const served = readStoredRecommendations(
    {
      watchedIds: new Set(['id-0', 'id-1', 'id-2']),
      trackedIds: new Set(),
      dislikedIds: new Set()
    },
    NO_HISTORY
  )

  assert.equal(served, null, 'a short row must fall back to ranking live, not be served short')
})

check('a miss asks for a rebuild', () => {
  freshDatabase()
  const listener = countingListener()
  try {
    const served = readStoredRecommendations(
      { watchedIds: new Set(), trackedIds: new Set(), dislikedIds: new Set() },
      NO_HISTORY
    )
    assert.equal(served, null, 'nothing has been stored yet')
    assert.equal(listener.count(), 1, 'the empty read should ask for a rebuild')
  } finally {
    listener.stop()
  }
})

check('an aged list is still served, and asks to be replaced on the way past', () => {
  const db = freshDatabase()
  storeRecommendations(ranked(STORED_COUNT), [])

  // Older than the rebuild window. Rewritten rather than faked with a
  // clock, so the payload travels the same putCache/getCache path the app
  // uses — including the JSON round trip that `builtAt` has to survive.
  const stored = db.getCache<{
    entries: ScoredRecommendation[]
    builtAt: number
    preferredGenres: string[]
  }>(STORE_KEY, { allowExpired: true })
  assert.ok(stored, 'the list should have been written')
  db.putCache(
    STORE_KEY,
    { ...stored, builtAt: Date.now() - 7 * 24 * 60 * 60 * 1000 },
    30 * 24 * 60 * 60 * 1000
  )

  const listener = countingListener()
  try {
    const served = readStoredRecommendations(
      { watchedIds: new Set(), trackedIds: new Set(), dislikedIds: new Set() },
      NO_HISTORY
    )
    assert.ok(served, 'age is a reason to rebuild, never a reason to show nothing')
    assert.equal(served.items.length, SERVED_COUNT)
    assert.equal(listener.count(), 1, 'the stale read should ask for a rebuild')
  } finally {
    listener.stop()
  }
})

check('keeps more than it serves, so exclusions have somewhere to eat into', () => {
  const db = freshDatabase()
  storeRecommendations(ranked(500), [])

  const stored = db.getCache<{ entries: ScoredRecommendation[] }>(STORE_KEY, { allowExpired: true })
  assert.ok(stored)
  assert.equal(stored.entries.length, STORED_COUNT)
  assert.ok(STORED_COUNT > SERVED_COUNT, 'the buffer is the whole point of storing extra')
})

check('storing nothing leaves the previous list alone', () => {
  const db = freshDatabase()
  storeRecommendations(ranked(STORED_COUNT), ['Action'])
  // A rebuild that found no catalog must not replace a working list with
  // an empty one — a momentarily unreachable source is not a reason to
  // empty somebody's Home row.
  storeRecommendations([], [])

  const stored = db.getCache<{ entries: ScoredRecommendation[] }>(STORE_KEY, { allowExpired: true })
  assert.ok(stored)
  assert.equal(stored.entries.length, STORED_COUNT)
})

check('a silent store still writes — it only skips the announcement', () => {
  const db = freshDatabase()
  // The cold path in home:personalized stores this way: it is about to
  // return the same list to the same renderer, so the push would only ask
  // for a refetch of what is already in flight.
  storeRecommendations(ranked(STORED_COUNT), ['Action'], { announce: false })

  const stored = db.getCache<{ entries: ScoredRecommendation[] }>(STORE_KEY, { allowExpired: true })
  assert.ok(stored, 'announce: false must not mean "do not store"')
  assert.equal(stored.entries.length, STORED_COUNT)
})

check('a rebuild request with nothing listening is a no-op, not a throw', () => {
  onRebuildRequested(null)
  assert.doesNotThrow(() => requestRecommendationsRebuild())
})

console.log(`\n${pass} passed`)
