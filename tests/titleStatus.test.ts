// The three-state title status — not watched, plan to watch, watched —
// and the whole-title pushes it makes.
//
// Two things are pinned. First, the decision itself (titleStatusRules.ts):
// which steps a status change takes from each starting state, in the
// order the handler runs them, since the ordering is what keeps a plan
// removal behind the history push it depends on. Second, the payload
// shapes that make a whole-title change safe to send: a show reference
// that names no seasons removes the show's entire history at Simkl and
// Trakt, so these bodies must always name exactly the episodes changed.
//
// Run with: npx tsx tests/titleStatus.test.ts

import assert from 'node:assert/strict'

import {
  airedRegularEpisodes,
  bySeason,
  episodeKey,
  planTitleStatusChange
} from '../src/main/media-hub/titleStatusRules'
import { titleHistoryPayload as simklTitlePayload } from '../src/main/media-hub/simkl'
import { titleHistoryPayload as traktTitlePayload } from '../src/main/media-hub/trakt'
import { malStatusForProgress } from '../src/main/media-hub/mal'
import { remotePlanAdoptable } from '../src/main/media-hub/watchlistRules'
import type { Episode } from '../src/shared/media-hub/types'

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

function ep(season: number, episode: number, over: Partial<Episode> = {}): Episode {
  return {
    id: `s${season}e${episode}`,
    season,
    episode,
    number: episode,
    title: `E${episode}`,
    released: '2020-01-01',
    ...over
  }
}

const NOW = Date.parse('2026-09-14T00:00:00Z')

console.log('airedRegularEpisodes')

check('keeps aired regular episodes and drops specials, unaired and unplayable ones', () => {
  const refs = airedRegularEpisodes(
    [
      ep(0, 1),
      ep(1, 1),
      ep(1, 2, { released: '2099-01-01' }),
      ep(1, 3, { unplayable: true }),
      ep(2, 1, { released: '' }),
      ep(1, 1)
    ],
    NOW
  )
  assert.deepEqual(refs, [
    { season: 1, episode: 1 },
    { season: 2, episode: 1 }
  ])
})

check('groups by season, ascending, for one request per title', () => {
  assert.deepEqual(
    bySeason([
      { season: 2, episode: 3 },
      { season: 1, episode: 2 },
      { season: 2, episode: 1 },
      { season: 1, episode: 1 }
    ]),
    [
      { season: 1, episodes: [1, 2] },
      { season: 2, episodes: [1, 3] }
    ]
  )
})

console.log('\nplanTitleStatusChange')

const aired = [
  { season: 1, episode: 1 },
  { season: 1, episode: 2 },
  { season: 2, episode: 1 }
]
const none = new Set<string>()
const half = new Set([episodeKey(1, 1)])
const all = new Set(aired.map((ref) => episodeKey(ref.season, ref.episode)))

check('a film: not watched -> planned -> watched -> not watched', () => {
  assert.deepEqual(
    planTitleStatusChange(
      'planned',
      { planned: false, movieWatched: false, watchedKeys: none },
      { episodic: false, aired: [] }
    ),
    [{ kind: 'track' }]
  )
  assert.deepEqual(
    planTitleStatusChange(
      'watched',
      { planned: true, movieWatched: false, watchedKeys: none },
      { episodic: false, aired: [] }
    ),
    [{ kind: 'mark-movie' }, { kind: 'untrack' }],
    'the mark comes first so the un-plan queues behind it'
  )
  assert.deepEqual(
    planTitleStatusChange(
      'unwatched',
      { planned: false, movieWatched: true, watchedKeys: none },
      { episodic: false, aired: [] }
    ),
    [{ kind: 'unmark-movie' }]
  )
})

check('a show marked watched gets only the episodes still missing', () => {
  assert.deepEqual(
    planTitleStatusChange(
      'watched',
      { planned: true, movieWatched: false, watchedKeys: half },
      { episodic: true, aired }
    ),
    [
      {
        kind: 'mark-episodes',
        episodes: [
          { season: 1, episode: 2 },
          { season: 2, episode: 1 }
        ]
      },
      { kind: 'untrack' }
    ]
  )
})

check('a show already fully watched has nothing to mark, only a plan to drop', () => {
  assert.deepEqual(
    planTitleStatusChange(
      'watched',
      { planned: true, movieWatched: false, watchedKeys: all },
      { episodic: true, aired }
    ),
    [{ kind: 'untrack' }]
  )
  assert.deepEqual(
    planTitleStatusChange(
      'watched',
      { planned: false, movieWatched: false, watchedKeys: all },
      { episodic: true, aired }
    ),
    []
  )
})

