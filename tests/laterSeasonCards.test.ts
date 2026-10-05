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
// about its completion, that the library grid and search leave it out
// while a plan card can still name it (database.ts, animeSeasons.ts), and
// that the show's own card says how many seasons it stands for.
//
// Run with: npx tsx tests/laterSeasonCards.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  animeGroupIndexesOf,
  foldLaterSeasons,
  laterSeasonsOf,
  withShowTotals
} from '../src/main/media-hub/animeSeasons'
import { toPosterItem } from '../src/app-ui/lib/posterItem'
import { mergedSeasonsLabel } from '../src/shared/media-hub/catalogFields'
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
  // The grid lists the show alone (section 4), and the show is not complete.
  const grid = db.indexQuery({ kind: 'anime' }, laterSeasons)
  assert.deepEqual(
    grid.items.map((item) => item.id),
    [SHOW]
  )
  assert.deepEqual(grid.completedIds, [])

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
// 4. The library grid and search leave it out.
// ---------------------------------------------------------------------
//
// A later season is a tab on its show's page, not a title of its own, and
// the grid showed it as one: the index keeps a row for every season. The
// grid's query and the index half of search leave out every id in the
// laterSeasons map, in the WHERE the count and the pages are both cut from.
// Only those ids: a member whose place cannot be shown to be its season
// opens as itself, and its tile is how it is reached. A plan card under a
// later season's id is read by id (indexByIds), which leaves nothing out.

type Db = ReturnType<typeof createDatabase>
const EVERY_ROW = [SHOW, SECOND, THIRD, OTHER, OTHER_SECOND, ALONE]
const ON_THE_GRID = [SHOW, OTHER, ALONE]

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

check('the grid lists a row for every season while nothing says they are seasons', () => {
  // What the query did before, and still does while the catalog is not
  // grouped: every season of both shows as a tile of its own.
  const db = library()
  assert.deepEqual(browse(db, {}, null), { ids: [...EVERY_ROW].sort(), total: 6 })
  db.close()
})

check('the grid leaves out every later season, and counts what it shows', () => {
  const db = library()
  assert.deepEqual(browse(db, {}), { ids: [...ON_THE_GRID].sort(), total: 3 })
  db.close()
})

check('Hide watched and Hide completed read what is left by its own id', () => {
  const db = library()
  // The show has viewings under its own id; the other show and the title
  // that stands alone have none.
  assert.deepEqual(browse(db, { hideWatched: true }), { ids: [OTHER, ALONE].sort(), total: 2 })
  // Four of the show's seven episodes: not complete, so it stays.
  assert.deepEqual(browse(db, { hideCompleted: true }), {
    ids: [...ON_THE_GRID].sort(),
    total: 3
  })
  db.close()
})

