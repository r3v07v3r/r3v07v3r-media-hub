import assert from 'node:assert'
import { rankPersonalizedRecommendations } from '../src/shared/media-hub/catalog-logic'
import type { CatalogItem, HistoryEntry } from '../src/shared/media-hub/types'

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

console.log(`\n${pass} passed`)
