// When the phone's Browse grid stops paging and when it starts over
// (src/app-ui/lib/browsePaging.ts, used by src/app-ui/screens/Browse.tsx).
//
// What is pinned: an empty first page stops the paging, but only until the
// index says it changed. On a fresh install the first crawl has not landed
// when the screen first asks, and the grid used to latch "done" on that empty
// page and say "Nothing here yet" until it was opened again. The crawl, the
// deep scan, the household sync and a search title being indexed all send
// library:changed with the 'index' scope (catalogSearch.test.ts pins the
// crawl's); the grid starts over on it.
// Run with: npx tsx tests/browsePaging.test.ts

import assert from 'node:assert/strict'

import { browsePagingDone, indexMayHaveGrown } from '../src/app-ui/lib/browsePaging'

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

console.log(`\n${pass} passed`)
