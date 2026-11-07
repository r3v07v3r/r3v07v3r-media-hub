// What the app sends to the tracking services on its own, and what it keeps
// when a send fails.
//
// Scrobbles are opt-in. A finished episode reaches Simkl and Trakt as a
// history add at 80% whatever the setting says; scrobbles are a start, a stop
// and a pause and resume pair per pause on top of that, per service, and
// Simkl counts every one against an allowance of 500 requests a day that a
// linked phone shares. So the default, for every install that has never been
// asked, is off (preferences.ts's scrobblingEnabled, which the scrobble
// handler in tracking.ts reads before sending anything).
//
// A history push that fails is kept (historyRetry.ts). Marks, un-marks,
// seasons and whole titles used to be logged and dropped when a service was
// unreachable; now each failure is written down, per service, title and
// episode, in the same durable store and on the same terms as the plan
// changes a service refused: retried with each sync, given up on after ten
// tries, never sent to a different account, and replaced by any later push
// for the same episode. Pinned against a real temporary database, because
// "survives a restart" is a property of the store. A removal owed to a
// service, or still on its way to it, is what the Simkl catch-up and the
// Trakt pull must count as held, or they would take the viewing back in.
//
// The last part drives the real handlers (tracking.ts) through the headless
// Electron stand-in, with Simkl faked at fetch: a later anime season marked
// before the catalog is grouped is kept owed, and a retry dates what it adds.
//
// Run with: npx tsx tests/trackingPushes.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { createDatabase } from '../src/main/media-hub/database'
import {
  FILM_WATCHED_KEY,
  HISTORY_PENDING_MAX_ATTEMPTS,
  HISTORY_PENDING_TTL_MS,
  historyPendingKey,
  historyRetryBatches,
  readHistoryPending,
  recordHistoryPush,
  holdRemovalsOnTheWay,
  oneRunAtATime,
  removalsInFlight,
  removalsOwed,
  retryFailure,
  settleHistoryRetry,
  splitHistoryRetryBatch,
  watchedAtByTitle,
  writeHistoryPending,
  type HistoryPushOutcome,
  type PendingHistoryPushes
} from '../src/main/media-hub/historyRetry'
import { withWatchedAt } from '../src/main/media-hub/episodeSync'
import {
  logoutSettings,
  scrobblingEnabled,
  upgradeScrobbleDefault
} from '../src/main/media-hub/preferences'
import {
  animeRowAwaitsGrouping,
  historyPayload,
  titleHistoryPayload as simklTitleHistoryPayload,
  withMovieWatchedAt,
  type SimklHistoryPayload
} from '../src/main/media-hub/simkl'
import { bySeason } from '../src/main/media-hub/titleStatusRules'

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

// --- scrobbles are opt-in ---------------------------------------------------

check('a settings file that has never been asked sends no scrobbles', () => {
  assert.equal(scrobblingEnabled({}), false)
  assert.equal(scrobblingEnabled(), false)
})

check('only an explicit yes turns them on', () => {
  assert.equal(scrobblingEnabled({ scrobbleEnabled: true }), true)
  assert.equal(scrobblingEnabled({ scrobbleEnabled: false }), false)
  // A hand-edited file is not a yes.
  assert.equal(scrobblingEnabled({ scrobbleEnabled: 'true' }), false)
  assert.equal(scrobblingEnabled({ scrobbleEnabled: 1 }), false)
})

// --- the one-time scrobble upgrade -----------------------------------------

check('an install with a service connected and no stored choice is switched on once', () => {
  const upgraded = upgradeScrobbleDefault({ theme: 'dark' }, true)
  assert.deepEqual(upgraded, {
    theme: 'dark',
    scrobbleDefaultMigrated: true,
    scrobbleEnabled: true
  })
  assert.equal(scrobblingEnabled(upgraded!), true)
})

