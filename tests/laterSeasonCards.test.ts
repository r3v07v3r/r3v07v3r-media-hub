// A later season of a merged anime, seen from outside the show's own page.
//
// A merged franchise is one show: its viewings are kept under the show's id,
// at the season each member is there. A later season still has an id of its
// own (a plan card a watchlist pull added carries it, and the index keeps a
// row for every season), and a card that names it has no rows under that id
// to work its badge and progress out from: read that way, the season is not
// started however much of it was watched.
//
// Pinned here: where a card's rows are found (watchedLaterSeasons), what the
// card makes of them (adapters.ts, watchStatus.ts), what the index says
// about its completion, and what the library's Hide watched and Hide
// completed filters make of it (database.ts).
//
// Run with: npx tsx tests/laterSeasonCards.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { animeGroupIndexesOf, laterSeasonsOf } from '../src/main/media-hub/animeSeasons'
import { createDatabase } from '../src/main/media-hub/database'
import { watchedLaterSeasons } from '../src/shared/media-hub/serviceIds'
import type { CatalogItem, Episode, HistoryEntry } from '../src/shared/media-hub/types'
import {
  catalogItemToMediaItem,
  indexHistoryById,
  indexSeasonEpisodes
} from '../src/renderer/src/lib/mediaHub/adapters'
import { getWatchStatus } from '../src/renderer/src/lib/mediaHub/watchStatus'

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

// One merged show: kitsu:100 fronts it, kitsu:200 is its second season and
// kitsu:300 its third. kitsu:900 stands alone.
const SHOW = 'kitsu:100'
const SECOND = 'kitsu:200'
const THIRD = 'kitsu:300'
const ALONE = 'kitsu:900'
// A second merged show, which nobody has watched any of.
const OTHER = 'kitsu:500'
const OTHER_SECOND = 'kitsu:600'
const siblingsOf = (id: string): string[] | undefined => (id === SHOW ? [SECOND, THIRD] : undefined)
// What the index is handed: every later season, by its own id, from the
// construction the app itself runs on. Every member here is the season its
// place says (the gate has its own checks in simklAnime.test.ts).
const laterSeasons = laterSeasonsOf(
  animeGroupIndexesOf([
    { id: SHOW, groupedIds: [SECOND, THIRD] },
    { id: OTHER, groupedIds: [OTHER_SECOND] },
    { id: ALONE }
  ]).positions,
  () => true
)

const PAST = '2000-01-01T00:00:00.000Z'
const FUTURE = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()

function episodes(id: string, season: number, count: number, unaired = 0): Episode[] {
  return Array.from({ length: count + unaired }, (_unused, i) => ({
    id: `${id}:${season}:${i + 1}`,
    season,
    episode: i + 1,
    number: i + 1,
    title: '',
    released: i < count ? PAST : FUTURE
  }))
}

function anime(id: string, over: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id,
    title: id,
    type: 'anime',
    poster: '',
    background: '',
    logo: '',
    year: '',
    status: '',
    description: '',
    rating: '',
    runtime: '',
    genres: [],
    videos: [],
    trailers: [],
    ...over
  }
}

function watched(id: string, season: number, episode: number): HistoryEntry {
  return { id, type: 'anime', season, episode, watchedAt: PAST }
}

/** The adapter context the app builds from one tracking:list answer. */
function contextFor(history: HistoryEntry[], tracked: string[] = []) {
  return {
    trackedIds: new Set(tracked),
    watchedIds: new Set(history.map((row) => row.id)),
    historyById: indexHistoryById(history),
    seasonEpisodesById: indexSeasonEpisodes(history, watchedLaterSeasons(history, siblingsOf))
  }
}

// ---------------------------------------------------------------------
// 1. Where a later season's rows are.
// ---------------------------------------------------------------------

check('a later season with viewings is found under its show, by its own id', () => {
  const history = [
    watched(SHOW, 1, 1),
    watched(SHOW, 2, 1),
    watched(SHOW, 2, 2),
    watched(SHOW, 3, 5)
  ]
  assert.deepEqual(watchedLaterSeasons(history, siblingsOf), {
    [SECOND]: { id: SHOW, season: 2 },
    [THIRD]: { id: SHOW, season: 3 }
  })
})

