// Unit tests for the "keep local" push path of the out-of-sync review:
// the persisted decision queue (src/shared/media-hub/reconcileQueue.ts)
// and the two Simkl helpers it pushes through
// (src/main/media-hub/simkl.ts's batchHistoryPayload/unmatchedCatalogIds).
// Run with: npx tsx tests/reconcileSync.test.ts   (or npm.cmd test)
//
// Both modules are imported directly because both are deliberately
// electron-free; the orchestration around them (tracking.ts) pulls in
// `electron` at module load and would need a full app harness.

import assert from 'node:assert'
import type { PendingWatchStatusPush } from '../src/shared/media-hub/types'
import { applyPushOutcome, queuePendingPush } from '../src/shared/media-hub/reconcileQueue'
import { batchHistoryPayload, unmatchedCatalogIds } from '../src/main/media-hub/simkl'

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

function entry(overrides: Partial<PendingWatchStatusPush> = {}): PendingWatchStatusPush {
  return {
    id: 'tt4877122',
    type: 'movie',
    title: 'Split',
    year: '2016',
    remoteWatched: false,
    attempts: 0,
    ...overrides
  }
}

// --- the decision queue ----------------------------------------------------

check('queues a decision', () => {
  const queue = queuePendingPush([], entry())
  assert.equal(queue.length, 1)
  assert.equal(queue[0].id, 'tt4877122')
  assert.equal(queue[0].remoteWatched, false)
})

check('re-deciding the same title replaces it and re-arms its attempts', () => {
  // A push that never landed lets the title resurface for a second
  // ruling — that must not leave two entries fighting over one id, nor
  // inherit the attempt budget the earlier ruling had already burned.
  const stale = entry({ attempts: 3, remoteWatched: true })
  const queue = queuePendingPush([stale], entry({ remoteWatched: false }))
  assert.equal(queue.length, 1)
  assert.equal(queue[0].attempts, 0)
  assert.equal(queue[0].remoteWatched, false)
})

check('records what the remote said, not what the local side said', () => {
  // The local value is deliberately NOT snapshotted: it can change
  // between the click and a delayed or retried push, and the flush is
  // what re-reads it (see tracking.ts's pushPendingToServices). A queue
  // entry that carried a stale `watched: true` would push the exact
  // opposite of local truth once someone unmarked the title.
  const queued = queuePendingPush([], entry({ remoteWatched: false }))[0]
  assert.equal('watched' in queued, false)
  assert.equal(queued.remoteWatched, false)
})

check('a confirmed push leaves the queue', () => {
  const { queue, abandoned } = applyPushOutcome([entry()], ['tt4877122'], [])
  assert.deepEqual(queue, [])
  assert.deepEqual(abandoned, [])
})

check('a failed push stays queued with its attempts bumped', () => {
  const { queue, abandoned } = applyPushOutcome([entry()], [], ['tt4877122'])
  assert.equal(queue.length, 1)
  assert.equal(queue[0].attempts, 1)
  assert.deepEqual(abandoned, [])
})

check('a push that keeps failing is abandoned rather than retried forever', () => {
  const { queue, abandoned } = applyPushOutcome([entry({ attempts: 4 })], [], ['tt4877122'], 5)
  assert.deepEqual(queue, [])
  assert.equal(abandoned.length, 1)
  assert.equal(abandoned[0].attempts, 5)
})

check('entries queued during a flush keep their untouched state', () => {
  // Whatever the in-flight batch decided says nothing about a decision
  // made after that batch was snapshotted.
  const arrivedLate = entry({ id: 'tt0770828', title: 'Man of Steel' })
  const { queue } = applyPushOutcome([entry(), arrivedLate], ['tt4877122'], [])
  assert.deepEqual(queue, [arrivedLate])
})

// --- batched payloads ------------------------------------------------------

check('batches many movies into one request body', () => {
  const payload = batchHistoryPayload([
    { item: { id: 'tt4877122', type: 'movie', title: 'Split', year: '2016' } },
    { item: { id: 'tt2975590', type: 'movie', title: 'Batman v Superman', year: '2016' } }
  ])
  assert.equal(payload.movies?.length, 2)
  assert.equal(payload.movies?.[0].ids.imdb, 'tt4877122')
  assert.equal(payload.movies?.[1].year, 2016)
  assert.equal(payload.shows, undefined)
  assert.equal(payload.anime, undefined)
})

check('keeps each kind in its own bucket, with episode blocks intact', () => {
  const payload = batchHistoryPayload([
    { item: { id: 'tt4877122', type: 'movie', title: 'Split', year: '2016' } },
    { item: { id: 'tt0903747', type: 'series', title: 'Breaking Bad', year: '2008' } },
    {
      item: { id: 'kitsu:1', type: 'anime', title: 'Cowboy Bebop', year: '1998' },
      playback: { season: 1, episode: 3 }
    }
  ])
  assert.equal(payload.movies?.length, 1)
  assert.equal(payload.shows?.length, 1)
  assert.equal(payload.anime?.length, 1)
  assert.equal(payload.anime?.[0].seasons[0].episodes[0].number, 3)
  assert.equal(payload.anime?.[0].ids.kitsu, 1)
})

check('an empty batch produces an empty body, not empty arrays', () => {
  assert.deepEqual(batchHistoryPayload([]), {})
})

// --- accepted-but-unmatched detection --------------------------------------

const pushed = [
  { id: 'tt4877122', type: 'movie' as const, title: 'Split', year: '2016' },
  { id: 'tt2975590', type: 'movie' as const, title: 'Batman v Superman', year: '2016' }
]

check('reports nothing unmatched for a clean response', () => {
  assert.deepEqual(unmatchedCatalogIds({}, pushed), [])
  assert.deepEqual(unmatchedCatalogIds({ not_found: { movies: [] } }, pushed), [])
  assert.deepEqual(unmatchedCatalogIds(null, pushed), [])
})

check('attributes a not_found entry back to the catalog id that was pushed', () => {
  // This is the whole point: Simkl answers 200 here, so without reading
  // not_found the caller would call this push a success, drop the
  // decision, and let the same title come back on the next launch.
  const unmatched = unmatchedCatalogIds(
    { not_found: { movies: [{ ids: { imdb: 'tt2975590' } }] } },
    pushed
  )
  assert.deepEqual(unmatched, ['tt2975590'])
})

check('matches ids case-insensitively', () => {
  const unmatched = unmatchedCatalogIds(
    { not_found: { movies: [{ ids: { imdb: 'TT4877122' } }] } },
    pushed
  )
  assert.deepEqual(unmatched, ['tt4877122'])
})

check('ignores not_found entries that carry no ids to attribute', () => {
  // Nothing can be pinned on a specific title here, and guessing would
  // mean retrying pushes that did land. If one genuinely didn't, the
  // disagreement resurfaces on a later check instead.
  assert.deepEqual(unmatchedCatalogIds({ not_found: { movies: [{}] } }, pushed), [])
})

check('attributes anime by its non-IMDb id space too', () => {
  const unmatched = unmatchedCatalogIds({ not_found: { anime: [{ ids: { kitsu: 7 } }] } }, [
    { id: 'kitsu:7', type: 'anime', title: 'Trigun', year: '1998' }
  ])
  assert.deepEqual(unmatched, ['kitsu:7'])
})

console.log(`\n${pass} passing`)
