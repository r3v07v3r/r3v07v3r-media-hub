import assert from 'node:assert'
import {
  applyCadence,
  rankPersonalizedRecommendations,
  watchCadenceProfile
} from '../src/shared/media-hub/catalog-logic'
import type { ScoredRecommendation } from '../src/shared/media-hub/catalog-logic'
import type { CatalogItem, HistoryEntry, MediaKind } from '../src/shared/media-hub/types'

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

function title(
  id: string,
  name: string,
  year: string,
  rating = '7',
  genres = ['Action']
): CatalogItem {
  return {
    id,
    title: name,
    year,
    rating,
    genres,
    type: 'movie',
    poster: '',
    background: '',
    logo: '',
    description: '',
    runtime: '',
    videos: [],
    trailers: []
  }
}

const homecoming = title('homecoming', 'Spider-Man: Homecoming', '2017')
const farFromHome = title('far-from-home', 'Spider-Man: Far From Home', '2019')
const noWayHome = title('no-way-home', 'Spider-Man: No Way Home', '2021')
const popular = title('popular', 'Popular Action Film', '2025', '9.9')
const history: HistoryEntry[] = [
  {
    id: homecoming.id,
    type: 'movie',
    title: homecoming.title,
    year: homecoming.year,
    watchedAt: '2026-01-01',
    season: null,
    episode: null
  }
]

check('puts the next unwatched franchise instalment ahead of a higher-rated generic title', () => {
  const ranked = rankPersonalizedRecommendations([homecoming, noWayHome, popular, farFromHome], {
    history,
    now: new Date('2026-08-23T00:00:00Z')
  })
  assert.deepEqual(ranked.map((item) => item.id).slice(0, 2), ['far-from-home', 'popular'])
})

check('does not boost a later sequel past the immediate next instalment', () => {
  const ranked = rankPersonalizedRecommendations([noWayHome, farFromHome], {
    history,
    now: new Date('2026-08-23T00:00:00Z')
  })
  assert.equal(ranked[0]?.id, 'far-from-home')
})

check('boosts a current-year release when there is no clear continuation', () => {
  const ranked = rankPersonalizedRecommendations(
    [
      title('older', 'Excellent Older Film', '2020', '9.9'),
      title('new', 'New Cinema Film', '2026', '7.0')
    ],
    { history: [], now: new Date('2026-08-23T00:00:00Z') }
  )
  assert.equal(ranked[0]?.id, 'new')
})

check('uses genre preference as a stronger signal than rating alone', () => {
  const ranked = rankPersonalizedRecommendations(
    [
      title('drama', 'Prestige Drama', '2025', '9.9', ['Drama']),
      title('sci-fi', 'Fresh Sci-Fi', '2024', '7.0', ['Sci-Fi'])
    ],
    { history: [], preferredGenres: ['Sci-Fi'], now: new Date('2026-08-23T00:00:00Z') }
  )
  assert.equal(ranked[0]?.id, 'sci-fi')
})

// The whole reason this ranking was rewritten. At real-library scale the
// previous nested-loop version took 87.7 SECONDS on the Electron main
// process — measured against 3,104 history rows and 2,776 catalog titles
// — which is what "the window says Not Responding while the catalogue
// loads" actually was. home:personalized calls this once per launch.
//
// The bound is deliberately loose (a slow CI box is not a regression);
// what it catches is a return to work that grows with history x catalog x
// history, which cannot come close to fitting inside it. The rewritten
// version does this in roughly ten milliseconds.
check('ranks a real-sized library without blocking the main process', () => {
  const catalog: CatalogItem[] = []
  for (let i = 0; i < 2800; i++) {
    catalog.push(
      title(`bulk-${i}`, `Bulk Feature ${i}`, String(1990 + (i % 30)), '7.5', ['Documentary'])
    )
  }
  catalog.push(farFromHome, noWayHome)

  const bulkHistory: HistoryEntry[] = []
  for (let i = 0; i < 3100; i++) {
    // Mostly episodes of one watched series, as a real history is — the
    // same question asked three thousand times.
    const source = i % 20 === 0 ? title(`seen-${i}`, `Bulk Feature ${i}`, '2001') : homecoming
    bulkHistory.push({
      id: source.id,
      type: 'movie',
      title: source.title,
      year: source.year,
      watchedAt: '2026-01-01',
      season: null,
      episode: i,
      genres: ['Action']
    } as HistoryEntry)
  }

  const started = Date.now()
  const ranked = rankPersonalizedRecommendations(catalog, {
    history: bulkHistory,
    preferredGenres: ['Action'],
    now: new Date('2026-08-23T00:00:00Z')
  })
  const elapsed = Date.now() - started

  assert.ok(elapsed < 3000, `ranking 2,800 titles against 3,100 history rows took ${elapsed}ms`)
  // Still the right answer, not just a fast one: Homecoming is watched, so
  // its next instalment leads despite carrying no rating advantage.
  assert.equal(ranked[0]?.id, 'far-from-home')
})

