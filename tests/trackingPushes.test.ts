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
// Run with: npx tsx tests/trackingPushes.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDatabase } from '../src/main/media-hub/database'
import {
  HISTORY_PENDING_MAX_ATTEMPTS,
  HISTORY_PENDING_TTL_MS,
  historyPendingKey,
  historyRetryBatches,
  readHistoryPending,
  recordHistoryPush,
  holdRemovalsOnTheWay,
  removalsInFlight,
  removalsOwed,
  retryFailure,
  settleHistoryRetry,
  writeHistoryPending,
  type HistoryPushOutcome,
  type PendingHistoryPushes
} from '../src/main/media-hub/historyRetry'
import { scrobblingEnabled } from '../src/main/media-hub/preferences'

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

check('a retry that fails counts an attempt, and ten are the limit', () => {
  let pending = recordHistoryPush({}, outcome(), T0)
  const [batch] = historyRetryBatches(pending, new Set(['tt0000001:1:2'])).batches
  for (let tries = 1; tries < HISTORY_PENDING_MAX_ATTEMPTS; tries++) {
    const settled = settleHistoryRetry(pending, batch, 'Request failed (502)')
    assert.equal(settled.abandoned.length, 0)
    pending = settled.pending
    assert.equal(pending['simkl|tt0000001|1|2'].attempts, tries)
  }
  const last = settleHistoryRetry(pending, batch, 'Request failed (502)')
  assert.deepEqual(last.pending, {})
  assert.equal(last.abandoned.length, 1)
  assert.equal(last.abandoned[0].lastError, 'Request failed (502)')
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

check('which failures stop a service for the rest of the pass', () => {
  // No answer, a 429 that outlasted its retry, or a 5xx: the service is
  // not taking requests, and the rest of its batches wait for the next pass.
  assert.deepEqual(retryFailure(undefined), { counts: false, stopsService: true })
  assert.deepEqual(retryFailure(503), { counts: true, stopsService: true })
  assert.deepEqual(retryFailure(429), { counts: true, stopsService: true })
  // A 4xx is about that one request; the next batch is still worth sending.
  assert.deepEqual(retryFailure(404), { counts: true, stopsService: false })
  assert.deepEqual(retryFailure(401), { counts: true, stopsService: false })
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

console.log(`\n${pass} passing`)
