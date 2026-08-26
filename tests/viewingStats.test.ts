// What the viewing adds up to.
//
// Worth testing because almost every number here has a "which one does it
// count" question behind it: a rewatch is another viewing but not another
// title, runtime belongs to the title but time spent belongs to the play, and
// a month with nothing in it still has to appear or the chart lies about the
// shape of the year.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDatabase } from '../src/main/media-hub/database'

const PROFILE = 'profile-stats'

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-stats-'))
  return createDatabase(path.join(dir, 'test.sqlite'), PROFILE)
}

// ---------------------------------------------------------------------
// Nothing watched is a real state, not an error.
// ---------------------------------------------------------------------
{
  const db = tempDb()
  const stats = db.viewingStats()
  assert.equal(stats.totalPlays, 0)
  assert.equal(stats.totalTitles, 0)
  assert.equal(stats.estimatedHours, 0)
  assert.deepEqual(stats.topGenres, [])
  assert.deepEqual(stats.mostPlayed, [])
  // The twelve-month window is always twelve months, even with nothing in it.
  assert.equal(stats.byMonth.length, 12)
  assert.ok(stats.byMonth.every((point) => point.plays === 0))
  db.close()
}

// ---------------------------------------------------------------------
// Counting.
// ---------------------------------------------------------------------
{
  const db = tempDb()
  const dune = {
    id: 'tt1',
    type: 'movie' as const,
    title: 'Dune',
    genres: ['Sci-Fi', 'Drama'],
    runtime: '155 min'
  }
  const severance = {
    id: 'tt2',
    type: 'series' as const,
    title: 'Severance',
    genres: ['Drama'],
    runtime: '48 min'
  }

  db.markWatched(dune)
  db.markWatched(dune) // a rewatch
  db.markWatched(severance, { season: 1, episode: 1 })
  db.markWatched(severance, { season: 1, episode: 2 })

  const stats = db.viewingStats()

  assert.equal(stats.totalPlays, 4, 'every viewing counts, rewatches included')
  assert.equal(stats.totalTitles, 2, 'but a title watched twice is still one title')

  // Runtime belongs to the title; time spent belongs to the play. Two viewings
  // of a 155-minute film plus two 48-minute episodes is 406 minutes.
  assert.equal(stats.estimatedHours, Math.round((155 * 2 + 48 * 2) / 60))

  // Drama is on both titles and so leads Sci-Fi, which is on one.
  assert.equal(stats.topGenres[0].genre, 'Drama')
  assert.equal(stats.topGenres[0].plays, 4)
  assert.equal(stats.topGenres[1].genre, 'Sci-Fi')
  assert.equal(stats.topGenres[1].plays, 2)

  const kinds = Object.fromEntries(stats.byKind.map((entry) => [entry.kind, entry.plays]))
  assert.equal(kinds.movie, 2)
  assert.equal(kinds.series, 2)

  // Only titles seen more than once — a list of everything watched once would
  // just be the history again.
  assert.deepEqual(
    stats.mostPlayed.map((entry) => entry.title),
    ['Dune']
  )
  assert.equal(stats.mostPlayed[0].plays, 2)

  // Everything just written lands in the current month, which is the last
  // point in the window.
  assert.equal(stats.byMonth.at(-1)?.plays, 4)
  assert.equal(stats.byMonth.length, 12)
  db.close()
}

// ---------------------------------------------------------------------
// Runtimes come from metadata written by several sources, in several shapes.
// ---------------------------------------------------------------------
{
  const db = tempDb()
  db.markWatched({ id: 'a', type: 'movie', title: 'Plain number', runtime: '120' })
  db.markWatched({ id: 'b', type: 'movie', title: 'With units', runtime: '90 min' })
  // No runtime at all contributes nothing rather than throwing off the total
  // with a guess.
  db.markWatched({ id: 'c', type: 'movie', title: 'Unknown length' })
  db.markWatched({ id: 'd', type: 'movie', title: 'Nonsense', runtime: 'ages' })

  assert.equal(db.viewingStats().estimatedHours, Math.round((120 + 90) / 60))
  db.close()
}

// ---------------------------------------------------------------------
// Per profile, like everything else a profile owns.
// ---------------------------------------------------------------------
{
  const db = tempDb()
  db.markWatched({ id: 'tt1', type: 'movie', title: 'Dune', runtime: '155 min' })
  assert.equal(db.viewingStats().totalPlays, 1)

  db.setActiveProfile('someone-else')
  assert.equal(db.viewingStats().totalPlays, 0, 'a second profile starts from nothing')
  db.close()
}

console.log('viewing stats tests passed')
