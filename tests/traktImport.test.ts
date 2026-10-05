// Bringing a Trakt account's history in.
//
// The dangerous half of a two-way sync. It writes into the table every
// recommendation, badge and statistic is derived from, from data this app
// did not produce, and it is the one operation somebody is most likely to
// run twice — because the honest response to a partial import is to run it
// again. So the three things pinned here are: real dates survive, nothing
// already here is overwritten, and running it twice changes nothing.
//
// Then the incremental pull that follows an import (traktHistoryPull.ts):
// gated on Trakt's /sync/last_activities, reading /sync/history only from
// the last pull on, filing rows where the import files them, and never
// writing this device's own pushes back as second plays.
//
// Run with: npx tsx tests/traktImport.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDatabase } from '../src/main/media-hub/database'
import {
  parseTraktActivities,
  parseTraktHistory,
  parseTraktRatings
} from '../src/main/media-hub/trakt'
import {
  OVERLAP_MS,
  markTraktHistoryPulled,
  pullTraktHistory,
  traktPullKey,
  type TraktPullDeps,
  type TraktPullState
} from '../src/main/media-hub/traktHistoryPull'
import type { ImportedPlay } from '../src/shared/media-hub/types'

// ---------------------------------------------------------------------
// What Trakt's rows mean.
// ---------------------------------------------------------------------
const historyPayload = [
  {
    watched_at: '2019-04-02T21:15:00.000Z',
    type: 'movie',
    movie: { title: 'Dune', year: 2021, ids: { imdb: 'tt1160419', tmdb: 438631 } }
  },
  {
    watched_at: '2024-01-05T03:00:00.000Z',
    type: 'episode',
    episode: { season: 2, number: 7, ids: { imdb: 'tt99999' } },
    show: { title: 'Severance', year: 2022, ids: { imdb: 'tt11280740' } }
  },
  // Specials. Season 0 is a real season and must not become season 1.
  {
    watched_at: '2024-01-06T03:00:00.000Z',
    type: 'episode',
    episode: { season: 0, number: 1 },
    show: { title: 'Severance', ids: { imdb: 'tt11280740' } }
  },
  // Trakt's catalog is wider than this one: a row with no IMDb id has no id
  // this app is keyed by. Skipped and counted, never matched by title — a
  // confident wrong match writes somebody else's viewing into this history.
  {
    watched_at: '2024-02-01T00:00:00.000Z',
    type: 'movie',
    movie: { title: 'Some Obscure Short', ids: { tmdb: 12345 } }
  },
  // A date nothing can sort on is worse than no row: it goes straight into
  // a column every history view and statistic orders by.
  { watched_at: 'sometime', type: 'movie', movie: { title: 'X', ids: { imdb: 'tt5' } } }
]

const parsed = parseTraktHistory(historyPayload)
assert.equal(parsed.rows.length, 3)
assert.equal(parsed.skipped, 2)

// An EPISODE is filed under its SHOW's IMDb id — that is how this app keys
// watch history, and Trakt hands over both halves in the same row.
assert.deepEqual(parsed.rows[1], {
  id: 'tt11280740',
  type: 'series',
  title: 'Severance',
  year: '2022',
  season: 2,
  episode: 7,
  watchedAt: '2024-01-05T03:00:00.000Z'
})
assert.equal(parsed.rows[2].season, 0, 'season 0 is the specials convention, not a missing season')
assert.equal(parsed.rows[0].season, null, 'a film has no coordinates at all')

// Ratings come across on the same 1-10 scale, unrescaled — a rescale is a
// place for an off-by-one to change somebody's opinion.
const ratings = parseTraktRatings([
  { rating: 9, movie: { title: 'Dune', ids: { imdb: 'tt1160419' } } },
  { rating: 7, show: { title: 'Severance', ids: { imdb: 'tt11280740' } } },
  { rating: 11, movie: { title: 'Impossible', ids: { imdb: 'tt7' } } },
  { rating: 8, movie: { title: 'No id', ids: {} } }
])
assert.equal(ratings.rows.length, 2)
assert.equal(ratings.skipped, 2)
assert.deepEqual(
  ratings.rows.map((r) => [r.id, r.score, r.type]),
  [
    ['tt1160419', 9, 'movie'],
    ['tt11280740', 7, 'series']
  ]
)

// ---------------------------------------------------------------------
// What writing them does.
// ---------------------------------------------------------------------
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'r3-trakt-import-')), 'db.sqlite')
const db = createDatabase(file, 'profile-a')

// Something already watched HERE, today, that Trakt also knows about with a
// much older date.
db.markWatched({ id: 'tt1160419', type: 'movie', title: 'Dune' })
const localDate = db.history().find((entry) => entry.id === 'tt1160419')?.watchedAt
assert.ok(localDate)
db.rate('tt1160419', 4)

assert.equal(db.importWatched(parsed.rows), 3)
assert.equal(db.importRatings(ratings.rows), 1, 'the already-rated title keeps its local score')