check('a first season, a special and a season nobody started are not listed', () => {
  assert.deepEqual(
    watchedLaterSeasons([watched(SHOW, 1, 1), watched(SHOW, 0, 1)], siblingsOf),
    {},
    'season 1 is the show itself, and a special belongs to no member'
  )
  assert.deepEqual(
    watchedLaterSeasons([watched(SHOW, 2, 1)], siblingsOf),
    { [SECOND]: { id: SHOW, season: 2 } },
    'the third season has no rows, so it is not in the answer'
  )
})

check('a season the show has no member for, and a title that fronts no group', () => {
  assert.deepEqual(watchedLaterSeasons([watched(SHOW, 4, 1)], siblingsOf), {})
  // Kitsu's own season label on a title that stands alone is not a member.
  assert.deepEqual(watchedLaterSeasons([watched(ALONE, 2, 1)], siblingsOf), {})
  assert.deepEqual(watchedLaterSeasons([watched('tt0903747', 2, 1)], siblingsOf), {})
})

check('nothing is listed while the catalog is not grouped', () => {
  assert.deepEqual(watchedLaterSeasons([watched(SHOW, 2, 1)], undefined), {})
})

check('a row with no episode is not a viewing of a season', () => {
  const row: HistoryEntry = { id: SHOW, type: 'anime', season: 2, episode: null, watchedAt: PAST }
  assert.deepEqual(watchedLaterSeasons([row], siblingsOf), {})
})

// ---------------------------------------------------------------------
// 2. What the card makes of them.
// ---------------------------------------------------------------------

check('a later season read from its own rows is not started — the bug', () => {
  // What the card did before: the same history, without the season index.
  const history = [watched(SHOW, 2, 1), watched(SHOW, 2, 2), watched(SHOW, 2, 3)]
  const card = catalogItemToMediaItem(anime(SECOND, { videos: episodes(SECOND, 1, 3) }), {
    watchedIds: new Set(history.map((row) => row.id)),
    historyById: indexHistoryById(history)
  })
  assert.equal(card.watched, false)
  assert.equal(card.completed, false)
})

check('a fully watched later season is watched and completed', () => {
  const history = [watched(SHOW, 2, 1), watched(SHOW, 2, 2), watched(SHOW, 2, 3)]
  // The card's own episodes carry Kitsu's label for the entry (season 1),
  // not its place in the show (season 2): matched by episode number.
  const card = catalogItemToMediaItem(
    anime(SECOND, { videos: episodes(SECOND, 1, 3) }),
    contextFor(history)
  )
  assert.equal(card.watched, true)
  assert.equal(card.completed, true)
  assert.equal(card.progressPercentage, 100)
})

check('a half watched later season is started, with its own progress', () => {
  const history = [watched(SHOW, 2, 1), watched(SHOW, 2, 2)]
  const card = catalogItemToMediaItem(
    anime(SECOND, { videos: episodes(SECOND, 1, 4) }),
    contextFor(history)
  )
  assert.equal(card.watched, true)
  assert.equal(card.completed, false)
  assert.equal(card.progressPercentage, 50)
})

check('a later season still airing is complete when every aired episode is watched', () => {
  const history = [watched(SHOW, 2, 1), watched(SHOW, 2, 2)]
  const card = catalogItemToMediaItem(
    anime(SECOND, { videos: episodes(SECOND, 1, 2, 3) }),
    contextFor(history)
  )
  assert.equal(card.completed, true, 'two aired, two watched; three still to come')
})

check('an index row has no episodes, and is measured against its episode count', () => {
  const history = [watched(SHOW, 3, 1), watched(SHOW, 3, 2), watched(SHOW, 3, 3)]
  const row = anime(THIRD, { episodeCounts: { totalSeasons: 1, totalEpisodes: 12 } })
  const card = catalogItemToMediaItem(row, contextFor(history))
  assert.equal(card.watched, true)
  assert.equal(card.completed, false)
  assert.equal(card.progressPercentage, 25)
})

check('one season watched says nothing about another, or about the show', () => {
  const history = [watched(SHOW, 2, 1), watched(SHOW, 2, 2), watched(SHOW, 2, 3)]
  const context = contextFor(history)
  const third = catalogItemToMediaItem(anime(THIRD, { videos: episodes(THIRD, 1, 3) }), context)
  assert.equal(third.watched, false)
  assert.equal(third.progressPercentage, undefined)
  // The show's own card is read the way it always was: from its own rows,
  // against its own episodes. Its first season's are not watched.
  const show = catalogItemToMediaItem(anime(SHOW, { videos: episodes(SHOW, 1, 3) }), context)
  assert.equal(show.watched, true, 'started: it has rows')
  assert.equal(show.completed, false)
  assert.equal(show.progressPercentage, undefined, 'its progress is Continue Watching’s to report')
})

