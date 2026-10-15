// Home's Plan to Watch row (plannedList in core.ts), and which episode lists
// Home asks for (homeDetailWants).
//
// It is the complement of Continue Watching, and the two have to agree: a
// show in both rows reads as a bug, and a show in neither has vanished from
// Home. What is pinned here is where that line falls — a film watched, a
// show started, a show with only a special watched, a show whose episode
// list never loaded — and that a merged anime franchise is one tile, as
// long as that tile is on Home (homePlannedRow).
//
// The last part drives the real handlers (tracking.ts) through the headless
// Electron stand-in, as tests/catalogSearch.test.ts does, with the network
// down: home:personalized still answers with the local rows when no catalog
// can be read, and tracking:title-state answers for one title from its own
// rows.
//
// Run with: npx tsx tests/homeRows.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  continueWatchingList,
  homeDetailWants,
  homeWatchedCounts,
  plannedList
} from '../src/main/media-hub/core'
import type {
  CatalogItem,
  HistoryEntry,
  HomePersonalizedResult,
  MediaKind,
  TitleWatchState,
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

// ---------------------------------------------------------------------------
// Through the handlers. tracking.ts imports 'electron', so the name is
// pointed at the headless stand-in before it is loaded, and the settings it
// reads go to a scratch folder.

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-home-rows-'))
process.env.R3_USER_DATA = scratch
process.env.R3_ELECTRON_SHIM = '1'
const shim = pathToFileURL(
  path.join(__dirname, '..', 'src', 'headless', 'electronShim', 'index.ts')
)
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron') return { url: shim.href, shortCircuit: true }
    return next(specifier, context)
  }
})
// Offline: every catalog source, and every metadata request, fails.
globalThis.fetch = (async () => {
  throw new TypeError('fetch failed')
}) as typeof fetch

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

async function handlers(): Promise<void> {
  const { createDatabase } = await import('../src/main/media-hub/database')
  const { setDatabase } = await import('../src/main/media-hub/dbState')
  const { homePlannedRow, registerTrackingIpc } = await import('../src/main/media-hub/tracking')
  const { BrowserWindow, ipcMain } = await import('../src/headless/electronShim')
  const { MEDIA_HUB_CHANNELS } = await import('../src/shared/media-hub/ipc-channels')

  console.log('\nhomePlannedRow')

  // kitsu:2 is the second season of the show kitsu:1, both on the list.
  const both = [item('kitsu:2', 'anime'), item('kitsu:1', 'anime')]
  const row = (
    over: Partial<Parameters<typeof plannedList>[0]>,
    continueWatching: string[] = []
  ): string[] =>
    ids(
      homePlannedRow(
        {
          tracked: both,
          startedIds: new Set(['kitsu:1']),
          historyIdOf: showOf,
          // The show finished; nothing of its second season watched yet.
          watchedRegularCount: new Map([
            ['kitsu:1', 12],
            ['kitsu:2', 0]
          ]),
          posters: new Map(),
          ...over
        },
        new Set(continueWatching)
      )
    )

  await checkAsync('a planned later season of a finished show is not lost from Home', async () => {
    // The show is on neither row, so the season is the franchise's tile.
    assert.deepEqual(row({}), ['kitsu:2'])
  })

  await checkAsync('it is skipped while its show’s card is on Home', async () => {
    // In Continue Watching: that card is the franchise's tile.
    assert.deepEqual(row({}, ['kitsu:1']), [])
    // Planned itself: one tile, the show's, as plannedList has it.
    assert.deepEqual(row({ startedIds: new Set(), watchedRegularCount: new Map() }), ['kitsu:1'])
  })

  await checkAsync('a later season already in progress is still not planned', async () => {
    assert.deepEqual(
      row({
        watchedRegularCount: new Map([
          ['kitsu:1', 12],
          ['kitsu:2', 3]
        ])
      }),
      []
    )
    // And with no count at all it is not knowably unstarted.
    assert.deepEqual(row({ watchedRegularCount: new Map([['kitsu:1', 12]]) }), [])
  })

  console.log('\nthe handlers, offline')

  const db = createDatabase(path.join(scratch, 'media-hub.sqlite'), 'profile-home-test')
  setDatabase(db)
  registerTrackingIpc()
  const window = new BrowserWindow()
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const invoke = (channel: string, payload?: unknown): Promise<unknown> =>
    ipcMain.dispatchInvoke(event, channel, [payload])

  await checkAsync('no catalog to read: the local rows are still served', async () => {
    // A fresh install that never reached a catalog source: nothing stored,
    // no copy of any catalog, expired or not.
    db.track({ id: 'tt5000001', type: 'movie', title: 'Planned Film' })
    const home = (await invoke(MEDIA_HUB_CHANNELS.homePersonalized)) as HomePersonalizedResult
    assert.deepEqual(ids(home.planned), ['tt5000001'])
    assert.deepEqual(home.recommendations, [])
    assert.deepEqual(home.recommendationRails, [])
    assert.equal(home.catalogError, 'All catalog sources are currently unavailable.')
  })

  await checkAsync('one title’s watched episodes come from its own rows', async () => {
    const show = { id: 'tt5000002', type: 'series' as const, title: 'Show' }
    db.importWatched([
      { ...show, season: 1, episode: 1, watchedAt: '2026-01-01T10:00:00.000Z' },
      { ...show, season: 1, episode: 2, watchedAt: '2026-01-02T10:00:00.000Z' },
      {
        id: 'tt5000003',
        type: 'series',
        title: 'Other',
        season: 1,
        episode: 1,
        watchedAt: '2026-01-03T10:00:00.000Z'
      }
    ])
    // A rewatch of the first episode: a second viewing, one episode.
    db.markWatched(show, { season: 1, episode: 1 })
    // The same answer the whole history, filtered, used to give.
    const fromWholeHistory = db
      .history()
      .filter((entry) => String(entry.id) === show.id)
      .map((entry) => ({ season: entry.season, episode: entry.episode }))
    // Without reading the whole history to get it.
    const wholeHistory = db.history
    db.history = () => {
      throw new Error('read the whole history')
    }
    let state: TitleWatchState
    try {
      state = (await invoke(MEDIA_HUB_CHANNELS.trackingTitleState, {
        id: show.id
      })) as TitleWatchState
    } finally {
      db.history = wholeHistory
    }
    assert.deepEqual(state.watched, fromWholeHistory)
    assert.deepEqual(state.watched, [
      { season: 1, episode: 1 },
      { season: 1, episode: 2 }
    ])
    assert.equal(state.tracked, false)
  })

  db.close()
}

void handlers().then(() => console.log(`\n${pass} passed`))
