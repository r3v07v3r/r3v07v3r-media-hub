// What profile scoping and the plays table mean through the real database
// API, rather than through raw SQL — the two behaviours Phase 0 exists to fix.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDatabase } from '../src/main/media-hub/database'

const ALICE = 'profile-alice'
const BOB = 'profile-bob'

const file = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'r3-db-profiles-')),
  'media-hub.sqlite'
)
const db = createDatabase(file, ALICE)

const dune = { id: 'tt1', type: 'movie' as const, title: 'Dune' }
const severance = { id: 'tt2', type: 'series' as const, title: 'Severance' }

// ---------------------------------------------------------------------
// A profile's library is its own.
// ---------------------------------------------------------------------
db.track(dune)
db.markWatched(dune)
db.dislike({ id: 'tt3', type: 'movie', title: 'Cats' })
db.savePlaybackPosition('tt2', { season: 1, episode: 4 }, 600, 2400)

assert.equal(db.isTracked('tt1'), true)
assert.equal(db.history().length, 1)
assert.equal(db.disliked().length, 1)
assert.ok(db.getPlaybackPosition('tt2', { season: 1, episode: 4 }))

db.setActiveProfile(BOB)

// Bob has never used the app. He must not inherit Alice's anything — this is
// the defect the profile column exists to fix, where a Kids profile showed an
// adult's Continue Watching.
assert.equal(db.isTracked('tt1'), false, 'my list is per-profile')
assert.equal(db.tracked().length, 0)
assert.equal(db.history().length, 0, 'watch history is per-profile')
assert.equal(db.disliked().length, 0, 'dislikes are per-profile')
assert.equal(
  db.getPlaybackPosition('tt2', { season: 1, episode: 4 }),
  null,
  'resume points are per-profile'
)

// Bob tracking the same title is a separate row, not a collision.
db.track(dune)
assert.equal(db.isTracked('tt1'), true)
db.setActiveProfile(ALICE)
assert.equal(db.isTracked('tt1'), true, "Bob's row did not overwrite Alice's")
assert.equal(db.tracked().length, 1, 'and did not appear in her list twice')

// An empty id keeps the previous scope rather than silently answering for a
// profile that owns nothing.
db.setActiveProfile('')
assert.equal(db.tracked().length, 1, 'an empty profile id is refused, not applied')

// ---------------------------------------------------------------------
// A rewatch is a second play, not a replacement for the first.
// ---------------------------------------------------------------------
db.markWatched(severance, { season: 1, episode: 1 })
db.markWatched(severance, { season: 1, episode: 2 })

assert.equal(db.history().length, 3, 'Dune plus two episodes')
assert.equal(db.playCounts().get('tt2'), 2)

// Watch episode 1 again. Under the old single-upsert write this moved a
// timestamp and the first viewing stopped having happened.
db.markWatched(severance, { season: 1, episode: 1 })

assert.equal(db.history().length, 3, 'the seen-it index still has one row per episode')
assert.equal(db.playCounts().get('tt2'), 3, 'but the rewatch was recorded as its own play')
assert.equal(db.playCounts().get('tt1'), 1)

// ---------------------------------------------------------------------
// Un-marking is somebody saying they have not seen it, so the plays go too.
// ---------------------------------------------------------------------
assert.equal(db.unmarkWatched('tt2', 1, 1), true)
assert.equal(db.history().length, 2)
assert.equal(db.playCounts().get('tt2'), 1, 'both plays of episode 1 are gone, episode 2 remains')

// Un-marking a movie (null season/episode) matches the movie's own plays and
// nothing else — the `IS` comparison rather than `=`, which never matches NULL.
assert.equal(db.unmarkWatched('tt1'), true)
assert.equal(db.playCounts().has('tt1'), false)
assert.equal(db.playCounts().get('tt2'), 1, 'the series was not touched')

// ---------------------------------------------------------------------
// The scope survives reopening: it is passed in, not remembered in the file.
// ---------------------------------------------------------------------
db.close()
const reopened = createDatabase(file, BOB)
assert.equal(reopened.tracked().length, 1, 'Bob still has his own single tracked title')
assert.equal(reopened.history().length, 0, 'and still none of Alice’s history')
reopened.close()

console.log('database profile tests passed')