check('a title that is not a later season is untouched by the season index', () => {
  const history = [watched(ALONE, 1, 1), watched(ALONE, 1, 2)]
  const card = catalogItemToMediaItem(
    anime(ALONE, { videos: episodes(ALONE, 1, 2) }),
    contextFor(history)
  )
  assert.equal(card.watched, true)
  assert.equal(card.completed, true)
  assert.equal(card.progressPercentage, undefined)
})

check('the badge: planned until started, in progress, then completed', () => {
  const card = (history: HistoryEntry[]) =>
    catalogItemToMediaItem(
      anime(SECOND, { videos: episodes(SECOND, 1, 4) }),
      contextFor(history, [SECOND])
    )
  // Continue Watching holds the SHOW, never the later season's own id.
  assert.deepEqual(getWatchStatus(card([]), []), { state: 'planned' })
  assert.deepEqual(getWatchStatus(card([watched(SHOW, 2, 1)]), []), {
    state: 'in-progress',
    progressPercentage: 25
  })
  assert.deepEqual(
    getWatchStatus(card([1, 2, 3, 4].map((episode) => watched(SHOW, 2, episode))), []),
    { state: 'completed', progressPercentage: 100 }
  )
})

// ---------------------------------------------------------------------
// 3. What the index says about its completion.
// ---------------------------------------------------------------------

function tempDb(): ReturnType<typeof createDatabase> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-later-season-test-'))
  return createDatabase(path.join(dir, 'test.sqlite'), 'profile-under-test')
}

check('the index counts a later season where its viewings are kept', () => {
  // The index keeps a row for every season of a merged show, each with its
  // own aired count, and no episodes: completion is only derivable there.
  const db = tempDb()
  db.indexUpsert('anime', [
    // The show's row counts the whole show: seven episodes over three seasons.
    anime(SHOW, {
      videos: episodes(SHOW, 1, 2),
      groupedIds: [SECOND, THIRD],
      episodeCounts: { totalSeasons: 3, totalEpisodes: 7 }
    }),
    anime(SECOND, { videos: episodes(SECOND, 1, 3) }),
    anime(THIRD, { videos: episodes(THIRD, 1, 2) })
  ])
  const show = { id: SHOW, type: 'anime' as const, title: SHOW }
  for (const episode of [1, 2, 3]) db.markWatched(show, { season: 2, episode })
  db.markWatched(show, { season: 3, episode: 1 })

  const ids = [SHOW, SECOND, THIRD]
  assert.deepEqual(
    db.indexByIds(ids).completedIds,
    [],
    'asked by its own id, no season has a row to count'
  )
  assert.deepEqual(
    db.indexByIds(ids, laterSeasons).completedIds,
    [SECOND],
    'the second season is complete; the third is one of two; the show is not'
  )
  assert.deepEqual(
    db.indexQuery({ kind: 'anime' }, laterSeasons).completedIds,
    [SECOND],
    'the paged grid lists the same rows and says the same'
  )

  db.markWatched(show, { season: 3, episode: 2 })
  assert.deepEqual(db.indexByIds(ids, laterSeasons).completedIds.sort(), [SECOND, THIRD])
  db.close()
})

check('a row that is not a later season is still answered by the query itself', () => {
  const db = tempDb()
  db.indexUpsert('anime', [anime(ALONE, { videos: episodes(ALONE, 1, 2) })])
  const alone = { id: ALONE, type: 'anime' as const, title: ALONE }
  db.markWatched(alone, { season: 1, episode: 1 })
  assert.deepEqual(db.indexByIds([ALONE], laterSeasons).completedIds, [])
  db.markWatched(alone, { season: 1, episode: 2 })
  assert.deepEqual(db.indexByIds([ALONE], laterSeasons).completedIds, [ALONE])
  db.close()
})

// ---------------------------------------------------------------------
// 4. What Hide watched and Hide completed make of it.
// ---------------------------------------------------------------------
//
// The two filters run inside the index query (CatalogQuery says why), so
// they have to find a later season's viewings there too. Read by the row's
// own id, a season watched to the end stayed on the grid with its watched
// badge on it, and was counted in the total.

type Db = ReturnType<typeof createDatabase>
const EVERY_ROW = [SHOW, SECOND, THIRD, OTHER, OTHER_SECOND, ALONE]