// ---------------------------------------------------------------------------
// Started-and-left titles (PersonalizedRecommendationOptions.abandonedIds)
// ---------------------------------------------------------------------------

check('demotes a title that was started and left', () => {
  const dropped = title('dropped', 'Alpha Feature', '2024', '9.0')
  const fresh = title('fresh', 'Beta Feature', '2024', '9.0')
  const ranked = rankPersonalizedRecommendations([dropped, fresh], {
    history: [],
    now: new Date('2026-08-23T00:00:00Z'),
    abandonedIds: new Set(['dropped'])
  })
  assert.equal(ranked[0]?.id, 'fresh', 'the untried title should lead')
  assert.equal(ranked[1]?.id, 'dropped')
})

check('demotes it without hiding it — somebody may still go back', () => {
  const dropped = title('dropped', 'Alpha Feature', '2024', '9.0')
  const ranked = rankPersonalizedRecommendations([dropped], {
    history: [],
    now: new Date('2026-08-23T00:00:00Z'),
    abandonedIds: new Set(['dropped'])
  })
  assert.equal(ranked.length, 1, 'a demotion is not an exclusion')
})

check('the penalty never outranks a franchise continuation', () => {
  // far-from-home is the next instalment after a watched Homecoming, AND
  // was started and left. The continuation boost is the stronger claim.
  const ranked = rankPersonalizedRecommendations([popular, farFromHome], {
    history,
    now: new Date('2026-08-23T00:00:00Z'),
    abandonedIds: new Set(['far-from-home'])
  })
  assert.equal(ranked[0]?.id, 'far-from-home')
})

// ---------------------------------------------------------------------------
// Watch cadence (watchCadenceProfile / applyCadence)
// ---------------------------------------------------------------------------

// Local time on both sides — constructed local, read back with getDay()/
// getHours() — so these cases mean the same thing in every timezone.
const TUESDAY_AFTERNOON = new Date(2026, 7, 25, 14, 0, 0)
const TUESDAY_EVENING = new Date(2026, 7, 25, 20, 0, 0)

function watched(type: MediaKind, when: Date, index: number): HistoryEntry {
  return {
    id: `${type}-${index}`,
    type,
    title: `${type} ${index}`,
    year: '2024',
    watchedAt: when.toISOString(),
    season: null,
    episode: null
  }
}

function kindOf(id: string, type: MediaKind, score: number): ScoredRecommendation {
  return { item: { ...title(id, `Title ${id}`, '2024'), type }, score }
}

/** A history of anime in the afternoon and movies in the evening. */
function splitHistory(): HistoryEntry[] {
  const rows: HistoryEntry[] = []
  for (let i = 0; i < 40; i++) rows.push(watched('anime', TUESDAY_AFTERNOON, i))
  for (let i = 0; i < 60; i++) rows.push(watched('movie', TUESDAY_EVENING, i))
  return rows
}

check('reads the mix this person watches at this time of week', () => {
  const evening = watchCadenceProfile(splitHistory(), TUESDAY_EVENING)
  assert.ok(evening)
  assert.equal(evening.samples, 60)
  assert.equal(evening.shares.movie, 1)
  assert.equal(evening.shares.anime, 0)

  const afternoon = watchCadenceProfile(splitHistory(), TUESDAY_AFTERNOON)
  assert.ok(afternoon)
  assert.equal(afternoon.shares.anime, 1)
  assert.equal(afternoon.shares.movie, 0)
})

check('stays silent on too few viewings to call it a pattern', () => {
  const rows: HistoryEntry[] = []
  for (let i = 0; i < 8; i++) rows.push(watched('movie', TUESDAY_EVENING, i))
  assert.equal(watchCadenceProfile(rows, TUESDAY_EVENING), null)
})

check('an empty history has no cadence at all', () => {
  assert.equal(watchCadenceProfile([], TUESDAY_EVENING), null)
})

check('ignores rows with no timestamp rather than guessing one', () => {
  const rows = splitHistory().map((row, i) => (i % 2 ? { ...row, watchedAt: null } : row))
  const profile = watchCadenceProfile(rows, TUESDAY_EVENING)
  assert.ok(profile)
  assert.equal(profile.samples, 30, 'half the evening rows are undated and drop out')
  assert.equal(profile.shares.movie, 1, 'the surviving mix is unchanged')
})

