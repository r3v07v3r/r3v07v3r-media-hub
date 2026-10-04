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
// card makes of them (adapters.ts, watchStatus.ts), and what the index says
// about its completion (database.ts).
//
// Run with: npx tsx tests/laterSeasonCards.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDatabase } from '../src/main/media-hub/database'
import { animeSeasonOf, watchedLaterSeasons } from '../src/shared/media-hub/serviceIds'
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
const siblingsOf = (id: string): string[] | undefined => (id === SHOW ? [SECOND, THIRD] : undefined)
const targetOf = (id: string): { id: string; season: number } =>
  id === SECOND
    ? { id: SHOW, season: 2 }
    : id === THIRD
      ? { id: SHOW, season: 3 }
      : { id, season: 1 }
const seasonOf = (id: string): { id: string; season: number } | null => animeSeasonOf(id, targetOf)

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
    db.indexByIds(ids, seasonOf).completedIds,
    [SECOND],
    'the second season is complete; the third is one of two; the show is not'
  )
  assert.deepEqual(
    db.indexQuery({ kind: 'anime' }, seasonOf).completedIds,
    [SECOND],
    'the paged grid lists the same rows and says the same'
  )

  db.markWatched(show, { season: 3, episode: 2 })
  assert.deepEqual(db.indexByIds(ids, seasonOf).completedIds.sort(), [SECOND, THIRD])
  db.close()
})

check('a row that is not a later season is still answered by the query itself', () => {
  const db = tempDb()
  db.indexUpsert('anime', [anime(ALONE, { videos: episodes(ALONE, 1, 2) })])
  const alone = { id: ALONE, type: 'anime' as const, title: ALONE }
  db.markWatched(alone, { season: 1, episode: 1 })
  assert.deepEqual(db.indexByIds([ALONE], seasonOf).completedIds, [])
  db.markWatched(alone, { season: 1, episode: 2 })
  assert.deepEqual(db.indexByIds([ALONE], seasonOf).completedIds, [ALONE])
  db.close()
})

console.log(`\n${pass} passed`)
