// The repair that moves anime watch history off a merged franchise
// sibling's id and onto the canonical show — see animeSyncRepair.ts for
// why those rows exist and why they are moved rather than re-synced.
//
// Exercises db.remapContentIds directly (the repair's only real work);
// animeSyncRepair's own wrapper is a settings marker and a grouping check
// around this call, and the grouping index it consults needs a populated
// catalog cache rather than a unit test.
//
// Run with: npx tsx tests/animeSyncRepair.test.ts   (or npm.cmd test)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDatabase } from '../src/main/media-hub/database'

const PROFILE = 'profile-repair'

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-anime-repair-'))
  return createDatabase(path.join(dir, 'test.sqlite'), PROFILE)
}

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

const sibling = { id: 'kitsu:sennen', type: 'anime' as const, title: 'Sennen Kessen-hen' }
const canonical = 'kitsu:bleach'

console.log('remapContentIds')

check('moves a sibling’s episodes onto the canonical show at its real season', () => {
  const db = tempDb()
  // Exactly what the old MAL reconcile-apply wrote: the sibling's own id,
  // hardcoded season 1.
  db.markWatched(sibling, { season: 1, episode: 1 })
  db.markWatched(sibling, { season: 1, episode: 2 })

  const moved = db.remapContentIds([{ fromId: 'kitsu:sennen', toId: canonical, seasonOffset: 1 }])

  assert.equal(moved, 2)
  const history = db.history()
  assert.equal(history.filter((h) => h.id === 'kitsu:sennen').length, 0)
  const repaired = history.filter((h) => h.id === canonical)
  assert.equal(repaired.length, 2)
  // seasonOffset 1 means "this sibling is really season 2 of the group".
  assert.deepEqual(repaired.map((h) => h.season).sort(), [2, 2])
  assert.deepEqual(
    repaired.map((h) => h.episode).sort((a, b) => Number(a) - Number(b)),
    [1, 2]
  )
})

check('keeps the row already at the destination rather than overwriting it', () => {
  const db = tempDb()
  // Watched in-app under the canonical id (the row the app has been
  // reading all along), and ALSO left behind under the sibling id by the
  // old sync. The canonical one is the viewing somebody can actually see.
  db.markWatched({ id: canonical, type: 'anime', title: 'Bleach' }, { season: 2, episode: 1 })
  const before = db.history().find((h) => h.id === canonical && h.episode === 1)
  db.markWatched(sibling, { season: 1, episode: 1 })

  db.remapContentIds([{ fromId: 'kitsu:sennen', toId: canonical, seasonOffset: 1 }])

  const history = db.history()
  // The colliding source row is dropped, not duplicated and not merged.
  assert.equal(history.filter((h) => h.id === 'kitsu:sennen').length, 0)
  const at = history.filter((h) => h.id === canonical && h.season === 2 && h.episode === 1)
  assert.equal(at.length, 1)
  assert.equal(at[0].watchedAt, before?.watchedAt)
})

check('preserves the original watched date — the ids were wrong, the viewings were not', () => {
  const db = tempDb()
  db.importWatched([
    {
      id: 'kitsu:sennen',
      type: 'anime',
      title: 'Sennen Kessen-hen',
      season: 1,
      episode: 3,
      watchedAt: '2021-06-01T12:00:00.000Z'
    }
  ])

  db.remapContentIds([{ fromId: 'kitsu:sennen', toId: canonical, seasonOffset: 1 }])

  const moved = db.history().find((h) => h.id === canonical && h.episode === 3)
  assert.equal(moved?.watchedAt, '2021-06-01T12:00:00.000Z')
})

check('carries a rating across, since a rating belongs to the whole show', () => {
  const db = tempDb()
  db.rate('kitsu:sennen', 9)

  db.remapContentIds([{ fromId: 'kitsu:sennen', toId: canonical, seasonOffset: 1 }])

  const ratings = db.ratings()
  assert.equal(ratings.get('kitsu:sennen'), undefined)
  assert.equal(ratings.get(canonical), 9)
})

check('never overwrites a rating already given to the canonical show', () => {
  const db = tempDb()
  db.rate(canonical, 6)
  db.rate('kitsu:sennen', 9)

  db.remapContentIds([{ fromId: 'kitsu:sennen', toId: canonical, seasonOffset: 1 }])

  assert.equal(db.ratings().get(canonical), 6)
})

check('a zero offset leaves seasons alone, for an ungrouped id that still moved', () => {
  const db = tempDb()
  db.markWatched(sibling, { season: 1, episode: 4 })

  db.remapContentIds([{ fromId: 'kitsu:sennen', toId: canonical, seasonOffset: 0 }])

  const moved = db.history().find((h) => h.id === canonical)
  assert.equal(moved?.season, 1)
})

// The rebuilt watch_key is the easiest thing to get subtly wrong — the
// season is bound as a float, so an unguarded cast writes '...:2.0:1' and
// the row is unreachable by every lookup that builds the key the normal
// way. Unmarking is the cheapest proof the key really matches.
check('a repaired row is reachable by the normal watch_key lookup', () => {
  const db = tempDb()
  db.markWatched(sibling, { season: 1, episode: 1 })
  db.remapContentIds([{ fromId: 'kitsu:sennen', toId: canonical, seasonOffset: 1 }])

  assert.equal(db.unmarkWatched(canonical, 2, 1), true)
  assert.equal(db.history().length, 0)
})

check('an empty or self-referential mapping changes nothing', () => {
  const db = tempDb()
  db.markWatched(sibling, { season: 1, episode: 1 })

  assert.equal(db.remapContentIds([]), 0)
  assert.equal(db.remapContentIds([{ fromId: canonical, toId: canonical, seasonOffset: 1 }]), 0)
  assert.equal(db.history().filter((h) => h.id === 'kitsu:sennen').length, 1)
})

console.log(`\n${pass} passed`)