check('a fresh install, with nothing connected, only gets the marker and stays off', () => {
  const upgraded = upgradeScrobbleDefault({}, false)
  assert.deepEqual(upgraded, { scrobbleDefaultMigrated: true })
  assert.equal(scrobblingEnabled(upgraded!), false)
})

check('a stored choice is kept either way', () => {
  assert.deepEqual(upgradeScrobbleDefault({ scrobbleEnabled: false }, true), {
    scrobbleEnabled: false,
    scrobbleDefaultMigrated: true
  })
  assert.deepEqual(upgradeScrobbleDefault({ scrobbleEnabled: true }, false), {
    scrobbleEnabled: true,
    scrobbleDefaultMigrated: true
  })
})

check(
  'it runs once: switched off afterwards stays off, connecting later does not turn it on',
  () => {
    const first = upgradeScrobbleDefault({}, true)!
    assert.equal(upgradeScrobbleDefault(first, true), null)
    assert.equal(upgradeScrobbleDefault({ ...first, scrobbleEnabled: false }, true), null)
    const fresh = upgradeScrobbleDefault({}, false)!
    assert.equal(upgradeScrobbleDefault(fresh, true), null)
  }
)

check('the marker survives a sign-out', () => {
  assert.equal(logoutSettings({ scrobbleDefaultMigrated: true }).scrobbleDefaultMigrated, true)
  assert.equal('scrobbleDefaultMigrated' in logoutSettings({}), false)
})

// --- history pushes that failed ---------------------------------------------

const PROFILE = 'profile-a'
const MARKS = { simkl: 'simkl-1', trakt: 'trakt-1', mal: 'mal-1' }
const SHOW = { id: 'tt0000001', type: 'series' as const, title: 'Severance', year: '2022' }
const FILM = { id: 'tt0000002', type: 'movie' as const, title: 'Dune' }
const T0 = Date.parse('2026-10-05T12:00:00Z')

function outcome(over: Partial<HistoryPushOutcome> = {}): HistoryPushOutcome {
  return {
    service: 'simkl',
    mark: MARKS.simkl,
    item: SHOW,
    rows: [{ season: 1, episode: 2 }],
    action: 'add',
    error: 'Request failed (503)',
    ...over
  }
}

function databaseFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-history-retry-'))
  return path.join(dir, 'test.sqlite')
}

check('a failed push is kept per service, title and episode', () => {
  const pending = recordHistoryPush(
    {},
    outcome({
      rows: [
        { season: 1, episode: 2 },
        { season: 1, episode: 3 }
      ]
    }),
    T0
  )
  assert.deepEqual(Object.keys(pending).sort(), ['simkl|tt0000001|1|2', 'simkl|tt0000001|1|3'])
  assert.equal(pending['simkl|tt0000001|1|2'].attempts, 0)
  assert.equal(pending['simkl|tt0000001|1|2'].mark, 'simkl-1')
})

check('the last push for an episode wins, whichever way it went', () => {
  const failedAdd = recordHistoryPush({}, outcome(), T0)
  // Un-marked a moment later, and that failed too: the removal is what is owed.
  const failedRemove = recordHistoryPush(failedAdd, outcome({ action: 'remove' }), T0 + 1)
  assert.equal(Object.keys(failedRemove).length, 1)
  assert.equal(failedRemove['simkl|tt0000001|1|2'].action, 'remove')
  // Marked again, and this one got through: nothing is owed any more.
  const sent = recordHistoryPush(failedRemove, outcome({ error: undefined }), T0 + 2)
  assert.deepEqual(sent, {})
})