// The local date wins. An import FILLS GAPS: the row already here is what
// somebody in this app actually saw happen, and the remote copy does not get
// to move it out of their recently-watched.
assert.equal(db.history().find((entry) => entry.id === 'tt1160419')?.watchedAt, localDate)

// Nor does it get to replace an opinion. 4 is what this person said here.
assert.equal(db.ratings().get('tt1160419'), 4)
assert.equal(db.ratings().get('tt11280740'), 7, 'a title with no local score does come across')

// Imported dates are the REAL ones, not today. This is the whole reason the
// import does not go through markWatched.
const plays = db.plays(50)
const severance = plays.find((play) => play.season === 2 && play.episode === 7)
assert.equal(severance?.watchedAt, '2024-01-05T03:00:00.000Z')

// Running it again writes nothing. The honest response to a partial import
// is to run it again, so a second run must not double every play row and
// report the whole library as rewatched.
assert.equal(db.importWatched(parsed.rows), 0)
assert.equal(db.importRatings(ratings.rows), 0)
assert.equal(db.plays(200).length, plays.length)

// A genuine rewatch still counts — it has its own timestamp, which is what
// makes it a different viewing rather than the same one seen twice.
assert.equal(db.importWatched([{ ...parsed.rows[1], watchedAt: '2026-05-05T20:00:00.000Z' }]), 1)

// ---------------------------------------------------------------------
// Whose history it is.
// ---------------------------------------------------------------------
db.setActiveProfile('profile-b')
assert.equal(db.history().length, 0, 'an import belongs to the profile that ran it')
assert.equal(db.ratings().size, 0)

// ---------------------------------------------------------------------
// The pull that follows: what it asks Trakt for, and what it writes.
// ---------------------------------------------------------------------
assert.deepEqual(
  parseTraktActivities({
    all: '2026-10-05T10:00:00.000Z',
    movies: { watched_at: '2026-10-01T00:00:00.000Z', rated_at: 'x' },
    episodes: { watched_at: '2026-10-05T09:00:00.000Z' }
  }),
  { movies: '2026-10-01T00:00:00.000Z', episodes: '2026-10-05T09:00:00.000Z' }
)
assert.deepEqual(parseTraktActivities({}), { movies: null, episodes: null })
// Not an answer at all is a failure, never "nothing changed".
assert.throws(() => parseTraktActivities('busy'))

interface PullHarness {
  db: ReturnType<typeof createDatabase>
  deps: TraktPullDeps
  calls: string[]
  stamps: { movies: string | null; episodes: string | null }
  rows: unknown[]
  account: string
  clock: number
  /** Runs inside history(), before it answers — a profile switch, say. */
  during: (() => void) | null
  fileError: Error | null
  state(): TraktPullState | null
}

function pullHarness(): PullHarness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-trakt-pull-'))
  const pullDb = createDatabase(path.join(dir, 'db.sqlite'), 'profile-a')
  const h: PullHarness = {
    db: pullDb,
    calls: [],
    stamps: { movies: 'm1', episodes: 'e1' },
    rows: [],
    account: 'trakt-1',
    clock: Date.parse('2026-10-05T12:00:00.000Z'),
    during: null,
    fileError: null,
    state: () =>
      pullDb.getCache<TraktPullState>(traktPullKey(pullDb.activeProfile()), {
        allowExpired: true
      }),
    deps: undefined as unknown as TraktPullDeps
  }
  h.deps = {
    db: pullDb,
    account: () => h.account,
    lastActivities: async () => {
      h.calls.push('last_activities')
      return {
        movies: { watched_at: h.stamps.movies },
        episodes: { watched_at: h.stamps.episodes }
      }
    },
    history: async (startAt) => {
      h.calls.push(`history since ${startAt}`)
      h.during?.()
      return { rows: h.rows, truncated: false }
    },
    // The import's filing, faked: an anime series moves under its show.
    file: async (rows: ImportedPlay[]) => {
      h.calls.push('file')
      if (h.fileError) throw h.fileError
      return rows.map((row) =>
        row.id === 'tt0388629' ? { ...row, id: 'kitsu:12', type: 'anime' as const, season: 1 } : row
      )
    },
    backup: () => {
      h.calls.push('backup')
    },
    announce: () => {
      h.calls.push('announce')
    },
    now: () => h.clock,
    log: () => {}
  }
  return h
}

const episodeRow = (show: string, season: number, number: number, at: string) => ({
  watched_at: at,
  type: 'episode',
  episode: { season, number },
  show: { title: show, ids: { imdb: show === 'One Piece' ? 'tt0388629' : 'tt11280740' } }
})

