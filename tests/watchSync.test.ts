// The half-hourly watch-sync pass: what it asks Simkl for.
//
// Simkl counts requests per person, the phone shares the desktop's token,
// and a client that reads /sync/all-items without asking /sync/activities
// first is one Simkl suspends — so the number of requests a pass makes is
// the behaviour, and it is what is pinned here. The pass (watchSync.ts) runs
// against a real temporary database with the services faked; each fake logs
// the Simkl requests the real thing makes: three plan-to-watch lists for a
// pull that reads Simkl (watchlists.ts's fetchSimklPlanned), two libraries
// for a diff that fetches its snapshot (simklClient.ts's
// simklWatchedSnapshot).
//
// Run with: npx tsx tests/watchSync.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDatabase } from '../src/main/media-hub/database'
import {
  SIMKL_LIST_MAX_AGE_MS,
  localFilmsSignature,
  newWatchSyncMemory,
  pullPlannedGated,
  runWatchSync,
  simklListDue,
  watchSyncStateFor,
  type SimklListRead,
  type WatchSyncDeps,
  type WatchSyncMemory,
  type WatchSyncState
} from '../src/main/media-hub/watchSync'
import type { PlannedPullOptions, PlannedSyncReport } from '../src/main/media-hub/watchlists'

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

const MINUTE = 60 * 1000
const PROFILE = 'profile-watch-sync'
/** The job's own period: each pass in these tests is one of these later. */
const PERIOD = 30 * MINUTE

const ACTIVITIES = 'GET /sync/activities'
const LISTS = [
  'GET /sync/all-items/movies/plantowatch',
  'GET /sync/all-items/shows/plantowatch',
  'GET /sync/all-items/anime/plantowatch'
]
const LIBRARIES = ['GET /sync/all-items/movies/completed', 'GET /sync/all-items/shows/all']

// ---------------------------------------------------------------------------
console.log('simklListDue')

const READ: SimklListRead = {
  stamps: { movies: 'm1', shows: 's1', anime: null },
  at: 1_000_000,
  pulled: 12,
  unmapped: 1
}

check('never read: due', () => {
  assert.equal(simklListDue(null, READ.stamps, READ.at), true)
})

check('the same stamps, inside a day: not due', () => {
  assert.equal(simklListDue(READ, { ...READ.stamps }, READ.at + PERIOD), false)
  assert.equal(simklListDue(READ, { ...READ.stamps }, READ.at + SIMKL_LIST_MAX_AGE_MS - 1), false)
})

check('any one kind moving is enough, in either direction', () => {
  const later = READ.at + PERIOD
  assert.equal(simklListDue(READ, { ...READ.stamps, shows: 's2' }, later), true)
  assert.equal(simklListDue(READ, { ...READ.stamps, movies: 'm0' }, later), true)
  // An account's first anime: no stamp until now.
  assert.equal(simklListDue(READ, { ...READ.stamps, anime: 'a1' }, later), true)
  // And a stamp Simkl stopped giving is a change too.
  assert.equal(simklListDue(READ, { ...READ.stamps, movies: null }, later), true)
})

check('a kind with no stamp, then and now, is not a reason to read', () => {
  // Somebody who watches no anime has no anime stamp, for good.
  assert.equal(simklListDue(READ, { movies: 'm1', shows: 's1', anime: null }, READ.at + 1), false)
})

check('unchanged for a day: read anyway', () => {
  assert.equal(simklListDue(READ, { ...READ.stamps }, READ.at + SIMKL_LIST_MAX_AGE_MS), true)
})

check('a clock set back does not strand the record in the future', () => {
  assert.equal(simklListDue(READ, { ...READ.stamps }, READ.at - 1), true)
})

// ---------------------------------------------------------------------------
console.log('watchSyncStateFor')

check('another account, or nothing stored: an empty state', () => {
  const stored: WatchSyncState = {
    account: 'acct-1',
    list: READ,
    diffed: { movies: 'm1', local: '0:x', at: 5 }
  }
  assert.deepEqual(watchSyncStateFor(stored, 'acct-2'), {
    account: 'acct-2',
    list: null,
    diffed: null
  })
  assert.deepEqual(watchSyncStateFor(null, 'acct-1'), {
    account: 'acct-1',
    list: null,
    diffed: null
  })
  assert.deepEqual(watchSyncStateFor('nonsense', 'acct-1').list, null)
})