check('a MyAnimeList clear back to plan is retried as one', () => {
  // The whole-title "not watched" of a planned anime sends plan_to_watch
  // and each season's total. A retry with only the seasons would plan
  // nothing.
  let pending = recordHistoryPush(
    {},
    outcome({
      service: 'mal',
      mark: MARKS.mal,
      item: { id: 'kitsu:1', type: 'anime', title: 'Frieren', totalEpisodes: 28 },
      rows: [
        { season: 1, episode: 1 },
        { season: 2, episode: 1 }
      ],
      action: 'remove',
      malStatus: 'plan_to_watch',
      seasonTotals: new Map([
        [1, 28],
        [2, 12]
      ])
    }),
    T0
  )
  assert.equal(pending['mal|kitsu:1|1'].malStatus, 'plan_to_watch')
  assert.equal(pending['mal|kitsu:1|2'].seasonTotal, 12)
  // A later episode push for season 2 replaces its entry, status and all.
  pending = recordHistoryPush(
    pending,
    outcome({
      service: 'mal',
      mark: MARKS.mal,
      item: { id: 'kitsu:1', type: 'anime', title: 'Frieren' },
      rows: [{ season: 2, episode: 3 }]
    }),
    T0 + 1
  )
  const { batches } = historyRetryBatches(pending, new Set())
  assert.equal(batches.length, 2, 'seasons with and without a status are sent apart')
  const planned = batches.find((batch) => batch.malStatus === 'plan_to_watch')
  assert.deepEqual(
    planned?.rows.map((row) => row.season),
    [1]
  )
  assert.deepEqual([...(planned?.seasonTotals ?? [])], [[1, 28]])
  assert.equal(planned?.item.totalEpisodes, 28)
  const plain = batches.find((batch) => !batch.malStatus)
  assert.deepEqual(
    plain?.rows.map((row) => row.season),
    [2]
  )
  assert.equal(plain?.seasonTotals, undefined)
})

check('a push that got through clears only what it covered', () => {
  const pending = recordHistoryPush({}, outcome(), T0)
  const trakt = recordHistoryPush(pending, outcome({ service: 'trakt', mark: MARKS.trakt }), T0)
  const cleared = recordHistoryPush(trakt, outcome({ error: undefined }), T0 + 1)
  assert.deepEqual(Object.keys(cleared), ['trakt|tt0000001|1|2'])
})

check('MyAnimeList is owed a recount per season, not per episode', () => {
  const pending = recordHistoryPush(
    {},
    outcome({
      service: 'mal',
      mark: MARKS.mal,
      item: { id: 'kitsu:1', type: 'anime', title: 'Frieren' },
      rows: [
        { season: 1, episode: 4 },
        { season: 1, episode: 5 },
        { season: 2, episode: 1 }
      ]
    }),
    T0
  )
  assert.deepEqual(Object.keys(pending).sort(), ['mal|kitsu:1|1', 'mal|kitsu:1|2'])
})

check('kept across a restart, and never read for another account', () => {
  const file = databaseFile()
  const before = createDatabase(file, PROFILE)
  writeHistoryPending(before, PROFILE, recordHistoryPush({}, outcome(), T0))
  before.close()
  const db = createDatabase(file, PROFILE)
  assert.equal(Object.keys(readHistoryPending(db, PROFILE, MARKS)).length, 1)
  // Signed in to a different Simkl account: the entry is somebody else's.
  assert.deepEqual(readHistoryPending(db, PROFILE, { ...MARKS, simkl: 'simkl-2' }), {})
  // And another profile has its own record.
  assert.deepEqual(readHistoryPending(db, 'profile-b', MARKS), {})
  assert.ok(db.getCache(historyPendingKey(PROFILE), { allowExpired: true }))
  db.close()
})

check('a retry sends one request per service, title and direction', () => {
  let pending: PendingHistoryPushes = recordHistoryPush(
    {},
    outcome({
      rows: [
        { season: 1, episode: 2 },
        { season: 1, episode: 3 }
      ]
    }),
    T0
  )
  pending = recordHistoryPush(
    pending,
    outcome({ item: FILM, rows: [{ season: null, episode: null }] }),
    T0
  )
  const held = new Set(['tt0000001:1:2', 'tt0000001:1:3', 'tt0000002:movie:movie'])
  const { batches, dropped } = historyRetryBatches(pending, held)
  assert.deepEqual(dropped, [])
  assert.equal(batches.length, 2)
  const show = batches.find((batch) => batch.item.id === SHOW.id)
  assert.deepEqual(show?.rows, [
    { season: 1, episode: 2 },
    { season: 1, episode: 3 }
  ])
})

