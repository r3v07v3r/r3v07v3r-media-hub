// Home's Plan to Watch row (plannedList in core.ts), and which episode lists
// Home asks for (homeDetailWants).
//
// It is the complement of Continue Watching, and the two have to agree: a
// show in both rows reads as a bug, and a show in neither has vanished from
// Home. What is pinned here is where that line falls — a film watched, a
// show started, a show with only a special watched, a show whose episode
// list never loaded — and that a merged anime franchise is one tile.
//
// Run with: npx tsx tests/homeRows.test.ts

import assert from 'node:assert/strict'

import {
  continueWatchingList,
  homeDetailWants,
  homeWatchedCounts,
  plannedList
} from '../src/main/media-hub/core'
import type {
  CatalogItem,
  HistoryEntry,
  MediaKind,
  TrackedItem
} from '../src/shared/media-hub/types'

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

// ---------------------------------------------------------------------------
// Which details Home asks for (homeDetailWants), and that the two rows stay
// each other's complement for the one case that used to fall between them: a
// merged anime's later season, tracked under its own id, with its viewings
// kept under the show.

const play = (id: string, type: MediaKind, season: number | null, episode: number | null) =>
  ({ id, type, season, episode, watchedAt: '2026-09-19T20:00:00Z' }) as HistoryEntry
// kitsu:2 is the second season of the show kitsu:1.
const showOf = (row: TrackedItem): string => (row.id === 'kitsu:2' ? 'kitsu:1' : row.id)
const seasonOf = (): number => 2

check('only started shows are resolved, each under the id its count is filed by', () => {
  const { wanted, seasonCount } = homeDetailWants({
    tracked: [
      item('tt-started', 'series'),
      item('tt-planned', 'series'),
      item('tt-film', 'movie'),
      item('simkl:9', 'series')
    ],
    history: [play('tt-started', 'series', 1, 1), play('tt-film', 'movie', null, null)],
    historyIdOf: sameId,
    seasonOf
  })
  assert.deepEqual(wanted, [
    { type: 'series', id: 'tt-started', countFor: 'tt-started' },
    // A legacy Simkl-keyed row: only metadata can say what it really is.
    { type: 'series', id: 'simkl:9', countFor: 'simkl:9' }
  ])
  assert.equal(seasonCount.size, 0)
})

check('a later season in progress asks for the SHOW, and is counted where its rows are', () => {
  const { wanted, seasonCount } = homeDetailWants({
    tracked: [item('kitsu:2', 'anime')],
    history: [
      play('kitsu:1', 'anime', 1, 1),
      play('kitsu:1', 'anime', 2, 1),
      play('kitsu:1', 'anime', 2, 2),
      // The same episode twice is one episode.
      play('kitsu:1', 'anime', 2, 2)
    ],
    historyIdOf: showOf,
    seasonOf
  })
  assert.deepEqual(wanted, [{ type: 'anime', id: 'kitsu:1', countFor: null }])
  assert.equal(seasonCount.get('kitsu:2'), 2)

  // The two rows, from those answers: the show is in Continue Watching (its
  // detail is what the viewings match) and the season is not also planned.
  const show = {
    id: 'kitsu:1',
    type: 'anime',
    title: 'The show',
    videos: [1, 2].flatMap((season) =>
      [1, 2, 3].map((episode) => ({
        id: `kitsu:1:${season}:${episode}`,
        season,
        episode,
        title: `S${season}E${episode}`,
        released: '2020-01-01T00:00:00.000Z'
      }))
    )
  } as unknown as CatalogItem
  const history = [
    play('kitsu:1', 'anime', 1, 1),
    play('kitsu:1', 'anime', 2, 1),
    play('kitsu:1', 'anime', 2, 2)
  ]
  assert.deepEqual(
    continueWatchingList([show], history).map((row) => row.id),
    ['kitsu:1']
  )
  assert.deepEqual(
    plannedList({
      tracked: [item('kitsu:2', 'anime')],
      startedIds: new Set(['kitsu:1']),
      historyIdOf: showOf,
      watchedRegularCount: seasonCount,
      posters: new Map()
    }),
    [],
    'in progress, so not plan to watch as well'
  )
})

check('a later season not yet started is planned, and asks for nothing', () => {
  // The show has viewings, but none of this season.
  const { wanted, seasonCount } = homeDetailWants({
    tracked: [item('kitsu:2', 'anime')],
    history: [play('kitsu:1', 'anime', 1, 1)],
    historyIdOf: showOf,
    seasonOf
  })
  assert.deepEqual(wanted, [])
  assert.equal(seasonCount.get('kitsu:2'), 0)
  assert.deepEqual(
    ids(
      plannedList({
        tracked: [item('kitsu:2', 'anime')],
        startedIds: new Set(['kitsu:1']),
        historyIdOf: showOf,
        watchedRegularCount: seasonCount,
        posters: new Map()
      })
    ),
    ['kitsu:2']
  )
})

check('a show tracked itself is asked for once, with its own count kept', () => {
  const { wanted, onBehalfOf } = homeDetailWants({
    tracked: [item('kitsu:2', 'anime'), item('kitsu:1', 'anime')],
    history: [play('kitsu:1', 'anime', 2, 1)],
    historyIdOf: showOf,
    seasonOf
  })
  assert.deepEqual(wanted, [{ type: 'anime', id: 'kitsu:1', countFor: 'kitsu:1' }])
  assert.equal(onBehalfOf.size, 0, 'the show is on the list itself: its card is its own')
})

