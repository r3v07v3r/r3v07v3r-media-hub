// Unit tests for resume-position storage (src/main/media-hub/database.ts's
// savePlaybackPosition/getPlaybackPosition) — real bookmarks in a real
// temp SQLite file, not mocked, matching databasePruning.test.ts's own
// approach for the same reason: the interesting behavior here is SQL
// (upsert semantics, the synthetic key sidestepping SQLite's NULL-vs-NULL
// non-uniqueness for movies' null season/episode) that a mock would paper
// over rather than prove.
//
// Run with: npx tsx tests/playbackPosition.test.ts   (or npm.cmd test)

import assert from 'node:assert'
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

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-position-test-'))
  return createDatabase(path.join(dir, 'test.sqlite'))
}

console.log('savePlaybackPosition / getPlaybackPosition — movies')

check('round-trips a saved position', () => {
  const db = tempDb()
  db.savePlaybackPosition('tt1234567', undefined, 1450, 7200)
  const result = db.getPlaybackPosition('tt1234567')
  assert.deepEqual(result, { positionSeconds: 1450, durationSeconds: 7200 })
  db.close()
})

check('a title never saved returns null', () => {
  const db = tempDb()
  assert.equal(db.getPlaybackPosition('tt9999999'), null)
  db.close()
})

check('saving again for the same movie overwrites, not duplicates', () => {
  const db = tempDb()
  db.savePlaybackPosition('tt1234567', undefined, 500, 7200)
  db.savePlaybackPosition('tt1234567', undefined, 1500, 7200)
  assert.deepEqual(db.getPlaybackPosition('tt1234567'), {
    positionSeconds: 1500,
    durationSeconds: 7200
  })
  db.close()
})

check('duration is optional — position alone still saves', () => {
  const db = tempDb()
  db.savePlaybackPosition('tt1234567', undefined, 300)
  assert.deepEqual(db.getPlaybackPosition('tt1234567'), {
    positionSeconds: 300,
    durationSeconds: null
  })
  db.close()
})

console.log('\nauto-clear thresholds')

check('under 20 seconds in is never stored at all', () => {
  const db = tempDb()
  db.savePlaybackPosition('tt1234567', undefined, 10, 7200)
  assert.equal(db.getPlaybackPosition('tt1234567'), null)
  db.close()
})

check('exactly the threshold (20s) IS stored — only strictly under it is skipped', () => {
  const db = tempDb()
  db.savePlaybackPosition('tt1234567', undefined, 20, 7200)
  assert.ok(db.getPlaybackPosition('tt1234567'))
  db.close()
})

check('90%+ through clears an existing bookmark rather than storing one', () => {
  const db = tempDb()
  db.savePlaybackPosition('tt1234567', undefined, 3600, 7200)
  assert.ok(db.getPlaybackPosition('tt1234567'), 'sanity: the mid-way save landed')
  db.savePlaybackPosition('tt1234567', undefined, 6800, 7200) // ~94%
  assert.equal(db.getPlaybackPosition('tt1234567'), null)
  db.close()
})

check('just under 90% is still stored (the boundary is real, not approximate)', () => {
  const db = tempDb()
  db.savePlaybackPosition('tt1234567', undefined, 6400, 7200) // ~88.9%
  assert.ok(db.getPlaybackPosition('tt1234567'))
  db.close()
})

check(
  'with no known duration, "near the end" can never trigger — position alone cannot tell',
  () => {
    const db = tempDb()
    db.savePlaybackPosition('tt1234567', undefined, 100000) // huge, but no duration to compare against
    assert.ok(db.getPlaybackPosition('tt1234567'))
    db.close()
  }
)

console.log('\nseries — season/episode keying')

check('different episodes of the same show keep independent bookmarks', () => {
  const db = tempDb()
  db.savePlaybackPosition('tt7654321', { season: 1, episode: 1 }, 600, 2400)
  db.savePlaybackPosition('tt7654321', { season: 1, episode: 2 }, 1200, 2400)
  assert.deepEqual(db.getPlaybackPosition('tt7654321', { season: 1, episode: 1 }), {
    positionSeconds: 600,
    durationSeconds: 2400
  })
  assert.deepEqual(db.getPlaybackPosition('tt7654321', { season: 1, episode: 2 }), {
    positionSeconds: 1200,
    durationSeconds: 2400
  })
  db.close()
})

check('different seasons, same episode number, stay independent', () => {
  const db = tempDb()
  db.savePlaybackPosition('tt7654321', { season: 1, episode: 3 }, 100, 2400)
  db.savePlaybackPosition('tt7654321', { season: 2, episode: 3 }, 900, 2400)
  assert.equal(db.getPlaybackPosition('tt7654321', { season: 1, episode: 3 })?.positionSeconds, 100)
  assert.equal(db.getPlaybackPosition('tt7654321', { season: 2, episode: 3 })?.positionSeconds, 900)
  db.close()
})

check('a movie bookmark and a series bookmark never collide on content_id alone', () => {
  const db = tempDb()
  // Same raw id used two different ways is a contrived case, but proves
  // the synthetic key (id:season:episode vs id:movie:movie) genuinely
  // disambiguates rather than coincidentally working.
  db.savePlaybackPosition('tt0000001', undefined, 500, 6000)
  db.savePlaybackPosition('tt0000001', { season: 1, episode: 1 }, 300, 1200)
  assert.equal(db.getPlaybackPosition('tt0000001')?.positionSeconds, 500)
  assert.equal(db.getPlaybackPosition('tt0000001', { season: 1, episode: 1 })?.positionSeconds, 300)
  db.close()
})

check(
  'two different movies both parked with no season/episode do not collide — the SQLite NULL-uniqueness gotcha this schema is designed around',
  () => {
    const db = tempDb()
    db.savePlaybackPosition('tt1111111', undefined, 400, 5000)
    db.savePlaybackPosition('tt2222222', undefined, 800, 5000)
    assert.equal(db.getPlaybackPosition('tt1111111')?.positionSeconds, 400)
    assert.equal(db.getPlaybackPosition('tt2222222')?.positionSeconds, 800)
    db.close()
  }
)

check('numeric ids (as some catalog sources use) work the same as string ids', () => {
  const db = tempDb()
  db.savePlaybackPosition(42, undefined, 300, 6000)
  assert.equal(db.getPlaybackPosition(42)?.positionSeconds, 300)
  assert.equal(db.getPlaybackPosition('42')?.positionSeconds, 300)
  db.close()
})

console.log(`\n${pass} passed`)