check('an owed change local has since moved away from is dropped, not replayed', () => {
  let pending = recordHistoryPush({}, outcome(), T0)
  pending = recordHistoryPush(
    pending,
    outcome({ item: FILM, rows: [{ season: null, episode: null }], action: 'remove' }),
    T0
  )
  // The episode is no longer watched here; the film is watched again.
  const { batches, dropped } = historyRetryBatches(pending, new Set(['tt0000002:movie:movie']))
  assert.deepEqual(batches, [])
  assert.deepEqual(dropped.sort(), ['simkl|tt0000001|1|2', 'simkl|tt0000002|movie|movie'])
})

check('a retry that is refused counts an attempt, and ten are the limit', () => {
  let pending = recordHistoryPush({}, outcome(), T0)
  const [batch] = historyRetryBatches(pending, new Set(['tt0000001:1:2'])).batches
  for (let tries = 1; tries < HISTORY_PENDING_MAX_ATTEMPTS; tries++) {
    const settled = settleHistoryRetry(pending, batch, 'Request failed (400)')
    assert.equal(settled.abandoned.length, 0)
    pending = settled.pending
    assert.equal(pending['simkl|tt0000001|1|2'].attempts, tries)
  }
  const last = settleHistoryRetry(pending, batch, 'Request failed (400)')
  assert.deepEqual(last.pending, {})
  assert.equal(last.abandoned.length, 1)
  assert.equal(last.abandoned[0].lastError, 'Request failed (400)')
})

check('a retry that never reached the service costs no attempt', () => {
  // Offline or timed out: the service said nothing about the change. A
  // machine left awake and offline must not spend every owed push's tries.
  const pending = recordHistoryPush({}, outcome(), T0)
  const [batch] = historyRetryBatches(pending, new Set(['tt0000001:1:2'])).batches
  const settled = settleHistoryRetry(pending, batch, 'fetch failed', {
    counted: false,
    now: T0 + 60_000
  })
  assert.equal(settled.pending['simkl|tt0000001|1|2'].attempts, 0)
  assert.equal(settled.pending['simkl|tt0000001|1|2'].lastError, 'fetch failed')
  assert.equal(settled.abandoned.length, 0)
  // An outage that outlasts the record lets the entry go all the same.
  const late = settleHistoryRetry(pending, batch, 'fetch failed', {
    counted: false,
    now: T0 + HISTORY_PENDING_TTL_MS
  })
  assert.deepEqual(late.pending, {})
  assert.equal(late.abandoned.length, 1)
})

check('which failures stop a service for the rest of the pass, and which cost a try', () => {
  // No answer, a 429 that outlasted its retry, or a 5xx: the service is
  // not taking requests, and the rest of its batches wait for the next pass.
  // None of them is about the change, so none costs a try: a spent Simkl
  // allowance or an afternoon's outage would otherwise use up all ten
  // before the service was back. They still go at the 30-day cap.
  assert.deepEqual(retryFailure(undefined), { counts: false, stopsService: true })
  assert.deepEqual(retryFailure(503), { counts: false, stopsService: true })
  assert.deepEqual(retryFailure(500), { counts: false, stopsService: true })
  assert.deepEqual(retryFailure(429), { counts: false, stopsService: true })
  // A 4xx is a refusal of that one request: it costs a try, and the next
  // batch is still worth sending.
  assert.deepEqual(retryFailure(404), { counts: true, stopsService: false })
  assert.deepEqual(retryFailure(401), { counts: true, stopsService: false })
  assert.deepEqual(retryFailure(400), { counts: true, stopsService: false })
})