check('a show asked for on a later season’s behalf says which season that is', () => {
  // The show is not on the list; the later season is. Whatever takes the
  // show's Continue Watching card away by untracking has to untrack THAT —
  // toggling the show itself would add it to the list.
  const { onBehalfOf } = homeDetailWants({
    tracked: [item('kitsu:2', 'anime')],
    history: [play('kitsu:1', 'anime', 2, 1)],
    historyIdOf: showOf,
    seasonOf
  })
  assert.deepEqual([...onBehalfOf], [['kitsu:1', 'kitsu:2']])
})

check('a later season with rows of its own keeps its own card, and only that one', () => {
  // Played from its own page before the show was grouped, and the same
  // season's viewings also kept under the show: one tile, not two.
  const { wanted, seasonCount, onBehalfOf } = homeDetailWants({
    tracked: [item('kitsu:2', 'anime')],
    history: [play('kitsu:2', 'anime', 1, 1), play('kitsu:1', 'anime', 2, 2)],
    historyIdOf: showOf,
    seasonOf
  })
  assert.deepEqual(wanted, [{ type: 'anime', id: 'kitsu:2', countFor: 'kitsu:2' }])
  assert.equal(seasonCount.get('kitsu:2'), 1, 'still counted, for the larger of the two')
  assert.equal(onBehalfOf.size, 0)
})

// ---------------------------------------------------------------------------
// The counts plannedList reads (homeWatchedCounts).

const detail = (id: string, episodes: Array<[number, number]>): CatalogItem =>
  ({
    id,
    type: 'series',
    title: id,
    videos: episodes.map(([season, episode]) => ({
      id: `${id}:${season}:${episode}`,
      season,
      episode,
      title: `S${season}E${episode}`,
      released: '2020-01-01T00:00:00.000Z'
    }))
  }) as unknown as CatalogItem

check('a count is filed under the tracked id, from regular episodes only', () => {
  const counts = homeWatchedCounts({
    wanted: [
      { type: 'series', id: 'tt-a', countFor: 'tt-a' },
      // Metadata answers a legacy Simkl-keyed row under its real id.
      { type: 'series', id: 'simkl:9', countFor: 'simkl:9' },
      // Fetched only to be shown: no count is filed for it.
      { type: 'anime', id: 'kitsu:1', countFor: null }
    ],
    fetched: [
      detail('tt-a', [
        [0, 1],
        [1, 1],
        [1, 2]
      ]),
      detail('tt-real', [[1, 1]]),
      detail('kitsu:1', [[1, 1]])
    ],
    seasonCount: new Map(),
    history: [
      play('tt-a', 'series', 0, 1),
      play('tt-a', 'series', 1, 1),
      play('tt-real', 'series', 1, 1),
      play('kitsu:1', 'anime', 1, 1)
    ]
  })
  assert.deepEqual(
    [...counts].sort(),
    [
      ['simkl:9', 1],
      ['tt-a', 1]
    ],
    'the special is not counted; the show-only detail files nothing'
  )
})

check('no episodes to count is no count, not zero', () => {
  // Metadata that could not be fetched comes back as its catalog stand-in,
  // with no episodes. Zero read off it would list a show somebody is half
  // way through under Plan to Watch.
  const history = [play('tt-degraded', 'series', 1, 1), play('tt-failed', 'series', 1, 1)]
  const counts = homeWatchedCounts({
    wanted: [
      { type: 'series', id: 'tt-degraded', countFor: 'tt-degraded' },
      { type: 'series', id: 'tt-failed', countFor: 'tt-failed' }
    ],
    fetched: [detail('tt-degraded', []), null],
    seasonCount: new Map(),
    history
  })
  assert.equal(counts.size, 0)
  assert.deepEqual(
    plannedList({
      tracked: [item('tt-degraded', 'series'), item('tt-failed', 'series')],
      startedIds: new Set(['tt-degraded', 'tt-failed']),
      historyIdOf: sameId,
      watchedRegularCount: counts,
      posters: new Map()
    }),
    [],
    'left out of Plan to Watch until a real episode list arrives'
  )
})

check('a later season’s viewings under its show count even when its own detail has none', () => {
  const counts = homeWatchedCounts({
    wanted: [{ type: 'anime', id: 'kitsu:2', countFor: 'kitsu:2' }],
    fetched: [detail('kitsu:2', [[1, 1]])],
    seasonCount: new Map([['kitsu:2', 3]]),
    history: [play('kitsu:2', 'anime', 1, 1)]
  })
  assert.equal(counts.get('kitsu:2'), 3, 'the larger of the two')
  // And one with rows only under the show needs no detail at all.
  const underShow = homeWatchedCounts({
    wanted: [],
    fetched: [],
    seasonCount: new Map([['kitsu:2', 0]]),
    history: [play('kitsu:1', 'anime', 1, 1)]
  })
  assert.equal(underShow.get('kitsu:2'), 0)
})

console.log(`\n${pass} passed`)