check('the total is the number of rows the pages add up to', () => {
  const db = library()
  for (const filters of [{}, { hideWatched: true }, { hideCompleted: true }]) {
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

check('with the filters, another filter and under every sort', () => {
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
    assert.deepEqual(browse(db, { minRating: 0, sort }), {
      ids: [...ON_THE_GRID].sort(),
      total: 3
    })
    assert.deepEqual(
      browse(db, { hideWatched: true, hideCompleted: true, minRating: 0, sort }),
      { ids: [OTHER, ALONE].sort(), total: 2 },
      sort
    )
  }
  db.close()
})

check('a plan card under a later season’s id is still answered by id', () => {
  // catalog:byIds is not filtered: My Stuff and the Planned row show what
  // a watchlist pull planned, under the id it planned it.
  const db = library()
  const answer = db.indexByIds([SECOND, OTHER_SECOND], laterSeasons)
  assert.deepEqual(answer.items.map((item) => item.id).sort(), [SECOND, OTHER_SECOND].sort())
  assert.deepEqual(answer.completedIds, [SECOND])
  db.close()
})

check('another profile’s viewings hide nothing', () => {
  const db = library()
  db.setActiveProfile('somebody-else')
  assert.deepEqual(browse(db, { hideWatched: true, hideCompleted: true }), {
    ids: [...ON_THE_GRID].sort(),
    total: 3
  })
  db.close()
})

check('a member that is not the season its place says stays, read by its own id', () => {
  // The second member sits at season 2 of the group, and the show's page
  // gives that season to something else (an OVA filed among the seasons,
  // say). It opens and saves as itself, so its tile is how it is reached,
  // and it is watched when it has rows of its own.
  const db = library()
  const gated = laterSeasonsOf(
    animeGroupIndexesOf([{ id: SHOW, groupedIds: [SECOND, THIRD] }]).positions,
    (_show, member) => member !== SECOND
  )
  assert.deepEqual([...gated.keys()], [THIRD])
  const grid = browse(db, {}, gated).ids
  assert.ok(grid.includes(SECOND), 'its tile stays')
  assert.ok(!grid.includes(THIRD), 'the season that is its place is left out')
  assert.ok(browse(db, { hideWatched: true }, gated).ids.includes(SECOND))

  for (const episode of [1, 2, 3]) {
    db.markWatched({ id: SECOND, type: 'anime', title: SECOND }, { season: 1, episode })
  }
  assert.ok(!browse(db, { hideWatched: true }, gated).ids.includes(SECOND))
  assert.ok(!browse(db, { hideCompleted: true }, gated).ids.includes(SECOND))
  assert.deepEqual(db.indexQuery({ kind: 'anime' }, gated).completedIds, [SECOND])
  db.close()
})

check('a film linked to a show is a tile of its own, not a later season', () => {
  // The grouping no longer files a film among a show's seasons: it is named
  // on the show (groupedExtras) and stays a title of its own, so the grid
  // keeps its tile and nothing reads its viewings under the show.
  const FILM = 'kitsu:250'
  const db = library()
  db.indexUpsert('anime', [anime(FILM, { subtype: 'movie', videos: episodes(FILM, 1, 1) })])
  const show = { id: SHOW, groupedIds: [SECOND, THIRD], groupedExtras: [FILM] }
  const grouping = laterSeasonsOf(
    animeGroupIndexesOf([show, { id: OTHER, groupedIds: [OTHER_SECOND] }, { id: FILM }]).positions,
    () => true
  )
  assert.equal(grouping.has(FILM), false)
  assert.deepEqual(browse(db, {}, grouping), { ids: [...ON_THE_GRID, FILM].sort(), total: 4 })
  db.markWatched({ id: FILM, type: 'anime', title: FILM }, { season: 1, episode: 1 })
  assert.ok(!browse(db, { hideWatched: true }, grouping).ids.includes(FILM))
  assert.deepEqual(db.indexQuery({ kind: 'anime' }, grouping).completedIds, [FILM])
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

check('the index half of search leaves later seasons out, before its limit', () => {
  const db = library()
  // Every row is titled by its id, so "kitsu" matches all six.
  const search = (grouping?: typeof laterSeasons, limit = 100): string[] =>
    db
      .indexSearch('anime', 'kitsu', limit, grouping)
      .map((item) => item.id)
      .sort()
  assert.deepEqual(search(), [...EVERY_ROW].sort(), 'ungrouped: every row')
  assert.deepEqual(search(laterSeasons), [...ON_THE_GRID].sort())
  assert.deepEqual(
    search(laterSeasons, 3),
    [...ON_THE_GRID].sort(),
    'the left-out rows take no place in the limit'
  )
  db.close()
})

check('a later season found by search is answered as its show', () => {
  // A provider hit, or the index's, for a later season's own name.
  const show = anime(SHOW, { groupedIds: [SECOND, THIRD] })
  assert.deepEqual(
    foldLaterSeasons([anime(THIRD), anime(ALONE), anime(SECOND)], laterSeasons, [show]).map(
      (item) => item.id
    ),
    [SHOW, ALONE],
    'the show takes the first season’s place, once'
  )
  // The show already in the answer is the one kept, where it is.
  const found = anime(SHOW, { poster: 'from-the-answer' })
  const folded = foldLaterSeasons([anime(ALONE), found, anime(SECOND)], laterSeasons, [show])
  assert.deepEqual(
    folded.map((item) => item.id),
    [ALONE, SHOW]
  )
  assert.equal(folded[1].poster, 'from-the-answer')
  // A season whose show the index does not hold is left out, not shown.
  assert.deepEqual(
    foldLaterSeasons([anime(OTHER_SECOND), anime(ALONE)], laterSeasons, []).map((item) => item.id),
    [ALONE]
  )
})

// ---------------------------------------------------------------------
// 5. The show's card says how many seasons it stands for.
// ---------------------------------------------------------------------
//
// The index is written from the raw crawl, so a show's own row knows one
// season and that season's episodes. Its card on the grid, in search and in
// My Stuff is given the show's totals from the grouping (withShowTotals),
// and a merged anime's card carries an "N seasons" chip, on the desktop
// (MediaCard, the library tile) and on the phone (PosterCard). The rating is
// left as it is: the front season's own score, not an average.

check('a show’s index row is given the show’s siblings and totals', () => {
  const row = anime(SHOW, { rating: '8.1', episodeCounts: { totalSeasons: 1, totalEpisodes: 2 } })
  const showOf = (id: string) =>
    id === SHOW
      ? { groupedIds: [SECOND, THIRD], episodeCounts: { totalSeasons: 3, totalEpisodes: 7 } }
      : undefined
  const [show, alone, series] = withShowTotals(
    [row, anime(ALONE), { ...anime(SHOW), type: 'series' }],
    showOf
  )
  assert.deepEqual(show.groupedIds, [SECOND, THIRD])
  assert.deepEqual(show.episodeCounts, { totalSeasons: 3, totalEpisodes: 7 })
  assert.equal(show.rating, '8.1', 'the front season’s own score, not an average')
  assert.equal(alone.episodeCounts, undefined, 'a title that fronts nothing is as it was')
  assert.equal(series.groupedIds, undefined, 'only anime rows are shows of merged seasons')
  // A grouping with no totals recorded still counts its seasons.
  const [counted] = withShowTotals([row], () => ({ groupedIds: [SECOND] }))
  assert.deepEqual(counted.episodeCounts, { totalSeasons: 2, totalEpisodes: 2 })
})

check('a former front that fronts no show now is one season again', () => {
  // A film that sorted first fronted its show, and its index row still has
  // the show's siblings and totals, written when the merged page was opened.
  const stale = anime(ALONE, {
    groupedIds: [SECOND],
    episodeCounts: { totalSeasons: 3, totalEpisodes: 7 }
  })
  const [known] = withShowTotals([stale], () => null)
  assert.equal(known.groupedIds, undefined)
  assert.deepEqual(known.episodeCounts, { totalSeasons: 1, totalEpisodes: 7 })
  assert.equal(toPosterItem(known).seasons, undefined, 'no "3 seasons" chip')
  // With no grouping to ask (a raw catalog), the row is left as it is.
  assert.equal(withShowTotals([stale], () => undefined)[0], stale)
})

check('a merged anime’s card says how many seasons, and no other card does', () => {
  assert.equal(mergedSeasonsLabel('anime', 3), '3 seasons')
  assert.equal(mergedSeasonsLabel('anime', 1), null)
  assert.equal(mergedSeasonsLabel('anime', undefined), null)
  assert.equal(mergedSeasonsLabel('series', 5), null, 'every series has seasons')
  assert.equal(mergedSeasonsLabel('movie', 2), null)

  // The desktop card reads totalSeasons off the MediaItem the grid builds.
  const [show] = withShowTotals([anime(SHOW)], () => ({
    groupedIds: [SECOND, THIRD],
    episodeCounts: { totalSeasons: 3, totalEpisodes: 7 }
  }))
  const media = catalogItemToMediaItem(show)
  assert.equal(mergedSeasonsLabel(media.mediaKind, media.totalSeasons), '3 seasons')
  assert.equal(media.totalEpisodes, 7)

  // The phone's poster, from the same item.
  assert.equal(toPosterItem(show).seasons, '3 seasons')
  assert.equal(toPosterItem(anime(SHOW, { groupedIds: [SECOND] })).seasons, '2 seasons')
  assert.equal(toPosterItem(anime(ALONE)).seasons, undefined)
})

console.log(`\n${pass} passed`)
