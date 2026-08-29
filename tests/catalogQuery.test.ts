// Does the SQL browse query mean the same thing as the in-memory filter it
// replaces? (src/main/media-hub/database.ts's indexQuery/indexFacets,
// against src/shared/media-hub/catalogFilters.)
//
// Moving a filter into SQL is the kind of change that looks like a rewrite
// and behaves like a redefinition. "Under 90 min" can quietly become "90 or
// under"; a title with no known runtime can start matching "short" instead of
// being excluded; an unrated title can sort as the best rather than the
// worst. None of those fail loudly — they just answer a slightly different
// question than the one the person asked.
//
// Section 6 is the direct comparison: the same corpus through SQL and
// through applyCategoryFilters/sortMediaItems themselves, across every
// filter and sort. Sections 1-5 pin the individual joints, which is what
// localises a failure when section 6 goes red.
//
// This pins the two joints where that can happen:
//
//   1. The bucket RANGES reproduce the original `test:` closures exactly.
//      Those closures are gone now (see catalogFilters.ts on why ranges had
//      to replace them), so they are transcribed below and checked over
//      every integer they could receive. This is a historical assertion —
//      that the migration changed nothing — not a duplicate of live logic.
//
//   2. The SQL predicate selects exactly what bucketTest selects, over the
//      same values. Combined with (1), that makes the SQL equal to the
//      original closures by transitivity.
//
// Plus the NULL rules, which is where the two engines are most free to
// disagree without either looking wrong on its own.
//
// Run with: npx tsx tests/catalogQuery.test.ts   (or npm.cmd test)

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../src/main/media-hub/database'
import {
  bucketTest,
  EPISODES_BUCKETS,
  EPISODE_LENGTH_BUCKETS,
  RUNTIME_BUCKETS,
  SEASONS_BUCKETS,
  type Bucket
} from '../src/shared/media-hub/catalogFilters'
import type { CatalogItem, MediaKind } from '../src/shared/media-hub/types'
import type { CatalogQuery } from '../src/shared/media-hub/types'
import {
  applyCategoryFilters,
  availableGenres,
  availableYears,
  DEFAULT_FILTER_STATE,
  sortMediaItems,
  type CategoryFilterState,
  type SortKey
} from '../src/renderer/src/lib/mediaHub/categoryFilters'
import { catalogItemToMediaItem } from '../src/renderer/src/lib/mediaHub/adapters'

const TEST_PROFILE = 'profile-under-test'

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

function tempDb(): ReturnType<typeof createDatabase> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-query-test-'))
  return createDatabase(path.join(dir, 'test.sqlite'), TEST_PROFILE)
}