check('a day of 429s does not use up an owed push', () => {
  // Every half-hourly pass for a day, each answered 429: settled the way
  // runHistoryRetry settles it, the entry is still owed, with no try spent.
  let pending = recordHistoryPush({}, outcome(), T0)
  const [batch] = historyRetryBatches(pending, new Set(['tt0000001:1:2'])).batches
  for (let n = 1; n <= 48; n++) {
    const settled = settleHistoryRetry(pending, batch, 'Request failed (429)', {
      counted: retryFailure(429).counts,
      now: T0 + n * 30 * 60 * 1000
    })
    assert.equal(settled.abandoned.length, 0)
    pending = settled.pending
  }
  assert.equal(pending['simkl|tt0000001|1|2'].attempts, 0)
})

check('a failure that costs no try sends the entry to the back of the queue', () => {
  // Batches go out in record order, and a 5xx stops the service for the
  // pass. Kept in place, one body a service always answers 5xx would go
  // first on every pass, for thirty days, and hold up everything behind it.
  let pending = recordHistoryPush({}, outcome(), T0)
  pending = recordHistoryPush(
    pending,
    outcome({ item: FILM, rows: [{ season: null, episode: null }] }),
    T0
  )
  const held = new Set(['tt0000001:1:2', 'tt0000002:movie:movie'])
  const order = (owed: PendingHistoryPushes): string[] =>
    historyRetryBatches(owed, held).batches.map((batch) => batch.item.id)
  assert.deepEqual(order(pending), [SHOW.id, FILM.id])
  const [first] = historyRetryBatches(pending, held).batches
  const settled = settleHistoryRetry(pending, first, 'Request failed (503)', {
    counted: retryFailure(503).counts,
    now: T0 + 1
  })
  assert.deepEqual(order(settled.pending), [FILM.id, SHOW.id])
  assert.equal(settled.pending['simkl|tt0000001|1|2'].attempts, 0)
  assert.equal(settled.pending['simkl|tt0000001|1|2'].lastError, 'Request failed (503)')
})

check('a retried add carries the time each episode was watched here', () => {
  // As runHistoryRetry builds it: the dates from the same history read the
  // batches are checked against, applied as sendHistoryRetry applies them.
  const watched = '2026-10-01T20:15:00.000Z'
  const history = [
    { id: SHOW.id, season: 1, episode: 2, watchedAt: watched },
    { id: SHOW.id, season: 1, episode: 3, watchedAt: '' },
    { id: FILM.id, season: null, episode: null, watchedAt: watched }
  ]
  const dates = watchedAtByTitle(history)
  assert.deepEqual([...dates.keys()], [SHOW.id, FILM.id])
  // A film's time is kept under FILM_WATCHED_KEY, its row having no season
  // or episode, and dates the film's body at Simkl.
  assert.deepEqual([...(dates.get(FILM.id) ?? [])], [[FILM_WATCHED_KEY, watched]])
  const film = historyPayload({ ...FILM, year: '' }, {})
  assert.equal(
    withMovieWatchedAt(film, dates.get(FILM.id)?.get(FILM_WATCHED_KEY)).movies?.[0].watched_at,
    watched
  )
  // No time here, or one that does not parse: the body goes as it was.
  assert.deepEqual(withMovieWatchedAt(film, undefined), film)
  assert.deepEqual(withMovieWatchedAt(film, 'not a date'), film)
  const pending = recordHistoryPush(
    {},
    outcome({
      rows: [
        { season: 1, episode: 2 },
        { season: 1, episode: 3 }
      ]
    }),
    T0
  )
  const [batch] = historyRetryBatches(pending, new Set(['tt0000001:1:2', 'tt0000001:1:3'])).batches
  const seasons = bySeason(
    batch.rows.map((row) => ({ season: row.season!, episode: row.episode! }))
  )
  const body = withWatchedAt(
    simklTitleHistoryPayload({ ...batch.item, year: batch.item.year ?? '' }, seasons),
    dates.get(SHOW.id) ?? new Map()
  )
  assert.deepEqual(body.shows?.[0].seasons, [
    { number: 1, episodes: [{ number: 2, watched_at: watched }, { number: 3 }] }
  ])
})