check('a well-formed state comes back as written', () => {
  const stored: WatchSyncState = {
    account: 'acct-1',
    list: READ,
    diffed: { movies: null, local: '0:x', at: 5 }
  }
  assert.deepEqual(watchSyncStateFor(JSON.parse(JSON.stringify(stored)), 'acct-1'), stored)
})

check('a malformed half reads as never read, and leaves the other alone', () => {
  const good = { movies: 'm1', local: '2:abc', at: 5 }
  const badList = { account: 'acct-1', list: { stamps: { movies: 7 }, at: 1 }, diffed: good }
  assert.deepEqual(watchSyncStateFor(badList, 'acct-1'), {
    account: 'acct-1',
    list: null,
    diffed: good
  })
  const badDiff = {
    account: 'acct-1',
    list: READ,
    diffed: { movies: 'm1', local: '2:abc', at: 'yesterday' }
  }
  assert.deepEqual(watchSyncStateFor(badDiff, 'acct-1'), {
    account: 'acct-1',
    list: READ,
    diffed: null
  })
  // A diff recorded without its local half vouches for one side only.
  const oneSided = { account: 'acct-1', list: READ, diffed: { movies: 'm1', at: 5 } }
  assert.equal(watchSyncStateFor(oneSided, 'acct-1').diffed, null)
})

// ---------------------------------------------------------------------------
console.log('localFilmsSignature')

check('which films, whatever the order and however often', () => {
  const dune = { id: 'tt0000002', type: 'movie' }
  const arrival = { id: 'tt0000003', type: 'movie' }
  assert.equal(localFilmsSignature([dune, arrival]), localFilmsSignature([arrival, dune, dune]))
  assert.notEqual(localFilmsSignature([dune]), localFilmsSignature([dune, arrival]))
  // One film swapped for another: the count is the same, the set is not.
  assert.notEqual(localFilmsSignature([dune]), localFilmsSignature([arrival]))
})

check('an episode watched is not part of it', () => {
  const dune = { id: 'tt0000002', type: 'movie' }
  assert.equal(
    localFilmsSignature([
      dune,
      { id: 'tt0000001', type: 'series' },
      { id: 'kitsu:1', type: 'anime' }
    ]),
    localFilmsSignature([dune])
  )
  assert.equal(localFilmsSignature([{ id: 'tt0000001', type: 'series' }]), localFilmsSignature([]))
})

// ---------------------------------------------------------------------------
// The pass itself.

interface Harness {
  db: ReturnType<typeof createDatabase>
  deps: WatchSyncDeps
  memory: WatchSyncMemory
  /** Everything the pass did, in order: Simkl requests by path, and the rest by name. */
  calls: string[]
  /** What each pull was asked to leave unread. */
  pulls: PlannedPullOptions[]
  stamps: { movies: string | null; shows: string | null; anime: string | null }
  account: string
  clock: number
  /** Whether the interface in front of this backend has a review panel. */
  review: boolean
  trakt: boolean
  activitiesError: (Error & { status?: number }) | null
  /** Simkl's lists fail to load, as the pull reports it. */
  listError: string | null
  /** The diff is inside its cooldown, or its snapshot came from the cache. */
  reconcileFetches: boolean
  /** Runs inside the pull, before it answers — a profile switch, say. */
  duringPull: (() => void) | null
  /** How long before the pass's own clock the pull it was handed began. */
  pullStartedEarlier: number
  state(profile?: string): WatchSyncState | null
}