/**
 * The library the checks below browse: a row for every season of both
 * merged shows, and the title that stands alone. Of the first show the
 * second season is watched to the end (three of three) and the third is
 * started (one of two); nothing else has been touched.
 */
function library(): Db {
  const db = tempDb()
  db.indexUpsert('anime', [
    anime(SHOW, {
      videos: episodes(SHOW, 1, 2),
      groupedIds: [SECOND, THIRD],
      episodeCounts: { totalSeasons: 3, totalEpisodes: 7 }
    }),
    anime(SECOND, { videos: episodes(SECOND, 1, 3) }),
    anime(THIRD, { videos: episodes(THIRD, 1, 2) }),
    anime(OTHER, {
      videos: episodes(OTHER, 1, 2),
      groupedIds: [OTHER_SECOND],
      episodeCounts: { totalSeasons: 2, totalEpisodes: 4 }
    }),
    anime(OTHER_SECOND, { videos: episodes(OTHER_SECOND, 1, 2) }),
    anime(ALONE, { videos: episodes(ALONE, 1, 2) })
  ])
  const show = { id: SHOW, type: 'anime' as const, title: SHOW }
  for (const episode of [1, 2, 3]) db.markWatched(show, { season: 2, episode })
  db.markWatched(show, { season: 3, episode: 1 })
  return db
}

/** The ids one query leaves on the grid, sorted, with the total it reports.
 *  `grouping` is null for a catalog that has not been grouped. */
function browse(
  db: Db,
  query: Omit<Parameters<Db['indexQuery']>[0], 'kind'>,
  grouping: typeof laterSeasons | null = laterSeasons
): { ids: string[]; total: number } {
  const result = db.indexQuery({ kind: 'anime', ...query }, grouping ?? undefined)
  return { ids: result.items.map((item) => item.id).sort(), total: result.total }
}

check(
  'Hide watched read by the row’s own id leaves a watched later season on the grid — the bug',
  () => {
    const db = library()
    // What the query did before, and what it still does while the catalog is
    // not grouped: only the show has rows under its own id.
    assert.deepEqual(browse(db, { hideWatched: true }, null), {
      ids: [SECOND, THIRD, OTHER, OTHER_SECOND, ALONE].sort(),
      total: 5
    })
    db.close()
  }
)

check('Hide watched takes out a later season that has viewings under its show', () => {
  const db = library()
  assert.deepEqual(browse(db, { hideWatched: true }), {
    ids: [OTHER, OTHER_SECOND, ALONE].sort(),
    total: 3
  })
  db.close()
})

check('Hide completed takes out the finished season, and not the one in progress', () => {
  const db = library()
  assert.deepEqual(browse(db, { hideCompleted: true }), {
    ids: [SHOW, THIRD, OTHER, OTHER_SECOND, ALONE].sort(),
    total: 5
  })
  // The third season's last episode: now it goes too. The show's own row
  // counts the whole show — five of seven — and stays.
  db.markWatched({ id: SHOW, type: 'anime', title: SHOW }, { season: 3, episode: 2 })
  assert.deepEqual(browse(db, { hideCompleted: true }), {
    ids: [SHOW, OTHER, OTHER_SECOND, ALONE].sort(),
    total: 4
  })
  db.close()
})

check('what Hide completed removes is exactly what the grid badges as completed', () => {
  const db = library()
  db.markWatched({ id: SHOW, type: 'anime', title: SHOW }, { season: 3, episode: 2 })
  const badged = db.indexQuery({ kind: 'anime' }, laterSeasons).completedIds.sort()
  const left = new Set(browse(db, { hideCompleted: true }).ids)
  assert.deepEqual(
    EVERY_ROW.filter((id) => !left.has(id)).sort(),
    badged,
    'the filter and the badge read the same rows'
  )
  assert.deepEqual(badged, [SECOND, THIRD])
  db.close()
})

check('the total is the number of rows the pages add up to', () => {
  const db = library()
  for (const filters of [{ hideWatched: true }, { hideCompleted: true }]) {
    const whole = browse(db, filters)
    const paged: string[] = []
    for (let offset = 0; offset < whole.total; offset++) {
      const page = browse(db, { ...filters, limit: 1, offset })
      assert.equal(page.total, whole.total, 'every page reports the same total')
      paged.push(...page.ids)
    }
    assert.deepEqual(paged.sort(), whole.ids, 'no row twice, none missing')
    assert.deepEqual(browse(db, { ...filters, limit: 1, offset: whole.total }).ids, [])
  }
  db.close()
})