check('clearing a title clears its history and leaves its plan alone', () => {
  // The un-plan is deliberately NOT part of clearing: sent to Simkl it is
  // the unscoped history/remove for a bare show (rules 3 and 8).
  assert.deepEqual(
    planTitleStatusChange(
      'unwatched',
      { planned: true, movieWatched: false, watchedKeys: half },
      { episodic: true, aired }
    ),
    [{ kind: 'unmark-title' }]
  )
  assert.deepEqual(
    planTitleStatusChange(
      'unwatched',
      { planned: true, movieWatched: true, watchedKeys: none },
      { episodic: false, aired: [] }
    ),
    [{ kind: 'unmark-movie' }]
  )
})

check('planning never touches history', () => {
  assert.deepEqual(
    planTitleStatusChange(
      'planned',
      { planned: false, movieWatched: true, watchedKeys: all },
      { episodic: true, aired }
    ),
    [{ kind: 'track' }]
  )
  assert.deepEqual(
    planTitleStatusChange(
      'planned',
      { planned: true, movieWatched: false, watchedKeys: none },
      { episodic: false, aired: [] }
    ),
    [],
    'already planned is nothing to do'
  )
})

console.log('\nwhole-title payloads')

const seasons = [
  { season: 1, episodes: [1, 2] },
  { season: 2, episodes: [1] }
]

check('Simkl: a show names every season and episode, and never sends a bare show', () => {
  const payload = simklTitlePayload(
    { id: 'tt1', type: 'series', title: 'Show', year: '2020' },
    seasons
  )
  assert.deepEqual(payload.shows?.[0].seasons, [
    { number: 1, episodes: [{ number: 1 }, { number: 2 }] },
    { number: 2, episodes: [{ number: 1 }] }
  ])
  assert.deepEqual(
    simklTitlePayload({ id: 'tt1', type: 'series', title: 'Show', year: '2020' }, []),
    {},
    'nothing to name is nothing to send'
  )
  assert.deepEqual(
    simklTitlePayload({ id: 'tt1', type: 'series', title: 'Show', year: '2020' }, [
      { season: 1, episodes: [] }
    ]),
    {}
  )
})

check('Simkl: a film takes the movie shape and anime the anime key', () => {
  const film = simklTitlePayload({ id: 'tt2', type: 'movie', title: 'Film', year: '2020' }, [])
  assert.ok(film.movies?.length === 1 && !film.shows, 'a film is never a show entry')
  const anime = simklTitlePayload(
    { id: 'kitsu:5', type: 'anime', title: 'Anime', year: '2020' },
    seasons
  )
  assert.ok(anime.anime?.length === 1 && !anime.shows)
  assert.deepEqual(
    simklTitlePayload({ id: 'simkl:9', type: 'movie', title: 'Nope', year: '2020' }, []),
    {},
    'an id no service can be told about sends nothing'
  )
})

check('Trakt: series only, always with its seasons', () => {
  const payload = traktTitlePayload({ id: 'tt1', type: 'series', title: 'Show' }, seasons)
  assert.equal(payload.shows?.[0].seasons?.length, 2)
  assert.deepEqual(traktTitlePayload({ id: 'tt1', type: 'series', title: 'Show' }, []), {})
  assert.deepEqual(traktTitlePayload({ id: 'tt2', type: 'movie', title: 'Film' }, seasons), {})
  assert.deepEqual(traktTitlePayload({ id: 'kitsu:5', type: 'anime', title: 'Anime' }, seasons), {})
})

check('MAL: a status is never invented from a zero count', () => {
  // Zero with no known total leaves the remote status alone; the one case
  // that means plan to watch says so explicitly (pushMalProgress's status).
  assert.equal(malStatusForProgress(0, undefined), undefined)
  assert.equal(malStatusForProgress(1, 12), 'watching')
  assert.equal(malStatusForProgress(12, 12), 'completed')
})

console.log('\nremotePlanAdoptable')

check('a watched title is not planned again by a pull', () => {
  const state = {
    tracked: new Set(['tt-tracked']),
    awaitingRemoval: new Set(['tt-owed']),
    watched: new Set(['tt-seen'])
  }
  assert.equal(remotePlanAdoptable('tt-new', state), true)
  assert.equal(remotePlanAdoptable('tt-tracked', state), false)
  assert.equal(remotePlanAdoptable('tt-owed', state), false)
  assert.equal(remotePlanAdoptable('tt-seen', state), false, 'watched outranks planned')
})

console.log(`\n${pass} passed`)
