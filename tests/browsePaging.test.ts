// When the phone's Browse grid stops paging and when it starts over
// (src/app-ui/lib/browsePaging.ts, used by src/app-ui/screens/Browse.tsx).
//
// What is pinned: an empty first page stops the paging, but only until the
// index says it changed. On a fresh install the first crawl has not landed
// when the screen first asks, and the grid used to latch "done" on that empty
// page and say "Nothing here yet" until it was opened again. The crawl, the
// deep scan, the household sync and a search title being indexed all send
// library:changed with the 'index' scope (catalogSearch.test.ts pins the
// crawl's); the grid starts over on it. While it waits it says it is still
// loading, and "Nothing here yet" only once it has waited past the screen's
// limit: the crawl lands as several writes, and the empty grid between them
// used to read as a dead end. That limit is measured from the first wait of
// the visit: any kind's index write starts the grid over, and measuring from
// the last of them would keep a kind with nothing in it loading for as long
// as other kinds' writes kept coming.
// Run with: npx tsx tests/browsePaging.test.ts

import assert from 'node:assert/strict'

import {
  browseEmptyNote,
  browsePagingDone,
  browseWaitStart,
  browseWaitingForIndex,
  indexMayHaveGrown
} from '../src/app-ui/lib/browsePaging'

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

check('a full page with more behind it keeps paging', () => {
  assert.equal(browsePagingDone(60, 60, 2000, 300), false)
})

check('the total, the cap or an empty page stops it', () => {
  assert.equal(browsePagingDone(2000, 20, 2000, 3000), true, 'the index ran out')
  assert.equal(browsePagingDone(300, 60, 2000, 300), true, 'the screen cap')
  assert.equal(browsePagingDone(0, 0, 0, 300), true, 'an empty first page')
})

check('an index write or a wholesale change can have grown the grid', () => {
  assert.equal(indexMayHaveGrown({ scopes: ['index'], sources: ['catalog-crawl'] }), true)
  assert.equal(indexMayHaveGrown({ scopes: ['all'], sources: ['anime-regroup'] }), true)
  assert.equal(
    indexMayHaveGrown({ scopes: ['history', 'planned'], sources: ['catch-up'] }),
    false,
    'watch history moving adds no titles to a grid'
  )
})

check('an empty grid that stopped paging cleanly is waiting, not empty', () => {
  const grid = { done: true, loading: false, error: null, count: 0 }
  assert.equal(browseWaitingForIndex(grid), true, 'the first crawl has not landed')
  assert.equal(browseWaitingForIndex({ ...grid, done: false }), false, 'not asked yet')
  assert.equal(browseWaitingForIndex({ ...grid, loading: true }), false, 'still fetching')
  assert.equal(
    browseWaitingForIndex({ ...grid, error: 'Not connected to a backend.' }),
    false,
    'a failure says so itself'
  )
  assert.equal(browseWaitingForIndex({ ...grid, count: 12 }), false, 'titles on screen')
})

check('an empty grid says it is still loading until it has waited too long', () => {
  const waiting = { done: true, loading: false, error: null, count: 0 }
  assert.equal(browseEmptyNote(waiting, false), 'loading', 'the first crawl has not landed')
  assert.equal(
    browseEmptyNote({ ...waiting, done: false }, false),
    'loading',
    'started over on an index write, about to fetch again'
  )
  assert.equal(browseEmptyNote({ ...waiting, loading: true }, false), 'loading', 'fetching')
  assert.equal(browseEmptyNote(waiting, true), 'nothing', 'the crawl found nothing for it')
  assert.equal(
    browseEmptyNote({ ...waiting, done: false }, true),
    'loading',
    'started over by an index write after the wait, and fetching again'
  )
  assert.equal(
    browseEmptyNote({ ...waiting, error: 'Not connected to a backend.' }, false),
    null,
    'a failure says so itself'
  )
  assert.equal(browseEmptyNote({ ...waiting, count: 12 }, true), null, 'titles on screen')
})

check('the wait on the index is measured from the first of the visit', () => {
  const waiting = { done: true, loading: false, error: null, count: 0 }
  const fetching = { ...waiting, done: false, loading: true }
  assert.equal(browseWaitStart(null, fetching, 1_000), null, 'the first page is still out')
  assert.equal(browseWaitStart(null, waiting, 5_000), 5_000, 'the first wait starts the clock')
  // Another kind's index write starts the grid over, and it fetches again.
  assert.equal(browseWaitStart(5_000, { ...waiting, done: false }, 60_000), 5_000, 'started over')
  assert.equal(browseWaitStart(5_000, fetching, 61_000), 5_000, 'fetching again')
  assert.equal(browseWaitStart(5_000, waiting, 62_000), 5_000, 'waiting again, on the same clock')
  assert.equal(browseWaitStart(5_000, { ...waiting, count: 12 }, 63_000), null, 'titles arrived')
  assert.equal(
    browseWaitStart(5_000, { ...waiting, error: 'Not connected to a backend.' }, 63_000),
    null,
    'a failure says so itself'
  )
})

console.log(`\n${pass} passed`)