function harness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-watch-sync-'))
  const db = createDatabase(path.join(dir, 'test.sqlite'), PROFILE)
  const h: Harness = {
    db,
    memory: newWatchSyncMemory(),
    calls: [],
    pulls: [],
    stamps: { movies: 'm1', shows: 's1', anime: 'a1' },
    account: 'acct-1',
    clock: Date.parse('2026-10-04T12:00:00.000Z'),
    review: true,
    trakt: false,
    activitiesError: null,
    listError: null,
    reconcileFetches: true,
    duringPull: null,
    pullStartedEarlier: 0,
    state: (profile = PROFILE) =>
      db.getCache<WatchSyncState>(`simkl:watch-sync:v1:${profile}`, { allowExpired: true }),
    deps: undefined as unknown as WatchSyncDeps
  }
  h.deps = {
    db,
    account: () => h.account,
    activities: async () => {
      h.calls.push(ACTIVITIES)
      if (h.activitiesError) throw h.activitiesError
      return {
        all: 'x',
        movies: { all: h.stamps.movies },
        tv_shows: { all: h.stamps.shows },
        anime: { all: h.stamps.anime }
      }
    },
    // The pull, as watchlists.ts's pullPlanned behaves at its edges: what
    // it fetches, and what its report says about a Simkl it did not read.
    syncPlanned: async (options): Promise<PlannedSyncReport> => {
      const startedAt = h.clock - h.pullStartedEarlier
      h.pulls.push(options)
      h.calls.push('retry-owed-plan-changes')
      const skip = h.account ? options.skipSimkl : undefined
      if (h.account && !skip) h.calls.push(...LISTS)
      if (h.trakt) h.calls.push('trakt:watchlist')
      h.duringPull?.()
      const simkl = !h.account
        ? { service: 'simkl' as const, connected: false, pulled: 0, unmapped: 0 }
        : skip?.reason === 'unchanged'
          ? {
              service: 'simkl' as const,
              connected: true,
              pulled: skip.pulled,
              unmapped: skip.unmapped,
              skipped: true
            }
          : skip
            ? {
                service: 'simkl' as const,
                connected: true,
                pulled: 0,
                unmapped: 0,
                skipped: true,
                error: skip.error
              }
            : h.listError
              ? {
                  service: 'simkl' as const,
                  connected: true,
                  pulled: 0,
                  unmapped: 0,
                  error: h.listError
                }
              : { service: 'simkl' as const, connected: true, pulled: 12, unmapped: 1 }
      return {
        at: h.clock,
        startedAt,
        services: [
          simkl,
          { service: 'trakt', connected: h.trakt, pulled: h.trakt ? 3 : 0, unmapped: 0 },
          { service: 'mal', connected: false, pulled: 0, unmapped: 0 }
        ],
        added: 0,
        removed: 0
      }
    },
    flushPushes: async () => {
      h.calls.push('flush-owed-history')
    },
    reviewAsked: () => h.review,
    reconcile: async () => {
      if (h.reconcileFetches) h.calls.push(...LIBRARIES)
      else h.calls.push('diff-without-fetching')
      return h.reconcileFetches
    },
    now: () => h.clock,
    log: () => {}
  }
  return h
}

/** One pass, the job's period after the last, and what it did. */
async function passOf(h: Harness, after = PERIOD): Promise<string[]> {
  h.clock += after
  h.calls.length = 0
  h.pulls.length = 0
  await runWatchSync(h.deps, h.memory)
  return [...h.calls]
}

function simklRequests(calls: string[]): string[] {
  return calls.filter((call) => call.startsWith('GET /sync/'))
}

