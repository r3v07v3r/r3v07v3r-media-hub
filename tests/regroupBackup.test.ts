// When the anime regroup writes a backup first (animeSyncRepair.ts's
// regroupMovesHeldRows).
//
// A regroup plan names every show whose grouping changed across the whole
// catalog, and almost none of them is one anybody here has watched. Backing
// up for every such plan wrote an anime-regroup backup on every grouping
// change, and the newest of those is the one the rotation keeps
// (autoBackup.ts), so a no-op one replaced the backup taken before a regroup
// that did move rows.
//
// Run with: npx tsx tests/regroupBackup.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { regroupMovesHeldRows } from '../src/main/media-hub/animeSyncRepair'
import { createDatabase } from '../src/main/media-hub/database'

const PROFILE = 'profile-regroup-backup'

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-regroup-backup-'))
const db = createDatabase(path.join(dir, 'test.sqlite'), PROFILE)
db.markWatched({ id: 'kitsu:1', type: 'anime', title: 'Watched here' }, { season: 1, episode: 1 })
// Shows somebody started or rated without a row of history: the regroup
// moves a resume point and a rating too, and a backup carries both.
db.savePlaybackPosition('kitsu:4', { season: 1, episode: 2 }, 600, 1400)
db.rate('kitsu:5', 8)
const held = (): string[] => db.animeRowIds()

const move = (fromId: string) => ({ fromId, fromSeason: null, toId: 'kitsu:99', toSeason: 1 })
const rating = (fromId: string) => ({ fromId, toId: 'kitsu:99' })

check('an empty plan writes no backup, and the held ids are not read', () => {
  let read = false
  const result = regroupMovesHeldRows({ moves: [], ratings: [] }, () => {
    read = true
    return []
  })
  assert.equal(result, false)
  assert.equal(read, false)
})

check('a plan that only moves shows nobody here has watched writes no backup', () => {
  assert.equal(
    regroupMovesHeldRows(
      {
        moves: [move('kitsu:2'), move('kitsu:3')],
        ratings: [rating('kitsu:2')]
      },
      held
    ),
    false
  )
})

check('a plan that moves a show with history here writes one', () => {
  assert.equal(regroupMovesHeldRows({ moves: [move('kitsu:2'), move('kitsu:1')] }, held), true)
})

check('a rating move under a held id counts as well', () => {
  assert.equal(regroupMovesHeldRows({ moves: [], ratings: [rating('kitsu:1')] }, held), true)
})

check('a show held only as a resume point writes one', () => {
  assert.equal(regroupMovesHeldRows({ moves: [move('kitsu:4')] }, held), true)
})

check('a show held only as a rating writes one', () => {
  assert.equal(regroupMovesHeldRows({ moves: [], ratings: [rating('kitsu:5')] }, held), true)
  assert.equal(regroupMovesHeldRows({ moves: [move('kitsu:5')] }, held), true)
})

check('an id that is not a Kitsu id is taken to hold rows', () => {
  assert.equal(regroupMovesHeldRows({ moves: [move('tt123')] }, held), true)
})

// It is asked from inside the regroup's write: a throw would stop the move.
check('a failed read of the held ids backs up rather than throwing', () => {
  assert.equal(
    regroupMovesHeldRows({ moves: [move('kitsu:2')] }, () => {
      throw new Error('Local database error: busy')
    }),
    true
  )
})

db.close()
console.log(`\n${pass} passed`)