check('a later anime season waiting for grouping stays queued while the rest is sent', () => {
  // runHistoryRetry's split of a Simkl anime batch before the catalog is
  // grouped: season 2 is held as a free try, season 1 goes and is cleared.
  // Sent whole, season 2 would be left out of the body and cleared with it.
  const anime = { id: 'kitsu:100', type: 'anime' as const, title: 'Bleach' }
  const pending = recordHistoryPush(
    {},
    outcome({
      item: anime,
      rows: [
        { season: 1, episode: 3 },
        { season: 2, episode: 1 }
      ]
    }),
    T0
  )
  const [batch] = historyRetryBatches(pending, new Set(['kitsu:100:1:3', 'kitsu:100:2:1'])).batches
  const { picked: waiting, rest: ready } = splitHistoryRetryBatch(batch, (row) =>
    animeRowAwaitsGrouping(anime, row, undefined)
  )
  assert.deepEqual(waiting?.rows, [{ season: 2, episode: 1 }])
  assert.deepEqual(
    waiting?.entries.map((entry) => entry.key),
    ['simkl|kitsu:100|2|1']
  )
  assert.deepEqual(ready?.rows, [{ season: 1, episode: 3 }])
  let next = settleHistoryRetry(pending, waiting!, 'waiting', { counted: false, now: T0 + 1 })
  next = settleHistoryRetry(next.pending, ready!, undefined)
  assert.deepEqual(Object.keys(next.pending), ['simkl|kitsu:100|2|1'])
  assert.equal(next.pending['simkl|kitsu:100|2|1'].attempts, 0)
  // Nothing to wait for: the whole batch is the rest.
  const whole = splitHistoryRetryBatch(batch, () => false)
  assert.equal(whole.picked, null)
  assert.deepEqual(whole.rest?.entries, batch.entries)
})

check('a retry that gets through, or cannot be expressed, clears its entries', () => {
  const pending = recordHistoryPush({}, outcome(), T0)
  const [batch] = historyRetryBatches(pending, new Set(['tt0000001:1:2'])).batches
  assert.deepEqual(settleHistoryRetry(pending, batch, undefined).pending, {})
  assert.deepEqual(settleHistoryRetry(pending, batch, null).pending, {})
})

check('a push made while the retry was out is not overwritten by its outcome', () => {
  const pending = recordHistoryPush({}, outcome(), T0)
  const [batch] = historyRetryBatches(pending, new Set(['tt0000001:1:2'])).batches
  // Un-marked while the retried add was in flight, and that failed.
  const newer = recordHistoryPush(pending, outcome({ action: 'remove' }), T0 + 5)
  const settled = settleHistoryRetry(newer, batch, undefined)
  assert.equal(settled.pending['simkl|tt0000001|1|2'].action, 'remove')
})

check('removals owed to a service are what a read from it must not take back in', () => {
  let pending = recordHistoryPush({}, outcome({ action: 'remove' }), T0)
  pending = recordHistoryPush(
    pending,
    outcome({
      service: 'trakt',
      mark: MARKS.trakt,
      item: FILM,
      rows: [{ season: null, episode: null }],
      action: 'remove'
    }),
    T0
  )
  pending = recordHistoryPush(
    pending,
    outcome({ item: FILM, rows: [{ season: null, episode: null }] }),
    T0
  )
  // Simkl's owed removal is the episode; the film's removal is owed to
  // Trakt (the Simkl add for it is not a removal).
  assert.deepEqual([...removalsOwed(pending, 'simkl')], ['tt0000001:1:2'])
  assert.deepEqual([...removalsOwed(pending, 'trakt')], ['tt0000002:movie:movie'])
  assert.deepEqual([...removalsOwed(pending, 'mal')], [])
})