function item(id: string, over: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id,
    title: id,
    type: 'movie',
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

// ---------------------------------------------------------------------
// 1. The ranges reproduce the closures they replaced.
// ---------------------------------------------------------------------

/** The `test:` closures exactly as categoryFilters.ts carried them before
 *  the move to ranges. Transcribed, not imported — they no longer exist. */
const ORIGINAL: Record<string, (n: number) => boolean> = {
  'runtime:short': (m) => m < 90,
  'runtime:medium': (m) => m >= 90 && m <= 120,
  'runtime:long': (m) => m > 120,
  'seasons:1': (n) => n === 1,
  'seasons:2-4': (n) => n >= 2 && n <= 4,
  'seasons:5plus': (n) => n >= 5,
  'epLength:short': (m) => m < 30,
  'epLength:medium': (m) => m >= 30 && m <= 45,
  'epLength:long': (m) => m > 45,
  'episodes:short': (n) => n < 13,
  'episodes:medium': (n) => n >= 13 && n <= 26,
  'episodes:long': (n) => n > 26
}

const GROUPS: [string, Bucket[]][] = [
  ['runtime', RUNTIME_BUCKETS],
  ['seasons', SEASONS_BUCKETS],
  ['epLength', EPISODE_LENGTH_BUCKETS],
  ['episodes', EPISODES_BUCKETS]
]

check('every bucket range selects exactly what its old closure did', () => {
  for (const [group, buckets] of GROUPS) {
    for (const bucket of buckets) {
      const original = ORIGINAL[`${group}:${bucket.value}`]
      assert.ok(original, `no transcribed closure for ${group}:${bucket.value}`)
      const now = bucketTest(bucket)
      for (let n = 0; n <= 200; n++) {
        assert.equal(
          now(n),
          original(n),
          `${group}:${bucket.value} disagrees at ${n} (range says ${now(n)}, closure said ${original(n)})`
        )
      }
    }
  }
})

check('the buckets in each group partition their range with no gap or overlap', () => {
  // Not a restatement of the above: this is the property a person reading the
  // dropdown assumes — every title lands in exactly one option.
  for (const [group, buckets] of GROUPS) {
    for (let n = 1; n <= 200; n++) {
      const matches = buckets.filter((b) => bucketTest(b)(n))
      assert.equal(matches.length, 1, `${group} has ${matches.length} buckets matching ${n}`)
    }
  }
})

// ---------------------------------------------------------------------
// 2. The SQL predicate selects exactly what bucketTest selects.
// ---------------------------------------------------------------------

/** Seeds one row per integer 0..120, with `field` set to that integer, and
 *  returns which integers the SQL bucket filter selects. */
function sqlSelected(
  kind: MediaKind,
  makeItem: (n: number) => CatalogItem,
  queryKey: string,
  bucketValue: string
): Set<number> {
  const db = tempDb()
  try {
    db.indexUpsert(
      kind,
      Array.from({ length: 121 }, (_unused, n) => makeItem(n))
    )
    const result = db.indexQuery({
      kind,
      [queryKey]: bucketValue,
      limit: 500
    } as Parameters<typeof db.indexQuery>[0])
    assert.equal(result.total, result.items.length, 'total must agree with an unpaged result')
    return new Set(result.items.map((x) => Number(x.id.replace('n', ''))))
  } finally {
    db.close()
  }
}

check('SQL runtime buckets match bucketTest exactly', () => {
  for (const bucket of RUNTIME_BUCKETS) {
    const selected = sqlSelected(
      'movie',
      (n) => item(`n${n}`, { runtime: `${n} min` }),
      'runtimeBucket',
      bucket.value
    )
    const test = bucketTest(bucket)
    for (let n = 0; n <= 120; n++) {
      // n === 0 never survives: parseRuntimeMinutes rejects a non-positive
      // runtime, so the column is NULL and the null-rule below excludes it.
      const expected = n > 0 && test(n)
      assert.equal(selected.has(n), expected, `runtime ${bucket.value} at ${n}`)
    }
  }
})

check('SQL seasons/episodes buckets match bucketTest exactly', () => {
  const cases: [string, Bucket[], (n: number) => CatalogItem][] = [
    [
      'seasonsBucket',
      SEASONS_BUCKETS,
      (n) => item(`n${n}`, { type: 'series', episodeCounts: { totalSeasons: n, totalEpisodes: 1 } })
    ],
    [
      'episodesBucket',
      EPISODES_BUCKETS,
      (n) => item(`n${n}`, { type: 'series', episodeCounts: { totalSeasons: 1, totalEpisodes: n } })
    ]
  ]
  for (const [key, buckets, make] of cases) {
    for (const bucket of buckets) {
      const selected = sqlSelected('series', make, key, bucket.value)
      const test = bucketTest(bucket)
      for (let n = 0; n <= 120; n++) {
        assert.equal(selected.has(n), test(n), `${key} ${bucket.value} at ${n}`)
      }
    }
  }
})

check('episode length reads the runtime column, as the in-memory filter did', () => {
  // applyCategoryFilters used item.runtimeMinutes for BOTH the runtime bucket
  // and the episode-length bucket — for a series, the stored runtime is the
  // per-episode length. A separate column here would silently filter on
  // nothing.
  const selected = sqlSelected(
    'series',
    (n) => item(`n${n}`, { type: 'series', runtime: `${n} min` }),
    'episodeLengthBucket',
    'short'
  )
  assert.ok(selected.has(20), 'a 20-minute episode is "short"')
  assert.ok(!selected.has(40), 'a 40-minute episode is not')
})

// ---------------------------------------------------------------------
// 3. NULL rules — where the two engines could most easily disagree.
// ---------------------------------------------------------------------

check('a title with no measurement is excluded by a bucket filter', () => {
  // The original bailed on `item.<field> == null` BEFORE running the test.
  // Absence of a runtime is not evidence of a short one.
  const db = tempDb()
  db.indexUpsert('movie', [item('known', { runtime: '100 min' }), item('unknown')])
  for (const value of ['short', 'medium', 'long']) {
    const ids = db.indexQuery({ kind: 'movie', runtimeBucket: value }).items.map((x) => x.id)
    assert.ok(!ids.includes('unknown'), `an unknown runtime must not match "${value}"`)
  }
  db.close()
})

check('a year filter excludes titles with no year', () => {
  // The original compared String(releaseYear ?? '') against the filter, and
  // '' never equals a real year.
  const db = tempDb()
  db.indexUpsert('movie', [item('dated', { year: '1999' }), item('undated')])
  const ids = db.indexQuery({ kind: 'movie', year: '1999' }).items.map((x) => x.id)
  assert.deepEqual(ids, ['dated'])
  db.close()
})

check('an unrated title counts as 0 for minRating', () => {
  // The original wrote `(communityRating ?? 0) < minRating`.
  const db = tempDb()
  db.indexUpsert('movie', [item('good', { rating: '8.5' }), item('unrated')])
  assert.deepEqual(
    db.indexQuery({ kind: 'movie', minRating: 7 }).items.map((x) => x.id),
    ['good']
  )
  // ...and a threshold of 0 therefore still admits it.
  assert.equal(db.indexQuery({ kind: 'movie', minRating: 0 }).total, 2)
  db.close()
})

check('a status filter excludes titles with no status', () => {
  const db = tempDb()
  db.indexUpsert('series', [
    item('ended', { type: 'series', status: 'ended' }),
    item('blank', { type: 'series' })
  ])
  assert.deepEqual(
    db.indexQuery({ kind: 'series', status: 'ended' }).items.map((x) => x.id),
    ['ended']
  )
  db.close()
})

check('a bucket value that no longer exists matches nothing, not everything', () => {
  // A stale bookmark. The original's `if (!bucket) return false` made this an
  // empty grid; dropping the clause instead would silently show the whole
  // library and look like the filter had been cleared.
  const db = tempDb()
  db.indexUpsert('movie', [item('a', { runtime: '100 min' }), item('b', { runtime: '30 min' })])
  assert.equal(db.indexQuery({ kind: 'movie', runtimeBucket: 'no-such-bucket' }).total, 0)
  db.close()
})

check('an unparseable year matches nothing rather than being ignored', () => {
  const db = tempDb()
  db.indexUpsert('movie', [item('a', { year: '1999' })])
  assert.equal(db.indexQuery({ kind: 'movie', year: 'not-a-year' }).total, 0)
  db.close()
})

// ---------------------------------------------------------------------
// 4. Sorting, including the stability the in-memory sort had for free.
// ---------------------------------------------------------------------

check('sorts order by the right key, with nulls where ?? 0 put them', () => {
  const db = tempDb()
  db.indexUpsert('movie', [
    item('mid', { year: '2000', rating: '5', runtime: '100 min' }),
    item('high', { year: '2020', rating: '9', runtime: '200 min' }),
    item('none'),
    item('low', { year: '1990', rating: '1', runtime: '50 min' })
  ])
  const ids = (sort: Parameters<typeof db.indexQuery>[0]['sort']): string[] =>
    db.indexQuery({ kind: 'movie', sort }).items.map((x) => x.id)

  // `?? 0` put an unknown value at the bottom of a descending sort...
  assert.deepEqual(ids('year-desc'), ['high', 'mid', 'low', 'none'])
  assert.deepEqual(ids('rating-desc'), ['high', 'mid', 'low', 'none'])
  assert.deepEqual(ids('runtime-desc'), ['high', 'mid', 'low', 'none'])
  // ...and at the TOP of an ascending one. Not an oversight to be tidied:
  // it is what the in-memory sort did, and changing it here would move
  // untimed titles without anyone asking.
  assert.deepEqual(ids('runtime-asc'), ['none', 'low', 'mid', 'high'])
  db.close()
})

check('trending is the crawl order, and title-asc is alphabetical', () => {
  const db = tempDb()
  db.indexUpsert('movie', [item('c', { title: 'Charlie' }), item('a', { title: 'alpha' })])
  assert.deepEqual(
    db.indexQuery({ kind: 'movie', sort: 'trending' }).items.map((x) => x.id),
    ['c', 'a'],
    'trending preserves the merged source order'
  )
  assert.deepEqual(
    db.indexQuery({ kind: 'movie', sort: 'title-asc' }).items.map((x) => x.id),
    ['a', 'c'],
    'title-asc is case-insensitive, as localeCompare was'
  )
  db.close()
})

check('equal values keep crawl order — the stability JS sort gave for free', () => {
  // Array.prototype.sort is stable, so the in-memory sort left equal-valued
  // titles in rank order. SQLite guarantees nothing without an explicit
  // tiebreaker, and for a PAGED reader an unstable order means seeing one
  // title twice and another never.
  const db = tempDb()
  db.indexUpsert(
    'movie',
    Array.from({ length: 20 }, (_unused, i) => item(`n${i}`, { year: '2000' }))
  )
  const expected = Array.from({ length: 20 }, (_unused, i) => `n${i}`)
  assert.deepEqual(
    db.indexQuery({ kind: 'movie', sort: 'year-desc', limit: 50 }).items.map((x) => x.id),
    expected
  )
  db.close()
})

check('paging a sorted query neither repeats nor drops a title', () => {
  const db = tempDb()
  db.indexUpsert(
    'movie',
    Array.from({ length: 25 }, (_unused, i) => item(`n${i}`, { rating: String((i % 3) + 1) }))
  )
  const seen: string[] = []
  for (let offset = 0; offset < 25; offset += 10) {
    seen.push(
      ...db
        .indexQuery({ kind: 'movie', sort: 'rating-desc', offset, limit: 10 })
        .items.map((x) => x.id)
    )
  }
  assert.equal(seen.length, 25)
  assert.equal(new Set(seen).size, 25, 'every title appears exactly once across the pages')
  db.close()
})

// ---------------------------------------------------------------------
// 5. total, paging bounds, and facets.
// ---------------------------------------------------------------------

check('total counts matches, not the page', () => {
  const db = tempDb()
  db.indexUpsert(
    'movie',
    Array.from({ length: 40 }, (_unused, i) => item(`n${i}`, { genres: i < 12 ? ['Drama'] : [] }))
  )
  const page = db.indexQuery({ kind: 'movie', genre: 'Drama', limit: 5 })
  assert.equal(page.items.length, 5, 'the page respects limit')
  assert.equal(page.total, 12, 'total is every match, so the hero can quote the real size')
  db.close()
})

check('a genre filter matches one of several genres', () => {
  const db = tempDb()
  db.indexUpsert('movie', [
    item('multi', { genres: ['Drama', 'Horror'] }),
    item('other', { genres: ['Comedy'] })
  ])
  assert.deepEqual(
    db.indexQuery({ kind: 'movie', genre: 'Horror' }).items.map((x) => x.id),
    ['multi']
  )
  db.close()
})

check('an absurd limit is clamped rather than honoured', () => {
  const db = tempDb()
  db.indexUpsert(
    'movie',
    Array.from({ length: 600 }, (_unused, i) => item(`n${i}`))
  )
  const page = db.indexQuery({ kind: 'movie', limit: 100000 })
  assert.ok(page.items.length <= 500, 'one IPC payload should not be the whole library')
  assert.equal(page.total, 600, 'the clamp does not distort the reported total')
  db.close()
})

check('a negative offset is treated as the start, not an error', () => {
  const db = tempDb()
  db.indexUpsert('movie', [item('a'), item('b')])
  assert.equal(db.indexQuery({ kind: 'movie', offset: -5 }).items.length, 2)
  db.close()
})

check('facets list what actually occurs, in the dropdowns own order', () => {
  const db = tempDb()
  db.indexUpsert('series', [
    item('a', { type: 'series', genres: ['Horror', 'Drama'], year: '1999', status: 'ended' }),
    item('b', { type: 'series', genres: ['Drama'], year: '2020', status: 'ongoing' }),
    item('c', { type: 'series' })
  ])
  const facets = db.indexFacets('series')
  assert.deepEqual(facets.genres, ['Drama', 'Horror'], 'genres are alphabetical and deduped')
  assert.deepEqual(facets.years, [2020, 1999], 'years are newest first')
  assert.deepEqual(facets.statuses, ['ended', 'ongoing'])
  db.close()
})

check('facets omit absent values rather than offering an empty option', () => {
  // The dropdowns guarded with `if (g)` / `if (item.releaseYear)` /
  // `if (item.status)`. An "" option would filter to nothing.
  const db = tempDb()
  db.indexUpsert('series', [item('c', { type: 'series' })])
  const facets = db.indexFacets('series')
  assert.deepEqual(facets, { genres: [], years: [], statuses: [] })
  db.close()
})

check('facets are scoped to one kind', () => {
  const db = tempDb()
  db.indexUpsert('movie', [item('m', { genres: ['Western'] })])
  db.indexUpsert('series', [item('s', { type: 'series', genres: ['Sitcom'] })])
  assert.deepEqual(db.indexFacets('movie').genres, ['Western'])
  assert.deepEqual(db.indexFacets('series').genres, ['Sitcom'])
  db.close()
})

check('filters combine as AND', () => {
  const db = tempDb()
  db.indexUpsert('movie', [
    item('both', { genres: ['Drama'], year: '1999', rating: '9' }),
    item('genreOnly', { genres: ['Drama'], year: '2001', rating: '9' }),
    item('yearOnly', { genres: ['Comedy'], year: '1999', rating: '9' })
  ])
  assert.deepEqual(
    db.indexQuery({ kind: 'movie', genre: 'Drama', year: '1999', minRating: 8 }).items.map(
      (x) => x.id
    ),
    ['both']
  )
  db.close()
})

check('an empty index answers rather than throwing', () => {
  const db = tempDb()
  assert.deepEqual(db.indexQuery({ kind: 'anime' }), { items: [], total: 0, completedIds: [] })
  db.close()
})

// ---------------------------------------------------------------------
// 6. The real thing: SQL vs the actual in-memory engine.
//
// Everything above pins a piece. This compares the two engines end to end,
// on the same data, across every filter and sort the UI can produce —
// against applyCategoryFilters/sortMediaItems THEMSELVES, not a
// transcription of them. If someone changes what a filter means in the
// renderer and not in SQL (or the reverse), this is what fails.
//
// Titles here are deliberately ASCII. 'title-asc' is localeCompare in
// memory and ORDER BY title_sort in SQL, and those agree on ASCII but can
// differ on accented or non-Latin text — see indexOrderBy, which documents
// that as a known bound rather than pretending it away. Asserting over
// non-ASCII here would be asserting a limitation, not a contract.
// ---------------------------------------------------------------------

const CORPUS: CatalogItem[] = [
  item('tt1', { title: 'Alpha', year: '1999', rating: '8.5', runtime: '95 min', genres: ['Drama'] }),
  item('tt2', { title: 'Bravo', year: '2020', rating: '6.0', runtime: '140 min', genres: ['Drama', 'Horror'] }),
  item('tt3', { title: 'charlie', year: '1999', rating: '9.2', runtime: '80 min', genres: ['Comedy'] }),
  item('tt4', { title: 'Delta', year: '2005', runtime: '120 min', genres: ['Horror'] }),
  item('tt5', { title: 'Echo', year: '2020', rating: '7.1', genres: [] }),
  item('tt6', { title: 'Foxtrot', rating: '5.0', runtime: '200 min', genres: ['Drama'] }),
  item('tt7', { title: 'Golf', year: '1980', rating: '9.2', runtime: '95 min', genres: ['Comedy', 'Drama'] }),
  item('tt8', { title: 'hotel', year: '2005', rating: '6.0', runtime: '30 min', genres: ['Drama'] })
]

const SORTS = [
  undefined,
  'trending',
  'title-asc',
  'year-desc',
  'rating-desc',
  'runtime-asc',
  'runtime-desc'
] as const

const FILTER_CASES: Record<string, Record<string, unknown>> = {
  none: {},
  genre: { genre: 'Drama' },
  'genre-absent': { genre: 'Western' },
  year: { year: '1999' },
  'year-none': { year: '2099' },
  rating6: { minRating: 6 },
  rating9: { minRating: 9 },
  rating0: { minRating: 0 },
  'runtime-short': { runtimeBucket: 'short' },
  'runtime-medium': { runtimeBucket: 'medium' },
  'runtime-long': { runtimeBucket: 'long' },
  'genre+year': { genre: 'Drama', year: '1999' },
  'genre+rating': { genre: 'Drama', minRating: 8 },
  'year+runtime': { year: '1999', runtimeBucket: 'medium' },
  'all-three': { genre: 'Drama', year: '2005', minRating: 5, runtimeBucket: 'short' }
}

check('SQL and the in-memory engine agree on every filter x sort', () => {
  const db = tempDb()
  db.indexUpsert('movie', CORPUS)
  const asMedia = CORPUS.map((x) => catalogItemToMediaItem(x))

  for (const [name, filter] of Object.entries(FILTER_CASES)) {
    for (const sort of SORTS) {
      const sqlIds = db
        .indexQuery({ kind: 'movie', ...filter, sort, limit: 500 } as CatalogQuery)
        .items.map((x) => x.id)

      const memIds = sortMediaItems(
        applyCategoryFilters(asMedia, { ...DEFAULT_FILTER_STATE, ...filter } as CategoryFilterState),
        (sort ?? 'trending') as SortKey
      ).map((x) => x.id)

      assert.deepEqual(
        sqlIds,
        memIds,
        `filter "${name}" sorted "${sort ?? 'trending'}": SQL gave [${sqlIds}], memory gave [${memIds}]`
      )
    }
  }
  db.close()
})

check('total matches the in-memory result length for every filter', () => {
  const db = tempDb()
  db.indexUpsert('movie', CORPUS)
  const asMedia = CORPUS.map((x) => catalogItemToMediaItem(x))
  for (const [name, filter] of Object.entries(FILTER_CASES)) {
    const total = db.indexQuery({ kind: 'movie', ...filter, limit: 1 } as CatalogQuery).total
    const expected = applyCategoryFilters(asMedia, {
      ...DEFAULT_FILTER_STATE,
      ...filter
    } as CategoryFilterState).length
    assert.equal(total, expected, `filter "${name}" total`)
  }
  db.close()
})

check('facets match what the dropdowns derived from the same pool', () => {
  const db = tempDb()
  db.indexUpsert('movie', CORPUS)
  const asMedia = CORPUS.map((x) => catalogItemToMediaItem(x))
  const facets = db.indexFacets('movie')
  assert.deepEqual(facets.genres, availableGenres(asMedia))
  assert.deepEqual(facets.years, availableYears(asMedia))
})

// ---------------------------------------------------------------------
// 7. Watch state — applied by the query, not to its result.
//
// These have to run in SQL or paging breaks: filtering a returned page
// makes it shrink unpredictably (ask for 30, render 22) and makes `total`
// describe something other than what the person is looking at.
// ---------------------------------------------------------------------

/** A series whose episodes all aired in the past. */
function airedSeries(id: string, episodes: number): CatalogItem {
  return item(id, {
    type: 'series',
    videos: Array.from({ length: episodes }, (_unused, i) => ({
      id: `${id}:1:${i + 1}`,
      season: 1,
      episode: i + 1,
      number: i + 1,
      title: '',
      released: '2000-01-01T00:00:00.000Z'
    }))
  })
}

check('aired counts exclude episodes that have not been broadcast yet', () => {
  // The badge's denominator is what has AIRED, not what will exist — or a
  // still-running series could never be complete. See migration 3.
  const db = tempDb()
  const future = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
  db.indexUpsert('series', [
    item('tt1', {
      type: 'series',
      videos: [
        {
          id: 'a',
          season: 1,
          episode: 1,
          number: 1,
          title: '',
          released: '2000-01-01T00:00:00.000Z'
        },
        { id: 'b', season: 1, episode: 2, number: 2, title: '', released: future }
      ]
    })
  ])
  db.markWatched({ id: 'tt1', type: 'series', title: 'tt1' }, { season: 1, episode: 1 })
  const result = db.indexQuery({ kind: 'series' })
  assert.deepEqual(result.completedIds, ['tt1'], 'caught up on everything aired counts as complete')
  db.close()
})

check('an episode with no release date counts as aired, as it did in memory', () => {
  // Kitsu synthesizes episodes with no dates, and airedEpisodes treats
  // `!released` as aired. Reproducing that keeps anime behaving as before.
  const db = tempDb()
  db.indexUpsert('anime', [
    item('kitsu:1', {
      type: 'anime',
      videos: [
        { id: 'a', season: 1, episode: 1, number: 1, title: '', released: '' },
        { id: 'b', season: 1, episode: 2, number: 2, title: '', released: '' }
      ]
    })
  ])
  db.markWatched({ id: 'kitsu:1', type: 'anime', title: 'a' }, { season: 1, episode: 1 })
  assert.deepEqual(db.indexQuery({ kind: 'anime' }).completedIds, [], 'one of two is not complete')
  db.markWatched({ id: 'kitsu:1', type: 'anime', title: 'a' }, { season: 1, episode: 2 })
  assert.deepEqual(db.indexQuery({ kind: 'anime' }).completedIds, ['kitsu:1'])
  db.close()
})

check('a series is complete only once every aired episode is watched', () => {
  const db = tempDb()
  db.indexUpsert('series', [airedSeries('tt1', 3)])
  assert.deepEqual(db.indexQuery({ kind: 'series' }).completedIds, [], 'nothing watched')
  db.markWatched({ id: 'tt1', type: 'series', title: 'tt1' }, { season: 1, episode: 1 })
  db.markWatched({ id: 'tt1', type: 'series', title: 'tt1' }, { season: 1, episode: 2 })
  assert.deepEqual(db.indexQuery({ kind: 'series' }).completedIds, [], 'partway through')
  db.markWatched({ id: 'tt1', type: 'series', title: 'tt1' }, { season: 1, episode: 3 })
  assert.deepEqual(db.indexQuery({ kind: 'series' }).completedIds, ['tt1'])
  db.close()
})

check('rewatching one episode does not complete a series', () => {
  // Documents the intent; note that the guarantee comes from watch_history's
  // own key, not from the query. markWatched upserts on (profile, watch_key)
  // where watch_key is "<id>:<season>:<episode>", so three viewings of
  // episode one are one row. The COUNT(DISTINCT) in COMPLETED_SQL is
  // belt-and-braces on top of that uniqueness — confirmed by mutation:
  // swapping it for COUNT(*) changes no result here, because there is no
  // duplicate for it to over-count. Repeat viewings live in `plays`.
  const db = tempDb()
  db.indexUpsert('series', [airedSeries('tt1', 3)])
  for (let i = 0; i < 3; i++) {
    db.markWatched({ id: 'tt1', type: 'series', title: 'tt1' }, { season: 1, episode: 1 })
  }
  assert.deepEqual(db.indexQuery({ kind: 'series' }).completedIds, [])
  db.close()
})

check('a movie is complete exactly when it is watched', () => {
  const db = tempDb()
  db.indexUpsert('movie', [item('tt1'), item('tt2')])
  db.markWatched({ id: 'tt1', type: 'movie', title: 'tt1' })
  assert.deepEqual(db.indexQuery({ kind: 'movie' }).completedIds, ['tt1'])
  db.close()
})

check('a series with no known aired count is never complete', () => {
  // Rows written before migration 3 have no aired count. "Unknown" must read
  // as not-complete, or every one of them would show the badge on the
  // strength of a denominator nobody has.
  const db = tempDb()
  db.indexUpsert('series', [item('tt1', { type: 'series' })])
  db.markWatched({ id: 'tt1', type: 'series', title: 'tt1' }, { season: 1, episode: 1 })
  assert.deepEqual(db.indexQuery({ kind: 'series' }).completedIds, [])
  db.close()
})

check('hide filters exclude in the query, and total follows', () => {
  const db = tempDb()
  db.indexUpsert('movie', [item('seen'), item('hated'), item('fresh')])
  db.markWatched({ id: 'seen', type: 'movie', title: 'seen' })
  db.dislike({ id: 'hated', type: 'movie', title: 'hated' })

  const watched = db.indexQuery({ kind: 'movie', hideWatched: true })
  assert.deepEqual(
    watched.items.map((x) => x.id),
    ['hated', 'fresh']
  )
  assert.equal(watched.total, 2, 'total counts what survived the exclusion')

  const disliked = db.indexQuery({ kind: 'movie', hideDisliked: true })
  assert.deepEqual(
    disliked.items.map((x) => x.id),
    ['seen', 'fresh']
  )
  assert.equal(disliked.total, 2)

  // A watched movie is a completed movie, so hideCompleted drops it too.
  const completed = db.indexQuery({ kind: 'movie', hideCompleted: true })
  assert.deepEqual(
    completed.items.map((x) => x.id),
    ['hated', 'fresh']
  )

  const both = db.indexQuery({ kind: 'movie', hideWatched: true, hideDisliked: true })
  assert.deepEqual(
    both.items.map((x) => x.id),
    ['fresh']
  )
  assert.equal(both.total, 1)
  db.close()
})

check('watch state is scoped to the active profile', () => {
  // catalog_index is shared across profiles (see migration 2) while
  // watch_history is not. One person marking a film watched must not empty
  // it from another's grid — which is exactly what a query that forgot to
  // scope the join would do.
  const db = tempDb()
  db.indexUpsert('movie', [item('tt1')])
  db.markWatched({ id: 'tt1', type: 'movie', title: 'tt1' })
  assert.equal(db.indexQuery({ kind: 'movie', hideWatched: true }).total, 0)
  assert.deepEqual(db.indexQuery({ kind: 'movie' }).completedIds, ['tt1'])

  db.setActiveProfile('someone-else')
  assert.equal(
    db.indexQuery({ kind: 'movie', hideWatched: true }).total,
    1,
    "another profile's viewing must not hide it here"
  )
  assert.deepEqual(
    db.indexQuery({ kind: 'movie' }).completedIds,
    [],
    'nor mark it complete for them'
  )
  // The catalog row itself is shared and unaffected either way.
  assert.equal(db.indexCount('movie'), 1)
  db.close()
})

check('exclusions page correctly rather than thinning each page', () => {
  // The failure this prevents: filtering the RETURNED page instead of the
  // query, so a request for 10 renders 6 and the next page starts in the
  // wrong place.
  const db = tempDb()
  db.indexUpsert(
    'movie',
    Array.from({ length: 30 }, (_unused, i) => item(`n${i}`))
  )
  for (let i = 0; i < 30; i += 2) {
    db.markWatched({ id: `n${i}`, type: 'movie', title: `n${i}` })
  }
  const first = db.indexQuery({ kind: 'movie', hideWatched: true, limit: 10, offset: 0 })
  const second = db.indexQuery({ kind: 'movie', hideWatched: true, limit: 10, offset: 10 })
  assert.equal(first.total, 15, 'total is the unwatched count, not the library size')
  assert.equal(first.items.length, 10, 'a full page is a full page')
  assert.equal(second.items.length, 5, 'and the last one is short, not thinned')
  assert.equal(new Set([...first.items, ...second.items].map((x) => x.id)).size, 15)
  db.close()
})

console.log(`\n${pass} passed`)
