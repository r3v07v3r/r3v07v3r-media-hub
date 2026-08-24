import assert from 'node:assert'
import {
  matchesSelectedMoods,
  rankMoodSpotlight,
  shuffleMoodSpotlight
} from '../src/renderer/src/lib/mediaHub/moodSpotlight'
import type { MediaItem, Recommendation } from '../src/renderer/src/types'

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

function media(id: string, moods: string[], rating = 7, watched = false): MediaItem {
  return {
    id,
    mediaType: 'movie',
    title: id,
    genres: [],
    moods,
    communityRating: rating,
    watched,
    completed: watched,
    disliked: false,
    inMyList: false,
    artTint: ['#000000', '#111111'],
    initials: id.slice(0, 2)
  }
}

const catalog = [
  media('recommended', ['thrilling'], 6),
  media('unwatched-high', ['thrilling'], 9),
  media('watched', ['thrilling'], 10, true),
  media('sci-fi', ['sci-fi'], 8),
  media('both', ['thrilling', 'sci-fi'], 7)
]

const recommendations: Recommendation[] = [
  { media: catalog[0], confidence: 95, reasons: [], generatedAt: '' }
]

const filters = { hideWatched: false, hideCompleted: false, hideDisliked: false }

check('matches any selected mood for a multi-mood Spotlight', () => {
  assert.equal(matchesSelectedMoods(catalog[3], ['thrilling', 'sci-fi']), true)
  assert.equal(matchesSelectedMoods(catalog[2], ['sci-fi']), false)
})

check('places matching live recommendations before the local fallback ranking', () => {
  assert.deepEqual(
    rankMoodSpotlight(catalog, recommendations, ['thrilling'], filters)
      .slice(0, 3)
      .map((item) => item.id),
    ['recommended', 'unwatched-high', 'both']
  )
})

check('honors global watch-state exclusions before ranking', () => {
  const ranked = rankMoodSpotlight(catalog, recommendations, ['thrilling'], {
    ...filters,
    hideWatched: true,
    hideCompleted: true
  })
  assert.equal(
    ranked.some((item) => item.id === 'watched'),
    false
  )
})

check('does not repeat a surprise pick while unseen titles remain', () => {
  const ranked = Array.from({ length: 8 }, (_, index) => media(`title-${index}`, ['thrilling']))
  const first = shuffleMoodSpotlight(ranked, [], () => 0, 4)
  const second = shuffleMoodSpotlight(ranked, first.seenIds, () => 0, 4)
  assert.equal(
    second.picks.some((item) => first.picks.some((firstPick) => firstPick.id === item.id)),
    false
  )
})

console.log(`\n${pass} passed`)
