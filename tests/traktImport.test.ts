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
// the last pull on, filing rows where the import files them, never
// writing this device's own pushes back as second plays, and never filing
// back a viewing un-marked here whose removal Trakt has not taken yet. With
// nothing on record for the profile and account, its first pass runs the
// import button's own path once, with those same viewings left out, and
// records nothing when that fails.
//
// Run with: npx tsx tests/traktImport.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { createDatabase } from '../src/main/media-hub/database'
import {
  parseTraktActivities,
  parseTraktHistory,
  parseTraktRatings
} from '../src/main/media-hub/trakt'
import {
  OVERLAP_MS,
  heldViewings,
  markTraktHistoryPulled,
  playsNotHeld,
  pullTraktHistory,
  traktFilingHeldBack,
  traktImportFailuresKey,
  traktImportRetryAfterMs,
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
  /** What the import button's path (faked) finds at Trakt, already filed. */
  importRows: ImportedPlay[]
  /** The ratings the faked import finds at Trakt. */
  importRatings: { id: string; score: number }[]
  importError: Error | null
  /** How long the faked import reads before it answers or fails. */
  importTakesMs: number
  /** The held set the pull handed the import, as the import read it. */
  importHeld: ReadonlySet<string> | null
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
    importRows: [],
    importRatings: [],
    importError: null,
    importTakesMs: 0,
    importHeld: null,
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
    // The import button's path, faked: it reads the held set when it is
    // about to write and leaves those viewings out, as importTraktLibrary
    // does with skipHeld.
    fullImport: async (held) => {
      h.calls.push('import')
      h.clock += h.importTakesMs
      if (h.importError) throw h.importError
      h.importHeld = held()
      return {
        plays: pullDb.importWatched(playsNotHeld(h.importRows, h.importHeld)),
        ratings: pullDb.importRatings(h.importRatings)
      }
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
    announce: (scopes) => {
      h.calls.push(`announce ${scopes.join(' ')}`)
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
    // Nothing on record: the account's past, once, by the import button's
    // path, leaving out what is held here (a film watched here, and an
    // episode whose removal Trakt has not taken); then Trakt's stamps.
    const h = pullHarness()
    h.db.markWatched({ id: 'tt1160419', type: 'movie', title: 'Dune' })
    h.deps.removalsOwed = () => new Set(['tt0000077:1:1'])
    h.importRows = [
      { id: 'tt1160419', type: 'movie', title: 'Dune', watchedAt: '2019-04-02T21:15:00.000Z' },
      { id: 'tt0000066', type: 'movie', title: 'Past', watchedAt: '2020-01-01T00:00:00.000Z' },
      {
        id: 'tt0000077',
        type: 'series',
        title: 'Owed',
        season: 1,
        episode: 1,
        watchedAt: '2020-01-02T00:00:00.000Z'
      }
    ] as ImportedPlay[]
    const report = await pullTraktHistory(h.deps)
    assert.deepEqual(h.calls, ['last_activities', 'import', 'announce history'])
    assert.deepEqual(report, { plays: 1, read: true })
    assert.ok(h.importHeld?.has('tt1160419:movie:movie'), 'the film watched here is held')
    assert.ok(h.importHeld?.has('tt0000077:1:1'), 'the removal still owed is held')
    assert.equal(
      h.db.plays(50).filter((play) => play.contentId === 'tt1160419').length,
      1,
      'the film watched here is not a second play'
    )
    assert.ok(h.db.history().some((row) => row.id === 'tt0000066'))
    assert.ok(!h.db.history().some((row) => row.id === 'tt0000077'))
    delete h.deps.removalsOwed
    assert.deepEqual(h.state(), {
      account: 'trakt-1',
      stamps: { movies: 'm1', episodes: 'e1' },
      since: '2026-10-05T12:00:00.000Z'
    })

    // Nothing moved at Trakt: one small request, and that is all. The
    // import is not run again.
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
    // What it wrote is handed on for the record of what each pass merged
    // (episodeSync.ts's noteArrivals): the new viewings, not the echo.
    const merged: string[] = []
    h.deps.merged = (rows) => {
      for (const row of rows) merged.push(`${row.id}:${row.season}:${row.episode}`)
    }
    const pulled = await pullTraktHistory(h.deps)
    assert.deepEqual(merged.sort(), ['kitsu:12:1:5', 'tt11280740:1:2'])
    const since = new Date(Date.parse('2026-10-05T12:00:00.000Z') - OVERLAP_MS).toISOString()
    assert.deepEqual(h.calls, [
      'last_activities',
      `history since ${since}`,
      'file',
      'backup',
      'announce history'
    ])
    assert.equal(pulled.plays, 2, 'the echo of the episode played here is not a second play')
    const keys = h.db
      .history()
      .filter((row) => row.type !== 'movie')
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
    // An episode un-marked here whose removal Trakt has not taken (failed
    // and owed, or still on its way) is not filed back in from Trakt.
    const h = pullHarness()
    markTraktHistoryPulled(h.db, 'profile-a', 'trakt-1', Date.parse('2026-10-05T11:00:00.000Z'))
    h.rows = [
      episodeRow('Severance', 1, 1, '2026-10-05T10:00:00.000Z'),
      episodeRow('Severance', 1, 2, '2026-10-05T10:30:00.000Z')
    ]
    h.deps.removalsOwed = () => new Set(['tt11280740:1:1'])
    const pulled = await pullTraktHistory(h.deps)
    assert.equal(pulled.plays, 1)
    assert.deepEqual(
      h.db.history().map((row) => `${row.id}:${row.season}:${row.episode}`),
      ['tt11280740:1:2']
    )
  }

  {
    // The first pass brings in ratings and no new viewings (every one is
    // already held here): the screens are still told, about the ratings.
    const h = pullHarness()
    h.db.markWatched({ id: 'tt1160419', type: 'movie', title: 'Dune' })
    h.importRows = [
      { id: 'tt1160419', type: 'movie', title: 'Dune', watchedAt: '2019-04-02T21:15:00.000Z' }
    ] as ImportedPlay[]
    h.importRatings = [{ id: 'tt1160419', score: 8 }]
    const report = await pullTraktHistory(h.deps)
    assert.deepEqual(report, { plays: 0, read: true })
    assert.deepEqual(h.calls, ['last_activities', 'import', 'announce ratings'])

    // Nothing at all written: nothing announced.
    const quiet = pullHarness()
    await pullTraktHistory(quiet.deps)
    assert.deepEqual(quiet.calls, ['last_activities', 'import'])
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
    // Another account's record is no record: that account's past is read
    // once too.
    const h = pullHarness()
    markTraktHistoryPulled(h.db, 'profile-a', 'trakt-0', Date.parse('2026-10-04T00:00:00.000Z'))
    await pullTraktHistory(h.deps)
    assert.deepEqual(h.calls, ['last_activities', 'import'])
    assert.equal(h.state()?.account, 'trakt-1')
  }

  {
    // The first pass's import refused (the anime catalog still being
    // organised): no position recorded, so the next half-hourly pass runs it
    // again.
    const h = pullHarness()
    h.importError = new Error('still being organised')
    const report = await pullTraktHistory(h.deps)
    assert.equal(report.error, 'still being organised')
    assert.equal(h.state(), null)
    h.importError = null
    h.calls.length = 0
    h.clock += traktImportRetryAfterMs(1)
    await pullTraktHistory(h.deps)
    assert.deepEqual(h.calls, ['last_activities', 'import'])
    assert.equal(h.state()?.account, 'trakt-1')
  }

  {
    // An import that keeps failing is not re-read whole on every pass: the
    // catch-up's three-minute passes and the half-hourly job wait for it,
    // until the next half-hourly pass after one failure, six hours after
    // two, a day after three.
    const h = pullHarness()
    h.importError = new Error('Simkl could not be reached')
    const imports = (): number => h.calls.filter((call) => call === 'import').length
    const MIN = 60 * 1000
    await pullTraktHistory(h.deps)
    assert.equal(imports(), 1)
    h.clock += 3 * MIN
    const waiting = await pullTraktHistory(h.deps)
    assert.deepEqual(waiting, { plays: 0, read: false }, 'a pass inside the wait asks nothing big')
    assert.equal(imports(), 1)
    h.clock += 30 * MIN
    await pullTraktHistory(h.deps)
    assert.equal(imports(), 2, 'tried again after half an hour')
    h.clock += 5 * 60 * MIN
    await pullTraktHistory(h.deps)
    assert.equal(imports(), 2, 'six hours after the second failure, not five')
    h.clock += 60 * MIN
    await pullTraktHistory(h.deps)
    assert.equal(imports(), 3)
    h.clock += 23 * 60 * MIN
    await pullTraktHistory(h.deps)
    assert.equal(imports(), 3, 'a day after the third')
    h.clock += 60 * MIN
    h.importError = null
    await pullTraktHistory(h.deps)
    assert.equal(imports(), 4)
    assert.equal(h.state()?.account, 'trakt-1', 'the pass that succeeds records its position')
    // Another account's failures do not hold this one back.
    const other = pullHarness()
    other.db.putCache(
      traktImportFailuresKey('profile-a'),
      { account: 'trakt-0', failures: 5, at: other.clock },
      24 * 60 * MIN
    )
    await pullTraktHistory(other.deps)
    assert.deepEqual(other.calls, ['last_activities', 'import'])

    // The wait runs from when the failed pass began, not from when its long
    // read gave up: the job's next pass, thirty minutes after the last one
    // began, tries again even though the import read for six minutes first.
    const slow = pullHarness()
    slow.importError = new Error('still being organised')
    slow.importTakesMs = 6 * MIN
    const began = slow.clock
    await pullTraktHistory(slow.deps)
    slow.importError = null
    slow.clock = began + 30 * MIN
    await pullTraktHistory(slow.deps)
    assert.equal(
      slow.calls.filter((call) => call === 'import').length,
      2,
      'the next half-hourly pass runs the import again'
    )
    assert.equal(slow.state()?.account, 'trakt-1')
  }

  {
    // The real wiring: the first pass runs the Import button's function,
    // which leaves out the held viewings before its backup and its write.
    const client = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'main', 'media-hub', 'traktClient.ts'),
      'utf8'
    )
    assert.match(client, /fullImport: \(held\) => importTraktLibrary\(\{ skipHeld: held \}\)/)
    // What moved is what the screens are told: ratings as well as history.
    assert.match(client, /notifyLibraryChanged\('trakt-pull', \.\.\.scopes\)/)
    const body = client.slice(client.indexOf('export async function importTraktLibrary('))
    const filter = body.indexOf('playsNotHeld(filedPlays, options.skipHeld())')
    assert.ok(filter > 0, 'the import filters held viewings when asked')
    assert.ok(filter < body.indexOf("backupBeforeRewrite('trakt-import')"))
    assert.ok(filter < body.indexOf('db.importWatched(remappedPlays)'))
    // The Import button leaves out what is held here too, the same set the
    // pull's first pass hands it: played here (and so echoed back by Trakt
    // with Trakt's own time), or un-marked with the removal still owed.
    const button = client.slice(client.indexOf('MEDIA_HUB_CHANNELS.traktImport,'))
    assert.match(
      button.slice(0, 400),
      /importTraktLibrary\(\{\s*skipHeld: \(\) => heldViewings\(getDatabase\(\)\.history\(\), removalsHeldBack\('trakt'\)\)/
    )
    assert.doesNotMatch(client, /importTraktLibrary\(\)\)/)
    const held = heldViewings(
      [
        { id: 'tt1', season: null, episode: null },
        { id: 'tt2', season: 1, episode: 4 }
      ],
      ['tt2:1:5']
    )
    assert.deepEqual([...held].sort(), ['tt1:movie:movie', 'tt2:1:4', 'tt2:1:5'])
    // An episode played here and echoed back by Trakt is not a second play.
    const echoed = [
      { id: 'tt2', type: 'series', title: 'B', season: 1, episode: 4, watchedAt: '2026-10-05' },
      { id: 'tt2', type: 'series', title: 'B', season: 1, episode: 6, watchedAt: '2026-10-05' }
    ] as ImportedPlay[]
    assert.deepEqual(
      playsNotHeld(echoed, held).map((row) => row.episode),
      [6]
    )
  }

  {
    // When series rows may be filed. A lookup nobody answered while a Simkl
    // Client ID is set may be anime: refused, so the import writes nothing
    // and the pull records nothing (the "Filing refused" case below), and
    // the next pass asks again. With no Client ID there is nobody to wait
    // for: filed as they come.
    const ready = { resolved: 0, unanswered: 0, groupingReady: true, resolverConfigured: true }
    assert.equal(traktFilingHeldBack(ready), null)
    assert.match(String(traktFilingHeldBack({ ...ready, unanswered: 2 })), /Simkl could not/)
    assert.equal(traktFilingHeldBack({ ...ready, unanswered: 2, resolverConfigured: false }), null)
    // The grouping rule as before: only once something resolved to anime.
    assert.equal(traktFilingHeldBack({ ...ready, groupingReady: false }), null)
    assert.match(
      String(traktFilingHeldBack({ ...ready, resolved: 1, groupingReady: false })),
      /still being organised/
    )
    // The import's lookups keep whether anyone answered, and refuse on it.
    const client = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'main', 'media-hub', 'traktClient.ts'),
      'utf8'
    )
    const targets = client.slice(client.indexOf('async function imdbToAnimeTargets('))
    assert.match(targets, /kitsuIdLookup\('imdb', imdbId, 'background'\)/)
    assert.match(targets, /if \(heldBack\) throw new Error\(heldBack\)/)
  }

  {
    // The rule both share.
    const rows = [
      { id: 'tt1', type: 'movie', title: 'A', watchedAt: '2020-01-01T00:00:00.000Z' },
      { id: 'tt2', type: 'series', title: 'B', season: 0, episode: 3, watchedAt: '2020-01-01' }
    ] as ImportedPlay[]
    assert.deepEqual(
      playsNotHeld(rows, new Set(['tt1:movie:movie'])).map((row) => row.id),
      ['tt2']
    )
    assert.deepEqual(
      playsNotHeld(rows, new Set(['tt2:0:3'])).map((row) => row.id),
      ['tt1']
    )
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

// A rating sent to Trakt that does not get through is kept and sent again,
// as a watched push is (traktClient.ts's retryTraktRatings). Run against the
// real client with Trakt faked at fetch; traktClient reaches Electron, so
// 'electron' is the headless stand-in, as tests/accountMarks.test.ts loads it.
async function ratingRetries(): Promise<void> {
  process.env.R3_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-trakt-ratings-'))
  process.env.R3_ELECTRON_SHIM = '1'
  const shim = pathToFileURL(
    path.join(__dirname, '..', 'src', 'headless', 'electronShim', 'index.ts')
  )
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'electron') return { url: shim.href, shortCircuit: true }
      return next(specifier, context)
    }
  })
  const store = await import('../src/main/media-hub/settingsStore')
  const { setDatabase } = await import('../src/main/media-hub/dbState')
  const client = await import('../src/main/media-hub/traktClient')
  const db = createDatabase(path.join(process.env.R3_USER_DATA, 'ratings.sqlite'), 'profile-a')
  setDatabase(db)
  const plain = (value: string): string => `plain:${Buffer.from(value, 'utf8').toString('base64')}`
  store.writeSettings({ traktClientId: 'tid', traktAccessToken: plain('trakt-token') })
  const mark = store.traktAccountMark()

  const sent: string[] = []
  let status = 503
  /** Statuses for the next requests, in order, before `status` applies. */
  const queued: number[] = []
  /** Run once while the next request is out. */
  let whileSending: (() => void) | null = null
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    sent.push(`${url.pathname} ${String(init?.body ?? '')}`)
    const during = whileSending
    whileSending = null
    during?.()
    const answer = queued.shift() ?? status
    return new Response(answer < 300 ? '{}' : '', { status: answer })
  }) as typeof fetch
  const owed = (): ReturnType<typeof client.readOwedTraktRatings> =>
    client.readOwedTraktRatings(db, 'profile-a', mark)
  const dune = { id: 'tt1160419', type: 'movie' as const, title: 'Dune' }

  // Trakt down: the rating is owed, to this account.
  await client.pushTraktRating(dune, 8)
  assert.equal(sent.length, 1)
  assert.equal(owed()[dune.id]?.score, 8)
  assert.equal(owed()[dune.id]?.attempts, 0)
  // Still down at the next pass: no try counted for an outage.
  await client.retryTraktRatings()
  assert.equal(owed()[dune.id]?.attempts, 0)
  // Up again: sent, and no longer owed.
  status = 201
  sent.length = 0
  await client.retryTraktRatings()
  assert.equal(sent.length, 1)
  assert.match(sent[0], /^\/sync\/ratings /)
  assert.match(sent[0], /"rating":8/)
  assert.deepEqual(owed(), {})

  // A refusal counts a try; ten and it is let go.
  status = 422
  await client.pushTraktRating(dune, 6)
  for (let i = 0; i < 9; i += 1) await client.retryTraktRatings()
  assert.equal(owed()[dune.id]?.attempts, 9)
  await client.retryTraktRatings()
  assert.deepEqual(owed(), {})

  // A cleared rating is owed as the removal it is.
  status = 503
  await client.pushTraktRating(dune, 0)
  status = 201
  sent.length = 0
  await client.retryTraktRatings()
  assert.match(sent[0], /^\/sync\/ratings\/remove /)
  assert.deepEqual(owed(), {})

  // Two ratings given in a row reach Trakt in that order, the newer one
  // last. The older one, held up by a 429 and then failing, is not kept over
  // the newer one that got through: retried, it would put the older score
  // back at Trakt.
  const scores = (): (string | undefined)[] => sent.map((line) => /"rating":(\d+)/.exec(line)?.[1])
  sent.length = 0
  queued.push(429, 503, 201)
  await Promise.all([client.pushTraktRating(dune, 3), client.pushTraktRating(dune, 4)])
  assert.deepEqual(scores(), ['3', '3', '4'])
  assert.deepEqual(owed(), {}, 'the older rating that failed is not owed over the newer one')

  // An owed rating whose title has been rated again since, and that rating
  // got through, is not sent again after it.
  status = 503
  await client.pushTraktRating(dune, 2)
  assert.equal(owed()[dune.id]?.score, 2)
  status = 201
  sent.length = 0
  const fresh = client.pushTraktRating(dune, 7)
  await client.retryTraktRatings()
  await fresh
  assert.deepEqual(scores(), ['7'], 'the old score is not sent after the new one')
  assert.deepEqual(owed(), {})

  // The account switched while the retry waited for the title's chain:
  // nothing goes to the account signed in now, and the rating stays owed to
  // its own.
  const queue = await import('../src/main/media-hub/titlePushQueue')
  status = 503
  await client.pushTraktRating(dune, 5)
  assert.equal(owed()[dune.id]?.score, 5)
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = () => resolve()
  })
  const busy = queue.titlePushQueue.run(queue.titlePushKey(dune), () => gate)
  const retrying = client.retryTraktRatings()
  store.writeSettings({ traktClientId: 'tid', traktAccessToken: plain('someone-else') })
  status = 201
  sent.length = 0
  release()
  await busy
  await retrying
  assert.deepEqual(sent, [], 'a rating owed to one account is not sent to the next')
  assert.equal(owed()[dune.id]?.score, 5, 'and it is still owed to the account it was given under')
  store.writeSettings({ traktClientId: 'tid', traktAccessToken: plain('trakt-token') })

  // The account switched while the retry's send was out, and the account
  // signed in now owes a rating of its own: the retry's write-back leaves
  // the record alone rather than erase that.
  const interstellar = { id: 'tt0816692', type: 'movie' as const, title: 'Interstellar' }
  let otherMark = ''
  whileSending = () => {
    store.writeSettings({ traktClientId: 'tid', traktAccessToken: plain('someone-else') })
    otherMark = store.traktAccountMark()
    const stored = db.getCache<Record<string, unknown>>(client.owedTraktRatingsKey('profile-a'), {
      allowExpired: true
    })
    db.putCache(
      client.owedTraktRatingsKey('profile-a'),
      {
        ...stored,
        [interstellar.id]: {
          item: interstellar,
          score: 9,
          at: Date.now(),
          attempts: 0,
          mark: otherMark
        }
      },
      60_000
    )
  }
  status = 201
  sent.length = 0
  await client.retryTraktRatings()
  assert.equal(sent.length, 1)
  assert.equal(
    client.readOwedTraktRatings(db, 'profile-a', otherMark)[interstellar.id]?.score,
    9,
    'what the account signed in now owes is kept'
  )
  store.writeSettings({ traktClientId: 'tid', traktAccessToken: plain('trakt-token') })

  // Another account's owed rating is never sent.
  status = 503
  await client.pushTraktRating(dune, 7)
  store.writeSettings({ traktClientId: 'tid', traktAccessToken: plain('someone-else') })
  status = 201
  sent.length = 0
  await client.retryTraktRatings()
  assert.deepEqual(sent, [])

  // Last write wins: a push that settles late for an older rating changes
  // nothing, and a success clears only what it is not older than.
  const base = { item: dune, mark: 'm', error: 'down' }
  const newer = client.recordTraktRating({}, { ...base, score: 9, at: 2000 })
  assert.equal(client.recordTraktRating(newer, { ...base, score: 4, at: 1000 }), newer)
  assert.equal(
    client.recordTraktRating(newer, { item: dune, mark: 'm', score: 4, at: 1000 }),
    newer,
    'an older success does not clear a newer rating that is owed'
  )
  assert.deepEqual(
    client.recordTraktRating(newer, { item: dune, mark: 'm', score: 9, at: 3000 }),
    {}
  )
  console.log('trakt rating retry tests passed')
}

void pulls()
  .then(() => console.log('trakt import tests passed'))
  .then(ratingRetries)
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