check('a removal on its way is held back until its push is answered', () => {
  // Nothing is written down for a push until it fails, so between the
  // un-mark and the answer only this says the services still list it.
  const release = holdRemovalsOnTheWay(PROFILE, ['tt0000001:1:2', 'tt0000001:1:3'])
  assert.deepEqual([...removalsInFlight(PROFILE)].sort(), ['tt0000001:1:2', 'tt0000001:1:3'])
  assert.deepEqual([...removalsInFlight('profile-b')], [], 'per profile')
  // A second un-mark of the same episode while the first is in flight.
  const second = holdRemovalsOnTheWay(PROFILE, ['tt0000001:1:2'])
  release()
  release()
  assert.deepEqual([...removalsInFlight(PROFILE)], ['tt0000001:1:2'], 'the second still holds it')
  second()
  assert.deepEqual([...removalsInFlight(PROFILE)], [])
})

// --- one retry run at a time ------------------------------------------------

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function asyncChecks(): Promise<void> {
  await checkAsync('a pass or Sync now asked mid-run shares the run already out', async () => {
    const gate = deferred()
    let runs = 0
    const retry = oneRunAtATime(async () => {
      runs++
      await gate.promise
    })
    const first = retry('background')
    const second = retry('interactive')
    assert.equal(first, second)
    gate.resolve()
    await second
    assert.equal(runs, 1)
  })

  await checkAsync('a Sync review choice written mid-run is sent by a run after it', async () => {
    // The run that is out read the owed record before the choice was
    // written, so the flush cannot settle for it: it waits, then runs again.
    // Three choices flushed while the first run is out share one follow-up.
    const gates = [deferred(), deferred()]
    const seen: string[][] = []
    const record: string[] = ['choice 1']
    const retry = oneRunAtATime(async () => {
      const read = [...record]
      await gates[seen.length].promise
      seen.push(read)
    })
    const first = retry('interactive')
    record.push('choice 2')
    const flushA = retry('interactive', { rerun: true })
    record.push('choice 3')
    const flushB = retry('interactive', { rerun: true })
    assert.equal(flushA, flushB)
    assert.notEqual(flushA, first)
    gates[0].resolve()
    await first
    gates[1].resolve()
    await flushA
    assert.deepEqual(seen, [['choice 1'], ['choice 1', 'choice 2', 'choice 3']])
    // With nothing out, a flush is an ordinary run.
    let runs = 0
    const idle = oneRunAtATime(async () => {
      runs++
    })
    await idle('interactive', { rerun: true })
    assert.equal(runs, 1)
  })

  await checkAsync('a run that failed does not stop the follow-up', async () => {
    let runs = 0
    const retry = oneRunAtATime(async () => {
      runs++
      if (runs === 1) throw new Error('offline')
    })
    const first = retry('interactive').catch(() => {})
    await retry('interactive', { rerun: true })
    await first
    assert.equal(runs, 2)
  })
}

// --- through the handlers ---------------------------------------------------
// The checks above take the helpers one at a time. These run them where
// tracking.ts puts them together: the mark handler's push (keptSimkl) and the
// retry Sync now starts (runHistoryRetry, sendHistoryRetry). tracking.ts
// imports 'electron', so the name is pointed at the headless stand-in before
// it is loaded, as tests/homeRows.test.ts does. Simkl is connected under a
// made-up token, and the fake notes every history body it is sent.