async function pulls(): Promise<void> {
  {
    // Nothing on record: start from now, read nothing. The account's past is
    // the import button's.
    const h = pullHarness()
    const report = await pullTraktHistory(h.deps)
    assert.deepEqual(h.calls, ['last_activities'])
    assert.equal(report.read, false)
    assert.deepEqual(h.state(), {
      account: 'trakt-1',
      stamps: { movies: 'm1', episodes: 'e1' },
      since: '2026-10-05T12:00:00.000Z'
    })

    // Nothing moved at Trakt: one small request, and that is all.
    h.clock += 30 * 60 * 1000
    h.calls.length = 0
    await pullTraktHistory(h.deps)
    assert.deepEqual(h.calls, ['last_activities'])

    // Something was watched elsewhere: history from the last pull, reaching
    // back a few days for a viewing that reached Trakt late.
    h.stamps.episodes = 'e2'
    // Played here earlier and pushed: Trakt hands it back with its own time.
    h.db.markWatched(
      { id: 'tt11280740', type: 'series', title: 'Severance' },
      { season: 1, episode: 1 }
    )
    h.rows = [
      episodeRow('Severance', 1, 1, '2026-10-05T12:10:00.000Z'),
      episodeRow('Severance', 1, 2, '2026-10-05T12:20:00.000Z'),
      episodeRow('One Piece', 1, 5, '2026-10-05T12:25:00.000Z')
    ]
    h.calls.length = 0
    const pulled = await pullTraktHistory(h.deps)
    const since = new Date(Date.parse('2026-10-05T12:00:00.000Z') - OVERLAP_MS).toISOString()
    assert.deepEqual(h.calls, [
      'last_activities',
      `history since ${since}`,
      'file',
      'backup',
      'announce'
    ])
    assert.equal(pulled.plays, 2, 'the echo of the episode played here is not a second play')
    const keys = h.db
      .history()
      .map((row) => `${row.id}:${row.season}:${row.episode}`)
      .sort()
    assert.deepEqual(keys, ['kitsu:12:1:5', 'tt11280740:1:1', 'tt11280740:1:2'])
    assert.equal(
      h.db.plays(50).filter((play) => play.contentId === 'tt11280740' && play.episode === 1).length,
      1
    )
    assert.deepEqual(h.state()?.stamps, { movies: 'm1', episodes: 'e2' })
    assert.equal(h.state()?.since, new Date(h.clock).toISOString())

    // The same rows again under a moved stamp write nothing, and take no
    // backup: there is nothing to back up before.
    h.stamps.movies = 'm2'
    h.calls.length = 0
    assert.equal((await pullTraktHistory(h.deps)).plays, 0)
    assert.equal(h.calls.includes('backup'), false)
  }

  {
    // An import that finished says where the pull carries on from, and
    // read no stamps, so the next pass reads.
    const h = pullHarness()
    markTraktHistoryPulled(h.db, 'profile-a', 'trakt-1', Date.parse('2026-10-04T00:00:00.000Z'))
    await pullTraktHistory(h.deps)
    const since = new Date(Date.parse('2026-10-04T00:00:00.000Z') - OVERLAP_MS).toISOString()
    assert.deepEqual(h.calls.slice(0, 2), ['last_activities', `history since ${since}`])
  }

  {
    // Another account's record is no record: start from now.
    const h = pullHarness()
    markTraktHistoryPulled(h.db, 'profile-a', 'trakt-0', Date.parse('2026-10-04T00:00:00.000Z'))
    await pullTraktHistory(h.deps)
    assert.deepEqual(h.calls, ['last_activities'])
    assert.equal(h.state()?.account, 'trakt-1')
  }

  {
    // A profile switch while history loads: nothing written, nothing moved on.
    const h = pullHarness()
    markTraktHistoryPulled(h.db, 'profile-a', 'trakt-1', h.clock - 1000)
    const before = h.state()
    h.rows = [episodeRow('Severance', 1, 3, '2026-10-05T12:20:00.000Z')]
    h.during = () => h.db.setActiveProfile('profile-b')
    await pullTraktHistory(h.deps)
    h.db.setActiveProfile('profile-a')
    assert.equal(h.db.history().length, 0)
    assert.deepEqual(h.state(), before)
  }

  {
    // Filing refused (the anime catalog is still being organised): the
    // record stays where it was, so the next pass reads the same rows again.
    const h = pullHarness()
    markTraktHistoryPulled(h.db, 'profile-a', 'trakt-1', h.clock - 1000)
    const before = h.state()
    h.rows = [episodeRow('One Piece', 1, 6, '2026-10-05T12:20:00.000Z')]
    h.fileError = new Error('still being organised')
    const report = await pullTraktHistory(h.deps)
    assert.equal(report.error, 'still being organised')
    assert.equal(h.db.history().length, 0)
    assert.deepEqual(h.state(), before)
  }

  {
    // Not connected: nothing asked.
    const h = pullHarness()
    h.account = ''
    await pullTraktHistory(h.deps)
    assert.deepEqual(h.calls, [])
  }
}

void pulls().then(() => console.log('trakt import tests passed'))