check('no profile leaves the ranking exactly as it was', () => {
  const ranked = [kindOf('a', 'movie', 100), kindOf('b', 'anime', 90), kindOf('c', 'series', 80)]
  assert.deepEqual(
    applyCadence(ranked, null, 2).map((x) => x.id),
    ['a', 'b']
  )
})

check('surfaces a kind the ranking scores too low to ever show', () => {
  // The failure this exists for, in miniature: every series is ranked
  // below every movie, so no score bonus small enough to be safe would
  // ever put one in a four-slot row. Measured on real data, series sat at
  // ranks 25-39 of the stored forty on mornings that are 94% series.
  const ranked = [
    ...Array.from({ length: 8 }, (_, i) => kindOf(`movie-${i}`, 'movie', 100 - i)),
    ...Array.from({ length: 8 }, (_, i) => kindOf(`series-${i}`, 'series', 40 - i))
  ]
  const seriesEvening: HistoryEntry[] = []
  for (let i = 0; i < 60; i++) seriesEvening.push(watched('series', TUESDAY_EVENING, i))

  const row = applyCadence(ranked, watchCadenceProfile(seriesEvening, TUESDAY_EVENING), 4)
  const series = row.filter((x) => x.type === 'series')
  assert.equal(row.length, 4)
  assert.ok(
    series.length >= 2,
    `expected the slot's kind to get a real share, got ${series.length}`
  )
  assert.equal(series[0]?.id, 'series-0', 'and the best of that kind leads it')
})

check('moves half way to the slot, not all the way', () => {
  // 100% series in this slot, but the row is not handed over entirely —
  // the ranking still owns half of it. See CADENCE_STRENGTH.
  const ranked = [
    ...Array.from({ length: 10 }, (_, i) => kindOf(`movie-${i}`, 'movie', 100 - i)),
    ...Array.from({ length: 10 }, (_, i) => kindOf(`series-${i}`, 'series', 40 - i))
  ]
  const seriesOnly: HistoryEntry[] = []
  for (let i = 0; i < 60; i++) seriesOnly.push(watched('series', TUESDAY_EVENING, i))

  const row = applyCadence(ranked, watchCadenceProfile(seriesOnly, TUESDAY_EVENING), 10)
  const movies = row.filter((x) => x.type === 'movie').length
  assert.ok(movies >= 4 && movies <= 6, `expected a roughly even split, got ${movies} movies`)
})

check('spreads each kind through the row instead of serving one kind first', () => {
  const ranked = [
    ...Array.from({ length: 6 }, (_, i) => kindOf(`movie-${i}`, 'movie', 100 - i)),
    ...Array.from({ length: 6 }, (_, i) => kindOf(`series-${i}`, 'series', 40 - i))
  ]
  const seriesOnly: HistoryEntry[] = []
  for (let i = 0; i < 60; i++) seriesOnly.push(watched('series', TUESDAY_EVENING, i))

  const row = applyCadence(ranked, watchCadenceProfile(seriesOnly, TUESDAY_EVENING), 6)
  const kinds = row.map((x) => x.type)
  // A row of eighteen is scrolled and the first few are what gets seen, so
  // both kinds have to appear early rather than in blocks.
  assert.ok(
    new Set(kinds.slice(0, 3)).size > 1,
    `expected a mix in the first three, got ${kinds.join(',')}`
  )
})

check('never reorders two titles of the same kind', () => {
  const ranked = [
    kindOf('movie-0', 'movie', 100),
    kindOf('movie-1', 'movie', 90),
    kindOf('movie-2', 'movie', 80),
    kindOf('series-0', 'series', 70)
  ]
  const seriesOnly: HistoryEntry[] = []
  for (let i = 0; i < 60; i++) seriesOnly.push(watched('series', TUESDAY_EVENING, i))

  const row = applyCadence(ranked, watchCadenceProfile(seriesOnly, TUESDAY_EVENING), 4)
  const movieOrder = row.filter((x) => x.type === 'movie').map((x) => x.id)
  assert.deepEqual(movieOrder, ['movie-0', 'movie-1', 'movie-2'], 'base rank holds within a kind')
})

check('cannot hand a kind more slots than it has candidates', () => {
  const ranked = [
    ...Array.from({ length: 9 }, (_, i) => kindOf(`movie-${i}`, 'movie', 100 - i)),
    kindOf('series-0', 'series', 40)
  ]
  const seriesOnly: HistoryEntry[] = []
  for (let i = 0; i < 60; i++) seriesOnly.push(watched('series', TUESDAY_EVENING, i))

  const row = applyCadence(ranked, watchCadenceProfile(seriesOnly, TUESDAY_EVENING), 6)
  assert.equal(row.length, 6, 'the row is still full')
  assert.equal(row.filter((x) => x.type === 'series').length, 1, 'one series existed, one is shown')
})

console.log(`\n${pass} passed`)
