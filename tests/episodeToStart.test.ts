// "Press Play on a series card — which episode starts?"
//
// The rule these cover is the one a title card needs and never had: a card
// carries a show, not an episode, so before this the coordinate that reached
// the stream resolver was buildMediaId's `?? 1` — season 1, episode 1, no
// matter how far in you were.

import assert from 'node:assert/strict'

import {
  episodeToStart,
  episodeWatchKey,
  nextUnwatchedEpisode,
  playableEpisodesInOrder
} from '../src/shared/media-hub/nextEpisode'
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

function watched(...coords: [number, number][]): Set<string> {
  return new Set(coords.map(([s, e]) => episodeWatchKey(s, e)))
}

const show = [ep(1, 1), ep(1, 2), ep(1, 3), ep(2, 1), ep(2, 2)]

// Nothing watched: the beginning, which is what the old behaviour happened
// to get right and the only case it got right.
assert.deepEqual(episodeToStart(show, watched()), { season: 1, episode: 1 })

// THE REPORTED BUG. Three episodes in, Play means the fourth — not the first.
assert.deepEqual(episodeToStart(show, watched([1, 1], [1, 2], [1, 3])), {
  season: 2,
  episode: 1
})

// Across a season boundary, mid-season.
assert.deepEqual(episodeToStart(show, watched([1, 1], [1, 2], [1, 3], [2, 1])), {
  season: 2,
  episode: 2
})

// A gap in the middle is picked up at the gap: first UNWATCHED, not
// furthest-reached. Somebody who skipped one and came back should land on the
// one they skipped rather than be told they are done.
assert.deepEqual(episodeToStart(show, watched([1, 1], [1, 3], [2, 1])), {
  season: 1,
  episode: 2
})

// Every episode seen: Play starts it again from the top rather than doing
// nothing, which is what every player it gets compared to does.
assert.deepEqual(episodeToStart(show, watched([1, 1], [1, 2], [1, 3], [2, 1], [2, 2])), {
  season: 1,
  episode: 1
})

// No episode list at all (metadata never arrived, or a movie reached this by
// mistake) falls back to exactly the S1E1 buildMediaId would have used, so a
// degraded path degrades no further than it did before.
assert.deepEqual(episodeToStart(undefined, watched()), { season: 1, episode: 1 })
assert.deepEqual(episodeToStart([], watched()), { season: 1, episode: 1 })

// Synthetic "Specials" entries are never a play target — they have no real
// coordinate a stream can be resolved for — and they must not block the real
// episode sitting behind them either.
const withSpecial = [ep(0, 1, { unplayable: true }), ep(1, 1), ep(1, 2)]
assert.deepEqual(episodeToStart(withSpecial, watched()), { season: 1, episode: 1 })
assert.deepEqual(episodeToStart(withSpecial, watched([1, 1])), { season: 1, episode: 2 })

// An unsorted list gets the same answer as a sorted one: "first in order"
// must not depend on the caller having sorted it.
const shuffled = [ep(2, 2), ep(1, 2), ep(2, 1), ep(1, 1), ep(1, 3)]
assert.deepEqual(episodeToStart(shuffled, watched([1, 1])), { season: 1, episode: 2 })
assert.deepEqual(
  playableEpisodesInOrder(shuffled).map((e) => `${e.season}:${e.episode}`),
  ['1:1', '1:2', '1:3', '2:1', '2:2']
)

// A non-finite coordinate cannot become a stream id, so it is not a candidate.
const broken = [ep(Number.NaN, 1), ep(1, 1)]
assert.deepEqual(episodeToStart(broken, watched()), { season: 1, episode: 1 })

// nextUnwatchedEpisode reports "all watched" as null rather than restarting —
// the detail page shows a distinct state for it, and only episodeToStart's
// caller wants the start-over fallback.
assert.equal(nextUnwatchedEpisode(show, watched([1, 1], [1, 2], [1, 3], [2, 1], [2, 2])), null)
assert.deepEqual(nextUnwatchedEpisode(show, watched([1, 1])), {
  season: 1,
  episode: 2,
  title: 'Episode 2'
})

console.log('ok  episodeToStart')