/** The mark handlers answer at once and push behind (queueRemotePushes). */
async function waitFor(done: () => boolean): Promise<void> {
  for (let tries = 0; !done(); tries++) {
    if (tries > 200) throw new Error('timed out waiting for the push')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function handlerChecks(): Promise<void> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-tracking-pushes-'))
  process.env.R3_USER_DATA = scratch
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
  const { registerTrackingIpc } = await import('../src/main/media-hub/tracking')
  const { BrowserWindow, ipcMain } = await import('../src/headless/electronShim')
  const { MEDIA_HUB_CHANNELS } = await import('../src/shared/media-hub/ipc-channels')

  const db = createDatabase(path.join(scratch, 'pushes.sqlite'), 'profile-handlers')
  setDatabase(db)
  const plain = (value: string): string => `plain:${Buffer.from(value, 'utf8').toString('base64')}`
  store.writeSettings({ simklClientId: 'cid', simklAccessToken: plain('simkl-token') })
  const sent: { path: string; body: SimklHistoryPayload }[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.hostname === 'api.simkl.com' && url.pathname.startsWith('/sync/history')) {
      sent.push({ path: url.pathname, body: JSON.parse(String(init?.body)) })
      return new Response('{}', { status: 201 })
    }
    // Everything else is offline, the plan-to-watch pull after the retry
    // included: nothing here is about it.
    throw new TypeError('fetch failed')
  }) as typeof fetch
  registerTrackingIpc()
  const window = new BrowserWindow()
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const invoke = (channel: string, payload?: unknown): Promise<unknown> =>
    ipcMain.dispatchInvoke(event, channel, [payload])
  const profile = db.activeProfile()
  const owed = (): PendingHistoryPushes =>
    readHistoryPending(db, profile, store.trackingAccountMarks())
  const WAITING = 'simkl|kitsu:100|2|5'

  await checkAsync(
    'a later anime season marked before grouping is kept owed, not lost',
    async () => {
      // A fresh database: the anime catalog has never been grouped, so the
      // body for season 2 is empty and nothing is sent for it.
      await invoke(MEDIA_HUB_CHANNELS.trackingMarkWatched, {
        item: { id: 'kitsu:100', type: 'anime', title: 'Bleach' },
        playback: { season: 2, episode: 5 }
      })
      await waitFor(() => WAITING in owed())
      const entry = owed()[WAITING]
      assert.equal(entry.action, 'add')
      assert.equal(entry.lastError, 'Waiting for the anime catalog to be organised.')
      assert.equal(entry.attempts, 0)
      assert.deepEqual(sent, [], 'not sent to the first season’s entry, nor anywhere')
    }
  )

  await checkAsync('a retry dates what it adds, and the waiting season stays queued', async () => {
    const watched = '2026-10-01T20:15:00.000Z'
    db.importWatched([
      { ...SHOW, season: 1, episode: 2, watchedAt: watched },
      { ...FILM, season: null, episode: null, watchedAt: watched }
    ])
    const mark = store.trackingAccountMarks().simkl
    const now = Date.now()
    let pending = recordHistoryPush(owed(), outcome({ mark }), now)
    pending = recordHistoryPush(
      pending,
      outcome({ mark, item: FILM, rows: [{ season: null, episode: null }] }),
      now
    )
    writeHistoryPending(db, profile, pending)
    // Sync now: the owed pushes go out before the plan-to-watch pull.
    await invoke(MEDIA_HUB_CHANNELS.trackingPlannedSync)
    const adds = sent.filter((post) => post.path === '/sync/history')
    assert.equal(adds.length, 2)
    assert.deepEqual(adds.find((post) => post.body.shows)?.body.shows?.[0].seasons, [
      { number: 1, episodes: [{ number: 2, watched_at: watched }] }
    ])
    assert.equal(adds.find((post) => post.body.movies)?.body.movies?.[0].watched_at, watched)
    assert.ok(!adds.some((post) => post.body.anime), 'the waiting season is not sent')
    // The two that went are cleared; the waiting season costs no try.
    assert.deepEqual(Object.keys(owed()), [WAITING])
    assert.equal(owed()[WAITING].attempts, 0)
  })

  db.close()
}

void asyncChecks()
  .then(handlerChecks)
  .then(() => console.log(`\n${pass} passing`))
