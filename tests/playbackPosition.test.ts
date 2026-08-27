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
import { DatabaseSync } from 'node:sqlite'
import { createDatabase } from '../src/main/media-hub/database'

// Every connection is scoped to a profile from the moment it opens (see
// createDatabase). These assertions do not depend on which profile it is,
// only that reads and writes agree on one.
const TEST_PROFILE = 'profile-test'

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

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-position-test-'))
  return path.join(dir, 'test.sqlite')
}

function tempDb() {
  return createDatabase(tempDbPath(), TEST_PROFILE)
}

console.log('savePlaybackPosition / getPlaybackPosition — movies')

check('round-trips a saved position', () => {
  const db = tempDb()
  db.savePlaybackPosition('tt1234567', undefined, 1450, 7200)
  const result = db.getPlaybackPosition('tt1234567')
  // volume comes back null, not absent: a bookmark written without one says
  // "nothing was recorded", which is what leaves the title at 100%.
  assert.deepEqual(result, { positionSeconds: 1450, durationSeconds: 7200, volume: null })
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
    durationSeconds: 7200,
    volume: null
  })
  db.close()
})

check('duration is optional — position alone still saves', () => {
  const db = tempDb()
  db.savePlaybackPosition('tt1234567', undefined, 300)
  assert.deepEqual(db.getPlaybackPosition('tt1234567'), {
    positionSeconds: 300,
    durationSeconds: null,
    volume: null
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

console.log('\nvolume travels with the bookmark')

check('the volume in use is stored with the position and read back', () => {
  const db = tempDb()
  db.savePlaybackPosition('tt1234567', undefined, 1450, 7200, 1.6)
  assert.equal(db.getPlaybackPosition('tt1234567')?.volume, 1.6)
  db.close()
})

check('a later save with no volume leaves the stored one alone', () => {
  const db = tempDb()
  db.savePlaybackPosition('tt1234567', undefined, 1450, 7200, 1.6)
  // The periodic saves come from the player and always carry a volume, but any
  // other caller reaching this bookmark is saying nothing about loudness — and
  // must not silently erase a boost by omitting it.
  db.savePlaybackPosition('tt1234567', undefined, 1600, 7200)
  assert.deepEqual(db.getPlaybackPosition('tt1234567'), {
    positionSeconds: 1600,
    durationSeconds: 7200,
    volume: 1.6
  })
  db.close()
})

check('a new volume replaces the stored one', () => {
  const db = tempDb()
  db.savePlaybackPosition('tt1234567', undefined, 1450, 7200, 1.6)
  db.savePlaybackPosition('tt1234567', undefined, 1600, 7200, 1)
  assert.equal(db.getPlaybackPosition('tt1234567')?.volume, 1)
  db.close()
})

check('muting keeps the level the title was being watched at', () => {
  const db = tempDb()
  db.savePlaybackPosition('tt1234567', undefined, 1450, 7200, 1.6)
  // Mute is a thing people do for a minute, not a level to resume at. The
  // bookmark keeps the last AUDIBLE volume: coming back silent would read as
  // a broken player, and coming back at 100% would throw away the boost this
  // title was being watched at, which is the one thing the column is for.
  db.savePlaybackPosition('tt1234567', undefined, 1600, 7200, 0)
  assert.equal(db.getPlaybackPosition('tt1234567')?.volume, 1.6)
  db.close()
})

check('a bookmark cleared by the thresholds takes its volume with it', () => {
  const db = tempDb()
  db.savePlaybackPosition('tt1234567', undefined, 1450, 7200, 1.8)
  // Past 90% is "finished", and a finished title starts over next time — at
  // the ordinary volume, not at the boost the last few minutes needed.
  db.savePlaybackPosition('tt1234567', undefined, 6900, 7200, 1.8)
  assert.equal(db.getPlaybackPosition('tt1234567'), null)
  db.close()
})

check('each episode keeps its own volume', () => {
  const db = tempDb()
  db.savePlaybackPosition('tt7654321', { season: 1, episode: 1 }, 600, 2400, 1.5)
  db.savePlaybackPosition('tt7654321', { season: 1, episode: 2 }, 600, 2400, 1)
  assert.equal(db.getPlaybackPosition('tt7654321', { season: 1, episode: 1 })?.volume, 1.5)
  assert.equal(db.getPlaybackPosition('tt7654321', { season: 1, episode: 2 })?.volume, 1)
  db.close()
})

console.log('\nupgrading a database that predates stored volumes')

check('an existing bookmark table gains the column without losing its rows', () => {
  const dbPath = tempDbPath()
  // The playback_positions table exactly as it was shipped before volume was
  // part of a bookmark. Every installed copy of the app has one of these, so
  // the ALTER guard is the difference between an upgrade and an app that
  // cannot read its own resume points.
  const raw = new DatabaseSync(dbPath)
  raw.exec(`CREATE TABLE playback_positions(
    position_key TEXT PRIMARY KEY,
    content_id TEXT NOT NULL,
    season INTEGER,
    episode INTEGER,
    position_seconds REAL NOT NULL,
    duration_seconds REAL,
    updated_at TEXT NOT NULL
  )`)
  raw
    .prepare(
      'INSERT INTO playback_positions(position_key,content_id,season,episode,position_seconds,duration_seconds,updated_at) VALUES(?,?,?,?,?,?,?)'
    )
    .run('tt1234567:movie:movie', 'tt1234567', null, null, 1450, 7200, new Date().toISOString())
  raw.close()

  const db = createDatabase(dbPath, TEST_PROFILE)
  assert.deepEqual(
    db.getPlaybackPosition('tt1234567'),
    { positionSeconds: 1450, durationSeconds: 7200, volume: null },
    'the bookmark that was already there must survive the upgrade'
  )
  db.savePlaybackPosition('tt1234567', undefined, 1500, 7200, 1.4)
  assert.equal(db.getPlaybackPosition('tt1234567')?.volume, 1.4)
  db.close()
})

console.log('\nseries — season/episode keying')

check('different episodes of the same show keep independent bookmarks', () => {
  const db = tempDb()
  db.savePlaybackPosition('tt7654321', { season: 1, episode: 1 }, 600, 2400)
  db.savePlaybackPosition('tt7654321', { season: 1, episode: 2 }, 1200, 2400)
  assert.deepEqual(db.getPlaybackPosition('tt7654321', { season: 1, episode: 1 }), {
    positionSeconds: 600,
    durationSeconds: 2400,
    volume: null
  })
  assert.deepEqual(db.getPlaybackPosition('tt7654321', { season: 1, episode: 2 }), {
    positionSeconds: 1200,
    durationSeconds: 2400,
    volume: null
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

console.log('\nlistPlaybackPositions - the detail page episode grid')

check('returns every episode bookmark for one title, and nothing from another', () => {
  const db = tempDb()
  db.savePlaybackPosition('kitsu:1', { season: 1, episode: 1 }, 300, 1400)
  db.savePlaybackPosition('kitsu:1', { season: 1, episode: 2 }, 900, 1400)
  db.savePlaybackPosition('kitsu:1', { season: 2, episode: 5 }, 120, 1400)
  db.savePlaybackPosition('kitsu:2', { season: 1, episode: 1 }, 700, 1400)
  const rows = db.listPlaybackPositions('kitsu:1')
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map((r) => `${r.season}:${r.episode}=${r.positionSeconds}`).sort(), [
    '1:1=300',
    '1:2=900',
    '2:5=120'
  ])
  assert.ok(rows.every((r) => r.durationSeconds === 1400))
  db.close()
})

check('a title with no bookmarks at all comes back empty, not null', () => {
  const db = tempDb()
  assert.deepEqual(db.listPlaybackPositions('kitsu:404'), [])
  db.close()
})

check('movie bookmarks report null season/episode, exactly as stored', () => {
  const db = tempDb()
  db.savePlaybackPosition('tt1234567', undefined, 1450, 7200)
  assert.deepEqual(db.listPlaybackPositions('tt1234567'), [
    { season: null, episode: null, positionSeconds: 1450, durationSeconds: 7200 }
  ])
  db.close()
})

check('a bookmark cleared by watching past 90% stops being listed', () => {
  const db = tempDb()
  db.savePlaybackPosition('kitsu:1', { season: 1, episode: 1 }, 300, 1400)
  assert.equal(db.listPlaybackPositions('kitsu:1').length, 1)
  // Same "finished" threshold savePlaybackPosition applies on write - the
  // grid must not keep drawing a resume sliver on an episode that ran out.
  db.savePlaybackPosition('kitsu:1', { season: 1, episode: 1 }, 1300, 1400)
  assert.deepEqual(db.listPlaybackPositions('kitsu:1'), [])
  db.close()
})

console.log(`\n${pass} passed`)
