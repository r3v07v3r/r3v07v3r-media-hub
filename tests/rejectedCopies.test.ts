// Forgetting the wrong-copy marks (PR after #229, the maintainer's 2026-11-07
// decision: "make sure we can clear the bans in case somebody misclicks").
//
// "Wrong copy? Find another" remembers the copy against its episode for a
// year under `rejected:v1:<type>:<id>` in catalog_cache (torbox.ts). The
// Caching section's Forget wrong-copy marks counts those rows and deletes
// them, through two prefix operations on the database that nothing else
// has needed before. Pinned here:
//
// - the count is of LIVE marks only: an expired row is no longer a ban and
//   must not make the button appear for nothing;
// - the delete removes every row under the prefix, expired or not, and
//   says how many, leaving every other cache row alone;
// - the prefix is matched literally: `_` and `%` in a prefix are escaped,
//   so a prefix cannot reach rows that merely look alike;
// - the renderer offers the control only while the count is above zero
//   (the availability rule) and nothing else sets the count.
// Run with: npx tsx tests/rejectedCopies.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../src/main/media-hub/database'

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

function openDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-rejected-copies-'))
  return createDatabase(path.join(dir, 'test.sqlite'), 'profile-under-test')
}

const YEAR = 365 * 24 * 60 * 60 * 1000
const PREFIX = 'rejected:v1:'

check('live marks are counted; an expired one is not', () => {
  const db = openDb()
  db.putCache(`${PREFIX}series:tt1:1:1`, ['a'], YEAR)
  db.putCache(`${PREFIX}series:tt1:1:2`, ['b', 'c'], YEAR)
  db.putCache(`${PREFIX}movie:tt2`, ['d'], -1)
  db.putCache('tmdb:season:1:1', [], YEAR)
  assert.equal(db.countCacheByPrefix(PREFIX), 2)
})

check('forgetting removes every mark, expired included, and nothing else', () => {
  const db = openDb()
  db.putCache(`${PREFIX}series:tt1:1:1`, ['a'], YEAR)
  db.putCache(`${PREFIX}movie:tt2`, ['d'], -1)
  db.putCache('tmdb:season:1:1', [], YEAR)
  db.putCache('rejected:v0:old', ['x'], YEAR)
  assert.equal(db.deleteCacheByPrefix(PREFIX), 2)
  assert.equal(db.countCacheByPrefix(PREFIX), 0)
  assert.deepEqual(db.getCache('tmdb:season:1:1'), [])
  assert.deepEqual(db.getCache('rejected:v0:old'), ['x'])
  assert.equal(db.deleteCacheByPrefix(PREFIX), 0, 'a second forget has nothing to do')
})

check('a prefix is matched literally, not as a LIKE pattern', () => {
  const db = openDb()
  db.putCache('a_b:1', 1, YEAR)
  db.putCache('axb:1', 2, YEAR)
  db.putCache('a%b:1', 3, YEAR)
  assert.equal(db.countCacheByPrefix('a_b:'), 1)
  assert.equal(db.countCacheByPrefix('a%b:'), 1)
  assert.equal(db.deleteCacheByPrefix('a_b:'), 1)
  assert.equal(db.getCache('axb:1'), 2)
  assert.equal(db.getCache('a%b:1'), 3)
})

check('the control is offered only while there is a mark to forget', () => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      'src',
      'renderer',
      'src',
      'components',
      'controlcentre',
      'sections',
      'CachingSection.tsx'
    ),
    'utf8'
  )
  assert.match(source, /\{rejectedEpisodes > 0 && \([\s\S]*?Forget wrong-copy marks/)
  // The poll fills the count and the button zeroes it; nothing else writes it.
  const writes = source.match(/setRejectedEpisodes\(/g) ?? []
  assert.equal(writes.length, 2, 'the poll and the button are the only writers')
  assert.match(source, /media\.stream\.rejectedCount\(\)\.catch\(\(\) => \(\{ episodes: 0 \}\)\)/)
})

console.log(`\n${pass} passed`)
