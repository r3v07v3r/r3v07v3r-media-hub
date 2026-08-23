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

console.log(`\n${pass} passed`)
