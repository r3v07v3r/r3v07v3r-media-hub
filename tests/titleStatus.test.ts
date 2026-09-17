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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDatabase } from '../src/main/media-hub/database'
import {
  airedRegularEpisodes,
  bySeason,
  episodesPerSeason,
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
    simklTitlePayload({ id: 'tmdb:9', type: 'movie', title: 'Nope', year: '2020' }, []),
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

console.log('\nthe rows a clear returns and an undo puts back')

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-title-status-test-'))
  const db = createDatabase(path.join(dir, 'test.sqlite'), 'profile-test')
  const show = { id: 'tt5', type: 'series' as const, title: 'Show', year: '2020', poster: 'p.jpg' }

  check('every viewing comes back, newest first, a rewatch as two rows', () => {
    db.importWatched([
      { ...show, season: 1, episode: 1, watchedAt: '2026-01-01T00:00:00.000Z' },
      { ...show, season: 1, episode: 2, watchedAt: '2026-01-02T00:00:00.000Z' },
      { ...show, season: 1, episode: 1, watchedAt: '2026-02-01T00:00:00.000Z' }
    ])
    const rows = db.watchedEpisodesOf('tt5')
    assert.deepEqual(
      rows.map((r) => `${r.season}:${r.episode}@${r.watchedAt.slice(0, 10)}`),
      ['1:1@2026-02-01', '1:2@2026-01-02', '1:1@2026-01-01']
    )
  })

  check('a whole-title clear removes history and plays, and returns what an undo needs', () => {
    const removed = db.unmarkTitle('tt5')
    assert.equal(removed.length, 3)
    assert.equal(db.watchedEpisodesOf('tt5').length, 0)
    assert.equal(db.history().filter((h) => h.id === 'tt5').length, 0)
    // The undo: the same rows, dates kept, and the poster still on them.
    db.importWatched(removed.map((r) => ({ ...show, ...r })))
    const back = db.watchedEpisodesOf('tt5')
    assert.equal(back.length, 3, 'both viewings of episode 1 are back')
    const history = db.history().filter((h) => h.id === 'tt5')
    assert.equal(history.length, 2)
    assert.ok(
      history.every((h) => h.poster === 'p.jpg'),
      'the row keeps what the push item carried'
    )
  })

  check('named rows go in one call, and only those', () => {
    const gone = db.unmarkEpisodes('tt5', [{ season: 1, episode: 2 }])
    assert.deepEqual(gone, [{ season: 1, episode: 2 }])
    const left = db.watchedEpisodesOf('tt5')
    assert.deepEqual(
      [...new Set(left.map((r) => `${r.season}:${r.episode}`))],
      ['1:1'],
      'episode 2 is gone, both viewings of episode 1 stay'
    )
  })

  check('the undo of a mark gives back only the viewing the mark recorded', () => {
    const marked = '2026-03-01T00:00:00.000Z'
    // The mark: a row and a play at one instant. Then a genuine rewatch.
    db.importWatched([{ ...show, season: 2, episode: 1, watchedAt: marked }])
    db.markWatched(show, { season: 2, episode: 1 })
    const gone = db.unmarkEpisodes('tt5', [{ season: 2, episode: 1, watchedAt: marked }])
    assert.deepEqual(gone, [], 'the episode is still watched')
    const left = db.watchedEpisodesOf('tt5').filter((r) => r.season === 2)
    assert.equal(left.length, 1, 'the rewatch is the one viewing left')
    assert.ok(left[0].watchedAt > marked)
    const row = db.history().find((h) => h.id === 'tt5' && h.season === 2)
    assert.equal(row?.watchedAt, left[0].watchedAt, 'the row is dated to the viewing that stands')
    // The rewatch's own undo is what takes the episode away.
    const rest = db.unmarkEpisodes('tt5', [{ season: 2, episode: 1, watchedAt: left[0].watchedAt }])
    assert.deepEqual(rest, [{ season: 2, episode: 1 }])
    assert.equal(db.watchedEpisodesOf('tt5').filter((r) => r.season === 2).length, 0)
  })
}

console.log('\nseasons for the services that keep one entry per season')

check('episodesPerSeason counts the regular episodes of each season once', () => {
  const totals = episodesPerSeason([
    { season: 1, episode: 1 },
    { season: 1, episode: 2 },
    { season: 1, episode: 2 },
    { season: 2, episode: 1 }
  ])
  assert.deepEqual(
    [...totals],
    [
      [1, 2],
      [2, 1]
    ]
  )
})

console.log('\nthe viewings a film clear returns and an undo puts back')

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-title-status-film-'))
  const db = createDatabase(path.join(dir, 'test.sqlite'), 'profile-test')
  const film = { id: 'tt9', type: 'movie' as const, title: 'Film', year: '2019', poster: 'f.jpg' }

  check('every dated viewing of a film comes back after a clear is undone', () => {
    db.importWatched([
      { ...film, season: null, episode: null, watchedAt: '2025-06-01T00:00:00.000Z' },
      { ...film, season: null, episode: null, watchedAt: '2026-03-01T00:00:00.000Z' }
    ])
    // What the unmark-movie step reports as `changed`: every viewing.
    const own = db.watchedEpisodesOf('tt9')
    assert.equal(own.length, 2)
    assert.equal(db.unmarkWatched('tt9'), true)
    assert.equal(db.watchedEpisodesOf('tt9').length, 0, 'the clear takes the plays too')
    // The undo replays exactly those rows, dates kept.
    db.importWatched(own.map((r) => ({ ...film, ...r })))
    assert.deepEqual(
      db.watchedEpisodesOf('tt9').map((r) => r.watchedAt.slice(0, 10)),
      ['2026-03-01', '2025-06-01']
    )
    assert.equal(db.history().filter((h) => h.id === 'tt9').length, 1)
  })

  check('the undo of a film mark leaves a viewing recorded since', () => {
    const marked = '2026-04-01T00:00:00.000Z'
    db.importWatched([{ ...film, season: null, episode: null, watchedAt: marked }])
    db.markWatched(film, {})
    const gone = db.unmarkEpisodes('tt9', [{ season: null, episode: null, watchedAt: marked }])
    assert.deepEqual(gone, [], 'the film is still watched')
    const left = db.watchedEpisodesOf('tt9')
    assert.equal(left.length, 3, 'the two earlier viewings and the new one stay')
    assert.ok(left[0].watchedAt > marked, 'newest first, and it is the viewing since')
    assert.ok(!left.some((r) => r.watchedAt === marked))
  })
}

console.log(`\n${pass} passed`)