check('both filters, with another filter and under every sort', () => {
  const db = library()
  const sorts = [
    'trending',
    'title-asc',
    'year-desc',
    'rating-desc',
    'runtime-asc',
    'runtime-desc'
  ] as const
  for (const sort of sorts) {
    // A failed statement answers with an empty page (indexQuery logs and
    // returns), so the expected rows are also what says the SQL ran.
    assert.deepEqual(
      browse(db, { hideWatched: true, hideCompleted: true, minRating: 0, sort }),
      { ids: [OTHER, OTHER_SECOND, ALONE].sort(), total: 3 },
      sort
    )
  }
  db.close()
})

check('a season with no known aired count is watched, and never completed', () => {
  const db = library()
  // No episodes on the row: the index has no aired count to compare with.
  db.indexUpsert('anime', [anime(OTHER_SECOND)])
  db.markWatched({ id: OTHER, type: 'anime', title: OTHER }, { season: 2, episode: 1 })
  assert.ok(!browse(db, { hideWatched: true }).ids.includes(OTHER_SECOND))
  assert.ok(browse(db, { hideCompleted: true }).ids.includes(OTHER_SECOND))
  db.close()
})

check('rows left under a later season’s own id still make it watched, not completed', () => {
  // A viewing written while the catalog was not grouped stays under the
  // season's own id. The card reads it as watched (its id is in the watched
  // set), and its completion is counted under the show alone (rowCompleted).
  const db = library()
  const season = { id: OTHER_SECOND, type: 'anime' as const, title: OTHER_SECOND }
  for (const episode of [1, 2]) db.markWatched(season, { season: 1, episode })
  assert.ok(!browse(db, { hideWatched: true }).ids.includes(OTHER_SECOND))
  assert.ok(browse(db, { hideCompleted: true }).ids.includes(OTHER_SECOND))
  assert.ok(!db.indexQuery({ kind: 'anime' }, laterSeasons).completedIds.includes(OTHER_SECOND))
  db.close()
})

check('another profile’s viewings hide nothing', () => {
  const db = library()
  db.setActiveProfile('somebody-else')
  assert.deepEqual(browse(db, { hideWatched: true, hideCompleted: true }), {
    ids: [...EVERY_ROW].sort(),
    total: 6
  })
  db.close()
})

check('a member that is not the season its place says is read by its own id', () => {
  // The second member sits at season 2 of the group, and the show's page
  // gives that season to something else (a film filed among the seasons,
  // say). It opens and saves as itself, so its tile is watched when it has
  // rows of its own, and the show's season 2 says nothing about it.
  const db = library()
  const gated = laterSeasonsOf(
    animeGroupIndexesOf([{ id: SHOW, groupedIds: [SECOND, THIRD] }]).positions,
    (_show, member) => member !== SECOND
  )
  assert.deepEqual([...gated.keys()], [THIRD])
  const watchedOff = browse(db, { hideWatched: true }, gated).ids
  assert.ok(watchedOff.includes(SECOND), 'the show’s season 2 is not this tile’s')
  assert.ok(!watchedOff.includes(THIRD))
  assert.ok(browse(db, { hideCompleted: true }, gated).ids.includes(SECOND))
  assert.deepEqual(db.indexQuery({ kind: 'anime' }, gated).completedIds, [])

  for (const episode of [1, 2, 3]) {
    db.markWatched({ id: SECOND, type: 'anime', title: SECOND }, { season: 1, episode })
  }
  assert.ok(!browse(db, { hideWatched: true }, gated).ids.includes(SECOND))
  assert.ok(!browse(db, { hideCompleted: true }, gated).ids.includes(SECOND))
  assert.deepEqual(db.indexQuery({ kind: 'anime' }, gated).completedIds, [SECOND])
  db.close()
})

check('a catalog with no merged show, and a query for another kind, are read as before', () => {
  const db = library()
  assert.deepEqual(
    browse(db, { hideWatched: true }, new Map()),
    browse(db, { hideWatched: true }, null)
  )
  // The grouping is about anime rows; a series row with a later season's
  // id in it is not one of them.
  db.indexUpsert('series', [{ ...anime(SECOND), type: 'series' }])
  const series = db.indexQuery({ kind: 'series', hideWatched: true }, laterSeasons)
  assert.deepEqual(
    series.items.map((item) => item.id),
    [SECOND]
  )
  assert.equal(series.total, 1)
  db.close()
})

console.log(`\n${pass} passed`)