async function passes(): Promise<void> {
  console.log('runWatchSync')

  await checkAsync('a first pass reads everything, behind the gate', async () => {
    const h = harness()
    const calls = await passOf(h)
    assert.deepEqual(calls, [
      ACTIVITIES,
      'retry-owed-plan-changes',
      ...LISTS,
      'flush-owed-history',
      ...LIBRARIES
    ])
    assert.deepEqual(h.state()?.list, {
      stamps: { movies: 'm1', shows: 's1', anime: 'a1' },
      at: h.clock,
      pulled: 12,
      unmapped: 1
    })
    assert.deepEqual(h.state()?.diffed, {
      movies: 'm1',
      local: localFilmsSignature([]),
      at: h.clock
    })
  })

  await checkAsync('nothing changed: one Simkl request, and what is owed still goes', async () => {
    const h = harness()
    await passOf(h)
    const calls = await passOf(h)
    assert.deepEqual(simklRequests(calls), [ACTIVITIES])
    assert.equal(simklRequests(calls).length, 1, 'against the five an ungated pass made')
    // Owed work is not polling: both still run, every pass.
    assert.deepEqual(calls, [ACTIVITIES, 'retry-owed-plan-changes', 'flush-owed-history'])
    // The pull was told why Simkl is unread, and what its list still holds.
    assert.deepEqual(h.pulls, [{ skipSimkl: { reason: 'unchanged', pulled: 12, unmapped: 1 } }])
    // …and so on, for as long as nothing moves.
    assert.deepEqual(simklRequests(await passOf(h)), [ACTIVITIES])
  })

  await checkAsync('shows changed: the gate and the three lists, not the libraries', async () => {
    const h = harness()
    await passOf(h)
    h.stamps.shows = 's2'
    const calls = await passOf(h)
    assert.deepEqual(simklRequests(calls), [ACTIVITIES, ...LISTS])
    assert.equal(simklRequests(calls).length, 4)
    assert.deepEqual(h.pulls, [{}], 'Simkl is read, so nothing is skipped')
    assert.equal(h.state()?.list?.stamps.shows, 's2')
    // The diff compares films, and no film moved.
    assert.deepEqual(h.state()?.diffed?.movies, 'm1')
    // Settled again: the next pass is back to one.
    assert.deepEqual(simklRequests(await passOf(h)), [ACTIVITIES])
  })

  await checkAsync('films changed: the lists and the libraries', async () => {
    const h = harness()
    await passOf(h)
    h.stamps.movies = 'm2'
    const calls = await passOf(h)
    assert.deepEqual(simklRequests(calls), [ACTIVITIES, ...LISTS, ...LIBRARIES])
    assert.equal(h.state()?.diffed?.movies, 'm2')
    assert.deepEqual(simklRequests(await passOf(h)), [ACTIVITIES])
  })

  await checkAsync(
    'a film marked here that Simkl never heard of: the diff is made again',
    async () => {
      // The push that follows a mark is not queued. When it fails, Simkl's
      // stamp stays where it was while the two sides have come to disagree.
      const h = harness()
      await passOf(h)
      h.db.markWatched({ id: 'tt0000002', type: 'movie', title: 'Dune' })
      const calls = await passOf(h)
      assert.deepEqual(simklRequests(calls), [ACTIVITIES, ...LIBRARIES], 'the lists did not move')
      assert.equal(h.state()?.diffed?.local, localFilmsSignature(h.db.history()))
      assert.deepEqual(simklRequests(await passOf(h)), [ACTIVITIES])
      // Cleared again here, and again nothing reached Simkl.
      h.db.unmarkWatched('tt0000002')
      assert.deepEqual(simklRequests(await passOf(h)), [ACTIVITIES, ...LIBRARIES])
      assert.deepEqual(simklRequests(await passOf(h)), [ACTIVITIES])
    }
  )

  await checkAsync('an episode watched here moves neither side of the diff', async () => {
    const h = harness()
    await passOf(h)
    h.db.markWatched(
      { id: 'tt0000001', type: 'series', title: 'Severance' },
      { season: 1, episode: 1 }
    )
    assert.deepEqual(simklRequests(await passOf(h)), [ACTIVITIES])
  })

  await checkAsync('a backend nobody opens a review panel on never fetches a library', async () => {
    // The phone and TV app: tracking:reconcile-check is never called.
    const h = harness()
    h.review = false
    assert.deepEqual(simklRequests(await passOf(h)), [ACTIVITIES, ...LISTS])
    assert.equal(h.state()?.diffed, null)
    h.stamps.movies = 'm2'
    assert.deepEqual(simklRequests(await passOf(h)), [ACTIVITIES, ...LISTS])
    assert.deepEqual(simklRequests(await passOf(h)), [ACTIVITIES])
    // The panel is asked for after all (a desktop interface attaches): the
    // diff has never been made for this account, so it is made once.
    h.review = true
    assert.deepEqual(simklRequests(await passOf(h)), [ACTIVITIES, ...LIBRARIES])
    assert.deepEqual(simklRequests(await passOf(h)), [ACTIVITIES])
  })

  await checkAsync(
    'Trakt connected: its pull keeps its timer, Simkl is still skipped',
    async () => {
      const h = harness()
      h.trakt = true
      await passOf(h)
      const calls = await passOf(h)
      assert.deepEqual(calls, [
        ACTIVITIES,
        'retry-owed-plan-changes',
        'trakt:watchlist',
        'flush-owed-history'
      ])
      assert.deepEqual(h.pulls, [{ skipSimkl: { reason: 'unchanged', pulled: 12, unmapped: 1 } }])
    }
  )

  await checkAsync('Simkl not connected: no gate, and the pull runs for the others', async () => {
    const h = harness()
    h.account = ''
    h.trakt = true
    const calls = await passOf(h)
    assert.deepEqual(calls, ['retry-owed-plan-changes', 'trakt:watchlist'])
    assert.deepEqual(h.pulls, [{}])
    assert.equal(h.state(), null)
  })

  await checkAsync('unchanged for a day: the lists are read once more', async () => {
    const h = harness()
    await passOf(h)
    const readAt = h.clock
    assert.deepEqual(simklRequests(await passOf(h, SIMKL_LIST_MAX_AGE_MS - MINUTE)), [ACTIVITIES])
    // Films did not move, so the libraries are not part of it.
    assert.deepEqual(simklRequests(await passOf(h, MINUTE)), [ACTIVITIES, ...LISTS])
    assert.equal(h.state()?.list?.at, readAt + SIMKL_LIST_MAX_AGE_MS)
    assert.deepEqual(simklRequests(await passOf(h)), [ACTIVITIES])
  })

  await checkAsync(
    'the gate failing: nothing behind it is fetched, what is owed still goes',
    async () => {
      const h = harness()
      await passOf(h)
      h.stamps.movies = 'm2'
      h.activitiesError = Object.assign(new Error('Too many requests'), { status: 429 })
      const calls = await passOf(h)
      assert.deepEqual(calls, [ACTIVITIES, 'retry-owed-plan-changes', 'flush-owed-history'])
      assert.deepEqual(h.pulls, [{ skipSimkl: { reason: 'unasked', error: 'Too many requests' } }])
      assert.equal(h.state()?.list?.stamps.movies, 'm1', 'nothing recorded')
      // One failure costs no run: the next pass asks again…
      assert.deepEqual(simklRequests(await passOf(h)), [ACTIVITIES])
      // …and a second in a row is waited out, with the reason still reported.
      const waiting = await passOf(h)
      assert.deepEqual(simklRequests(waiting), [])
      assert.deepEqual(h.pulls, [{ skipSimkl: { reason: 'unasked', error: 'Too many requests' } }])
      assert.equal(waiting.includes('flush-owed-history'), true)
      // Once Simkl answers, everything that moved meanwhile is read.
      h.activitiesError = null
      assert.deepEqual(simklRequests(await passOf(h)), [ACTIVITIES, ...LISTS, ...LIBRARIES])
    }
  )

  await checkAsync('a refused token is asked again in hours, not every half hour', async () => {
    const h = harness()
    await passOf(h)
    h.activitiesError = Object.assign(new Error('Unauthorized'), { status: 401 })
    assert.deepEqual(simklRequests(await passOf(h)), [ACTIVITIES])
    for (let run = 0; run < 11; run++) {
      assert.deepEqual(simklRequests(await passOf(h)), [], `run ${run + 1} of the six hours`)
    }
    assert.deepEqual(simklRequests(await passOf(h)), [ACTIVITIES], 'six hours on')
    // Linking again is a new account mark: asked at once, and read afresh.
    h.activitiesError = null
    h.account = 'acct-2'
    assert.deepEqual(simklRequests(await passOf(h)), [ACTIVITIES, ...LISTS, ...LIBRARIES])
  })

  await checkAsync('offline is not Simkl saying no: every pass asks again', async () => {
    const h = harness()
    await passOf(h)
    h.activitiesError = new Error('fetch failed')
    for (let run = 0; run < 3; run++) {
      const calls = await passOf(h)
      assert.deepEqual(simklRequests(calls), [ACTIVITIES])
      assert.deepEqual(h.pulls, [{ skipSimkl: { reason: 'unasked', error: 'fetch failed' } }])
    }
  })

  await checkAsync('lists that failed to load are not recorded as read', async () => {
    const h = harness()
    h.listError = 'Request failed (502)'
    assert.deepEqual(simklRequests(await passOf(h)), [ACTIVITIES, ...LISTS, ...LIBRARIES])
    assert.equal(h.state()?.list ?? null, null)
    // Same stamps, and still fetched: the last read never happened.
    h.listError = null
    assert.deepEqual(simklRequests(await passOf(h)), [ACTIVITIES, ...LISTS])
    assert.deepEqual(simklRequests(await passOf(h)), [ACTIVITIES])
  })

  await checkAsync('a diff that fetched nothing does not advance the films stamp', async () => {
    const h = harness()
    h.reconcileFetches = false
    const first = await passOf(h)
    assert.equal(first.includes('diff-without-fetching'), true)
    assert.equal(h.state()?.diffed, null)
    // Tried again next pass, and recorded once it is made against Simkl.
    h.reconcileFetches = true
    assert.deepEqual(simklRequests(await passOf(h)), [ACTIVITIES, ...LIBRARIES])
    assert.deepEqual(simklRequests(await passOf(h)), [ACTIVITIES])
  })

  await checkAsync('each profile has its own record', async () => {
    const h = harness()
    await passOf(h)
    // Another profile's list has never had Simkl's applied to it.
    h.db.setActiveProfile('someone-else')
    assert.deepEqual(simklRequests(await passOf(h)), [ACTIVITIES, ...LISTS, ...LIBRARIES])
    assert.deepEqual(simklRequests(await passOf(h)), [ACTIVITIES])
    h.db.setActiveProfile(PROFILE)
    assert.deepEqual(simklRequests(await passOf(h)), [ACTIVITIES])
  })

  await checkAsync('a profile switch during the pull records nothing, anywhere', async () => {
    const h = harness()
    h.duringPull = () => h.db.setActiveProfile('someone-else')
    const calls = await passOf(h)
    assert.deepEqual(simklRequests(calls), [ACTIVITIES, ...LISTS], 'and no diff for the wrong one')
    assert.equal(h.state(PROFILE), null)
    assert.equal(h.state('someone-else'), null)
  })

  await checkAsync('an account switch during the pull records nothing', async () => {
    const h = harness()
    h.duringPull = () => {
      h.account = 'acct-2'
    }
    await passOf(h)
    assert.equal(h.state(), null)
  })

  await checkAsync(
    'a pull that began before the stamps were read cannot vouch for them',
    async () => {
      // The pass joined a pull already under way (watchlists.ts shares one):
      // its lists may predate the stamps, so a change in between would be
      // recorded as read and never fetched.
      const h = harness()
      h.pullStartedEarlier = 5000
      await passOf(h)
      assert.equal(h.state()?.list ?? null, null)
      h.pullStartedEarlier = 0
      assert.deepEqual(simklRequests(await passOf(h)), [ACTIVITIES, ...LISTS])
      assert.deepEqual(simklRequests(await passOf(h)), [ACTIVITIES])
    }
  )

  console.log('pullPlannedGated')

  await checkAsync('the catch-up and the job read the lists once between them', async () => {
    const h = harness()
    const gate = { stamps: { ...h.stamps }, readAt: h.clock }
    // The catch-up's pull, with the stamps its own gate read…
    await pullPlannedGated(h.deps, gate)
    assert.deepEqual(simklRequests(h.calls), LISTS)
    // …is the read the job's next pass finds already made. No panel here.
    h.review = false
    assert.deepEqual(simklRequests(await passOf(h)), [ACTIVITIES])
    // And the other way round: a second catch-up under the same stamps.
    h.calls.length = 0
    await pullPlannedGated(h.deps, { stamps: { ...h.stamps }, readAt: h.clock })
    assert.deepEqual(simklRequests(h.calls), [])
  })

  await checkAsync('no stamps is never "nothing changed": Simkl is left unread', async () => {
    const h = harness()
    await pullPlannedGated(h.deps, { stamps: null, readAt: 0 })
    assert.deepEqual(simklRequests(h.calls), [])
    assert.deepEqual(h.pulls, [
      { skipSimkl: { reason: 'unasked', error: 'Simkl could not be asked.' } }
    ])
    assert.equal(h.state(), null)
  })
}

void passes().then(() => console.log(`\n${pass} passed`))
