// Home's Plan to Watch row (plannedList in core.ts).
//
// It is the complement of Continue Watching, and the two have to agree: a
// show in both rows reads as a bug, and a show in neither has vanished from
// Home. What is pinned here is where that line falls — a film watched, a
// show started, a show with only a special watched, a show whose episode
// list never loaded — and that a merged anime franchise is one tile.
//
// Run with: npx tsx tests/homeRows.test.ts

import assert from 'node:assert/strict'

import { plannedList } from '../src/main/media-hub/core'
import type { MediaKind, TrackedItem } from '../src/shared/media-hub/types'

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

function item(id: string, type: MediaKind, poster = ''): TrackedItem {
  return {
    id,
    simklId: null,
    type,
    title: id,
    poster,
    background: '',
    logo: '',
    year: '',
    genres: [],
    description: '',
    rating: '',
    runtime: '',
    trailers: []
  }
}

const sameId = (row: TrackedItem): string => row.id

function ids(rows: TrackedItem[]): string[] {
  return rows.map((row) => row.id)
}

console.log('plannedList')

check('nothing started: everything is planned, newest first as given', () => {
  const tracked = [item('tt3', 'movie'), item('tt2', 'series'), item('kitsu:1', 'anime')]
  assert.deepEqual(
    ids(
      plannedList({
        tracked,
        startedIds: new Set(),
        historyIdOf: sameId,
        watchedRegularCount: new Map(),
        posters: new Map()
      })
    ),
    ['tt3', 'tt2', 'kitsu:1']
  )
})

check('a film with any history is not planned', () => {
  const rows = plannedList({
    tracked: [item('tt-film', 'movie')],
    startedIds: new Set(['tt-film']),
    historyIdOf: sameId,
    watchedRegularCount: new Map([['tt-film', 0]]),
    posters: new Map()
  })
  assert.deepEqual(rows, [])
})

check('a started show is planned only when its watched regular count is exactly 0', () => {
  const tracked = [
    item('tt-special', 'series'),
    item('tt-going', 'series'),
    item('tt-unloaded', 'series')
  ]
  const rows = plannedList({
    tracked,
    startedIds: new Set(['tt-special', 'tt-going', 'tt-unloaded']),
    historyIdOf: sameId,
    // Only a special watched; one regular episode watched; metadata failed.
    watchedRegularCount: new Map([
      ['tt-special', 0],
      ['tt-going', 1]
    ]),
    posters: new Map()
  })
  assert.deepEqual(
    ids(rows),
    ['tt-special'],
    'a started show with no count is not knowably unstarted, so it is left out'
  )
})

check('history kept under the franchise id counts as started', () => {
  // A merged anime's later season, tracked under its own id while its
  // viewings sit under the show's. The handler counts them where they are
  // (that season of the show), so a season in progress carries a real count.
  const input = {
    tracked: [item('kitsu:2', 'anime')],
    startedIds: new Set(['kitsu:1']),
    historyIdOf: (row: TrackedItem): string => (row.id === 'kitsu:2' ? 'kitsu:1' : row.id),
    posters: new Map<string, string>()
  }
  assert.deepEqual(
    plannedList({ ...input, watchedRegularCount: new Map([['kitsu:2', 3]]) }),
    [],
    'three episodes into the season: not plan to watch'
  )
  assert.deepEqual(
    ids(plannedList({ ...input, watchedRegularCount: new Map([['kitsu:2', 0]]) })),
    ['kitsu:2'],
    'the show has viewings, but none of THIS season: still planned'
  )
  assert.deepEqual(
    plannedList({ ...input, watchedRegularCount: new Map() }),
    [],
    'no count at all: not knowably unstarted, so left out'
  )
})

check('a merged later season is skipped when its franchise is tracked too', () => {
  const historyIdOf = (row: TrackedItem): string => (row.id === 'kitsu:2' ? 'kitsu:1' : row.id)
  const both = plannedList({
    tracked: [item('kitsu:2', 'anime'), item('kitsu:1', 'anime')],
    startedIds: new Set(),
    historyIdOf,
    watchedRegularCount: new Map(),
    posters: new Map()
  })
  assert.deepEqual(ids(both), ['kitsu:1'], 'one tile per franchise')
  const alone = plannedList({
    tracked: [item('kitsu:2', 'anime')],
    startedIds: new Set(),
    historyIdOf,
    watchedRegularCount: new Map(),
    posters: new Map()
  })
  assert.deepEqual(ids(alone), ['kitsu:2'], 'tracked on its own, the later season is the tile')
})

check('artwork from the index fills a row that carries none, and only then', () => {
  const rows = plannedList({
    tracked: [
      item('tt-bare', 'movie'),
      item('tt-own', 'movie', 'own.jpg'),
      item('tt-none', 'series')
    ],
    startedIds: new Set(),
    historyIdOf: sameId,
    watchedRegularCount: new Map(),
    posters: new Map([
      ['tt-bare', 'index.jpg'],
      ['tt-own', 'other.jpg']
    ])
  })
  assert.deepEqual(
    rows.map((row) => row.poster),
    ['index.jpg', 'own.jpg', '']
  )
})

console.log(`\n${pass} passed`)
