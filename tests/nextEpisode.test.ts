import assert from 'node:assert/strict'

import { nextEpisodeInOrder } from '../src/shared/media-hub/nextEpisode'
import type { Episode } from '../src/shared/media-hub/types'

function ep(season: number, episode: number, extra: Partial<Episode> = {}): Episode {
  return {
    id: `${season}:${episode}`,
    season,
    episode,
    number: episode,
    title: `Episode ${episode}`,
    released: '',
    ...extra
  }
}

const season1 = [ep(1, 1), ep(1, 2), ep(1, 3)]

// The ordinary case.
assert.deepEqual(nextEpisodeInOrder(season1, { season: 1, episode: 1 }), {
  season: 1,
  episode: 2,
  title: 'Episode 2'
})

// The end of a title has nothing to advance to.
assert.equal(nextEpisodeInOrder(season1, { season: 1, episode: 3 }), null)

// Crossing a season boundary is the same question, so it gets the same answer.
assert.deepEqual(nextEpisodeInOrder([...season1, ep(2, 1)], { season: 1, episode: 3 }), {
  season: 2,
  episode: 1,
  title: 'Episode 1'
})

// Order is by (season, episode), not by array position — a metadata source
// that returns its seasons out of order must not change the answer.
assert.deepEqual(nextEpisodeInOrder([ep(2, 1), ep(1, 2), ep(1, 1)], { season: 1, episode: 1 }), {
  season: 1,
  episode: 2,
  title: 'Episode 2'
})

// The rule is "next in order", NOT "next unwatched" — this is the whole reason
// the function exists rather than reusing MediaDetailPage's nextEpisode. A
// rewatch of S01E01 goes to S01E02 even though the viewer has seen everything;
// the function is not told about watch state at all, and must not need to be.
assert.deepEqual(nextEpisodeInOrder(season1, { season: 1, episode: 1 }), {
  season: 1,
  episode: 2,
  title: 'Episode 2'
})

// Synthetic Specials entries (disambiguateVideos in main/media-hub/core.ts)
// have no coordinate a stream can be resolved for. They are skipped WITHOUT
// blocking the real episode sitting behind them.
assert.deepEqual(
  nextEpisodeInOrder([ep(1, 1), ep(1, 2, { unplayable: true }), ep(1, 3)], {
    season: 1,
    episode: 1
  }),
  { season: 1, episode: 3, title: 'Episode 3' }
)

// A current coordinate that is not in the list at all is normal, not an error:
// season lists get refetched mid-playback, and anime ids are scoped to one
// cour. "First entry strictly after" still answers correctly.
assert.deepEqual(nextEpisodeInOrder(season1, { season: 1, episode: 0 }), {
  season: 1,
  episode: 1,
  title: 'Episode 1'
})

// A movie reaches here with no coordinate at all, and must not produce one.
assert.equal(nextEpisodeInOrder(season1, { season: null, episode: null }), null)
assert.equal(nextEpisodeInOrder(season1, {}), null)

// No episode list is the cold-metadata case, and is simply "no card".
assert.equal(nextEpisodeInOrder([], { season: 1, episode: 1 }), null)
assert.equal(nextEpisodeInOrder(undefined, { season: 1, episode: 1 }), null)

// Non-numeric coordinates on either side are dropped rather than compared.
assert.equal(
  nextEpisodeInOrder([ep(Number.NaN, 4)], { season: 1, episode: 1 }),
  null,
  'an episode with an unusable coordinate is not a play target'
)

console.log('nextEpisode tests passed')
