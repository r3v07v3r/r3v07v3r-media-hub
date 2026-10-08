// The Sync review panel's per-side picture of a show
// (src/shared/media-hub/showSyncSides.ts).
//
// Pinned: each side's own set is worked back from the merged `held` and the
// row's parts, so the bubbles show what "Use" beside that side would leave
// everywhere; a season is green only against a known total; a season a
// service cannot be sent is marked on that service's line; specials are
// left out.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { seasonTotals, showSyncSides } from '../src/shared/media-hub/showSyncSides'

const ep = (season: number, episode: number): { season: number; episode: number } => ({
  season,
  episode
})
const run = (season: number, from: number, to: number): { season: number; episode: number }[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ep(season, from + i))

test('here is held minus what arrived; a service is held minus what it lacked', () => {
  // Here had S1 whole and S2E1-5. Simkl had S1 whole and S2E1-8: 6-8 arrived.
  // Trakt had only S1E1-10: S1E11-12 and all of S2 were sent to it.
  const held = [...run(1, 1, 12), ...run(2, 1, 8)]
  const sides = showSyncSides(
    {
      held,
      services: {
        simkl: { arrived: run(2, 6, 8), sent: [], unsendable: [], blockedSeasons: [] },
        trakt: {
          arrived: [],
          sent: [...run(1, 11, 12), ...run(2, 1, 8)],
          unsendable: [],
          blockedSeasons: []
        }
      }
    },
    new Map([
      [1, 12],
      [2, 12]
    ])
  )
  assert.deepEqual(
    sides.map((side) => side.key),
    ['local', 'simkl', 'trakt']
  )
  const [local, simkl, trakt] = sides
  assert.deepEqual(
    local.seasons.map((s) => [s.season, s.state, s.last]),
    [
      [1, 'done', 12],
      [2, 'part', 5]
    ]
  )
  assert.deepEqual(
    simkl.seasons.map((s) => [s.season, s.state, s.last]),
    [
      [1, 'done', 12],
      [2, 'part', 8]
    ]
  )
  assert.deepEqual(
    trakt.seasons.map((s) => [s.season, s.state, s.last]),
    [
      [1, 'part', 10],
      [2, 'none', 0]
    ]
  )
})

test('no total means no green, and a season the service cannot take is marked', () => {
  const sides = showSyncSides({
    held: run(2, 1, 12),
    services: {
      simkl: { arrived: [], sent: [], unsendable: run(2, 1, 12), blockedSeasons: [2] }
    }
  })
  const [local, simkl] = sides
  assert.deepEqual(local.seasons, [
    { season: 2, watched: 12, last: 12, total: 0, state: 'part', blocked: false }
  ])
  assert.deepEqual(simkl.seasons, [
    { season: 2, watched: 0, last: 0, total: 0, state: 'none', blocked: true }
  ])
})

test('seasons come from the totals too, and specials are left out everywhere', () => {
  const sides = showSyncSides(
    {
      held: [ep(0, 1), ep(1, 1)],
      services: { trakt: { arrived: [ep(1, 1)], sent: [], unsendable: [], blockedSeasons: [] } }
    },
    seasonTotals([
      { season: 0 },
      { season: 1 },
      { season: 1 },
      { season: 2 },
      { season: 2, unplayable: true }
    ])
  )
  assert.deepEqual(
    sides[0].seasons.map((s) => [s.season, s.total, s.state]),
    [
      [1, 2, 'none'],
      [2, 1, 'none']
    ]
  )
  assert.deepEqual(
    sides[1].seasons.map((s) => [s.season, s.state, s.last]),
    [
      [1, 'part', 1],
      [2, 'none', 0]
    ]
  )
})
