// The phone and TV app asks for a catch-up again after one fails
// (src/app-ui/lib/librarySync.ts).
//
// It asks when the app opens and when it comes back to the front. A pass
// that rejected, or that answered with an error, used to wait for the next
// of those, and a TV that stays in the foreground may never have one: the
// library stayed as it was for the whole session. Pinned here: a failed
// pass is asked again on the deferred case's timer, each wait twice the
// last, only so many times, and a fresh link starts the count over.
//
// A clean answer does not end the run, not even one that changed
// something: after a failure the backend sits out its own backoff without
// asking Simkl for what failed and answers those passes clean
// (simklCatchUp.ts), and Trakt or another kind can bring a change in the
// meantime. Taking either for a recovery would stop asking while the
// backend is still inside its backoff. The TV checks run the real backend
// pass to pin both.
//
// A pass put off does not spend the run either: it is asked again in three
// minutes anyway, and counting those asks would use them all up before the
// deferral ends.
//
// Nor does the same report handed back again (inside the backend's
// two-minute floor, or while something plays there): no pass ran, and
// counting it would let a few quick resumes after one failure use up the
// asks and push the first real one out by most of an hour. Such an answer
// to a resume leaves the retry still to come where it is; one to the
// retry's own ask leaves that retry owed, the last one too.
//
// Run with: npx tsx tests/catchUpRetry.test.ts

import assert from 'node:assert/strict'

import { requestCatchUp } from '../src/app-ui/lib/librarySync'
import { newCatchUpMemory, runCatchUp, type CatchUpDeps } from '../src/main/media-hub/simklCatchUp'
import type { CatchUpReport } from '../src/shared/media-hub/types'

const MINUTE = 60 * 1000
const RETRY_MS = 3 * MINUTE

const timers = new Map<number, { fn: () => void; ms: number }>()
let nextTimer = 1
let calls = 0
let answer: () => Promise<CatchUpReport> = () => Promise.reject(new Error('unset'))
const location = { hash: '#/' }

;(globalThis as { window?: unknown }).window = {
  location,
  setTimeout(fn: () => void, ms: number) {
    const id = nextTimer++
    timers.set(id, { fn, ms })
    return id
  },
  clearTimeout(id: number | undefined) {
    if (id !== undefined) timers.delete(id)
  },
  api: {
    mediaHub: {
      tracking: {
        catchUp() {
          calls += 1
          return answer()
        }
      }
    }
  }
}

/** Each fake pass's own `at`. Date.now() can repeat within a millisecond,
 *  and a repeated `at` is how the screen tells a replayed report. */
let fakeAt = 0

function report(patch: Partial<CatchUpReport> = {}): CatchUpReport {
  return {
    at: ++fakeAt,
    connected: true,
    changed: false,
    plannedAdded: 0,
    plannedRemoved: 0,
    plays: 0,
    followed: 0,
    skipped: 0,
    deferred: false,
    ...patch
  }
}

/** Lets a pass's then/catch/finally run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** The one armed retry, or null; asserts there is never more than one. */
function pendingRetry(): { fn: () => void; ms: number } | null {
  assert.ok(timers.size <= 1, `one retry timer at a time, found ${timers.size}`)
  const [entry] = timers.entries()
  return entry ? entry[1] : null
}

async function fireRetry(): Promise<void> {
  const [entry] = timers.entries()
  assert.ok(entry, 'a retry is armed')
  timers.delete(entry[0])
  entry[1].fn()
  await settle()
}

let pass = 0
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
    process.exitCode = 1
    // The store is module state: a check that failed part way must not
    // leave its run of retries to the checks after it.
    location.hash = '#/'
    await startOver().catch(() => {})
  }
}

/** Ends whatever run of retries a check left: clean answers until its asks
 *  run out, and the one after them starts the count over. */
async function startOver(): Promise<void> {
  timers.clear()
  answer = () => Promise.resolve(report())
  requestCatchUp()
  await settle()
  for (let ask = 0; ask < 10 && pendingRetry(); ask++) await fireRetry()
  assert.equal(pendingRetry(), null, 'the run of retries came to an end')
}

const START = Date.parse('2026-10-15T12:00:00Z')

interface FakeBackend {
  clock: number
  /** Simkl's activities read fails while this is set. */
  simklDown: boolean
  /** Simkl's film library read fails while this is set. */
  filmsDown: boolean
  /** The minutes at which Simkl's activities, and its film library, were read. */
  simklAsked: number[]
  filmsAsked: number[]
  /** What Trakt's history brings each pass, in order (Trakt is connected
   *  only when the check asks for it). */
  traktPlays: number[]
}

/** From here on every ask is answered by the real backend pass
 *  (simklCatchUp.ts) over a fake Simkl that is down until the check says
 *  otherwise, on a clock the check moves, so the backend's own floor and
 *  backoff decide what each ask does. */
function realBackend(options: { trakt?: boolean } = {}): FakeBackend {
  const backend: FakeBackend = {
    clock: START,
    simklDown: true,
    filmsDown: false,
    simklAsked: [],
    filmsAsked: [],
    traktPlays: []
  }
  const minutes = (): number => (backend.clock - START) / MINUTE
  // Checked against CatchUpDeps rather than cast to it, so an editor flags a
  // dependency the pass gains. Nothing typechecks tests/, though, and tsx
  // strips types: one missing here throws inside the pass and comes back as
  // an error report, which these checks cannot tell from Simkl failing.
  const deps = {
    db: {
      activeProfile: () => 'p1',
      getCache: () => null,
      putCache: () => {},
      history: () => [],
      tracked: () => [],
      applyCatchUp: () => ({ plays: 0, unplanned: [] })
    } as unknown as CatchUpDeps['db'],
    account: () => 'acct-1',
    connected: () => ({ simkl: 'acct-1', trakt: options.trakt ? 'trakt-1' : '', mal: '' }),
    activities: async () => {
      backend.simklAsked.push(minutes())
      if (backend.simklDown) throw Object.assign(new Error('Simkl answered 503'), { status: 503 })
      return { all: 'x', movies: { all: 'm1' }, tv_shows: { all: 's1' }, anime: { all: 'a1' } }
    },
    library: async (kind: string) => {
      if (kind === 'movie') {
        backend.filmsAsked.push(minutes())
        if (backend.filmsDown) throw Object.assign(new Error('Simkl answered 503'), { status: 503 })
      }
      return {}
    },
    syncPlanned: async () => ({ added: 0, removed: 0 }),
    awaitingRemoval: () => new Set<string>(),
    lookupKitsu: async () => ({ kitsuId: null, answered: true }),
    animeTarget: () => null,
    animeReady: () => true,
    unplanWatched: async () => {},
    announce: () => {},
    artwork: () => {},
    traktHistory: async () => backend.traktPlays.shift() ?? 0,
    busy: () => false,
    now: () => backend.clock,
    log: () => {}
  } satisfies CatchUpDeps
  const memory = newCatchUpMemory()
  answer = () => runCatchUp(deps, memory)
  return backend
}

async function main(): Promise<void> {
  await check(
    'a pass that rejects is asked again five times, each wait twice the last',
    async () => {
      calls = 0
      answer = () => Promise.reject(new Error('socket closed'))
      requestCatchUp()
      await settle()
      const waits: number[] = []
      for (let retry = pendingRetry(); retry; retry = pendingRetry()) {
        waits.push(retry.ms / MINUTE)
        await fireRetry()
      }
      assert.deepEqual(waits, [3, 6, 12, 24, 48])
      assert.equal(calls, 1 + 5, 'the first ask and five retries, then it waits for a resume')
      // A busy backend's answer to a resume, before any pass has run.
      answer = () => Promise.resolve(report({ at: 0 }))
      requestCatchUp()
      await settle()
      assert.equal(pendingRetry(), null, 'a replayed answer does not ask past the last retry')
    }
  )

  await check(
    'a clean pass after the last retry starts the count over and arms nothing',
    async () => {
      calls = 0
      answer = () => Promise.resolve(report())
      requestCatchUp()
      await settle()
      assert.equal(calls, 1)
      assert.equal(pendingRetry(), null, 'nothing failed and nothing was put off')
      answer = () => Promise.resolve(report({ error: 'Simkl answered 503' }))
      requestCatchUp()
      await settle()
      assert.equal(pendingRetry()?.ms, RETRY_MS, 'a new failure starts from the first wait')
      await startOver()
    }
  )

  await check('linking again starts a fresh run of retries', async () => {
    answer = () => Promise.reject(new Error('socket closed'))
    requestCatchUp()
    await settle()
    for (let ask = 0; ask < 10 && pendingRetry(); ask++) await fireRetry()
    assert.equal(pendingRetry(), null, 'the old account used up its asks')
    // The forced pass straight after a new link (LinkComputer.tsx) fails too.
    answer = () => Promise.resolve(report({ error: 'Simkl answered 503' }))
    requestCatchUp({ force: true })
    await settle()
    assert.equal(pendingRetry()?.ms, RETRY_MS, 'the new link gets a run of its own')
    await startOver()
  })

  await check(
    'a clean answer does not end the retries, not even one that changed something',
    async () => {
      calls = 0
      answer = () => Promise.resolve(report({ error: 'Simkl answered 503' }))
      requestCatchUp()
      await settle()
      assert.equal(pendingRetry()?.ms, RETRY_MS)
      // The backend sitting out its own backoff: no Simkl call, no error.
      answer = () => Promise.resolve(report())
      await fireRetry()
      assert.equal(pendingRetry()?.ms, 2 * RETRY_MS, 'asked again, after a longer wait')
      // A change from elsewhere, with what failed still in its backoff.
      answer = () => Promise.resolve(report({ changed: true, plays: 2 }))
      await fireRetry()
      assert.equal(calls, 3)
      assert.equal(pendingRetry()?.ms, 4 * RETRY_MS, 'a change is no recovery: asked again still')
      await startOver()
    }
  )

  await check('a retry owed while the player is up looks again in a few minutes', async () => {
    answer = () => Promise.reject(new Error('socket closed'))
    requestCatchUp()
    await settle()
    answer = () => Promise.resolve(report())
    await fireRetry()
    assert.equal(pendingRetry()?.ms, 2 * RETRY_MS)
    location.hash = '#/player/tt0111161'
    calls = 0
    await fireRetry()
    assert.equal(calls, 0, 'nothing is asked while something is playing')
    assert.equal(pendingRetry()?.ms, RETRY_MS, 'not the whole doubled wait again')
    location.hash = '#/'
    await startOver()
  })

  await check(
    'a TV in the foreground asks Simkl again after its activities read failed',
    async () => {
      // The real backend pass, so its own backoff decides what each ask does.
      const backend = realBackend()
      requestCatchUp()
      await settle()
      backend.simklDown = false // back a minute later
      // An hour of a TV left on Home, each armed retry fired when it is due.
      for (
        let retry = pendingRetry();
        retry && backend.clock - START < 60 * MINUTE;
        retry = pendingRetry()
      ) {
        backend.clock += retry.ms
        await fireRetry()
      }
      assert.equal(backend.simklAsked[0], 0)
      assert.ok(
        backend.simklAsked.length > 1 && backend.simklAsked[1] <= 10,
        `Simkl asked again within ten minutes, asked at minutes ${backend.simklAsked.join(', ')}`
      )
      await startOver()
    }
  )

  await check(
    'a TV asks for the films again after their read failed, though Trakt brought a viewing meanwhile',
    async () => {
      const backend = realBackend({ trakt: true })
      backend.simklDown = false
      backend.filmsDown = true
      backend.traktPlays = [0, 1] // a viewing on the second pass
      requestCatchUp()
      await settle()
      backend.filmsDown = false // back a minute later
      for (
        let retry = pendingRetry();
        retry && backend.clock - START < 60 * MINUTE;
        retry = pendingRetry()
      ) {
        backend.clock += retry.ms
        await fireRetry()
      }
      assert.equal(backend.filmsAsked[0], 0)
      // The films wait out the backend's half-hour backoff whatever else a
      // pass brings, so they are read again only by an ask after it.
      assert.ok(
        backend.filmsAsked.length > 1 && backend.filmsAsked[1] <= 60,
        `the films asked again within the hour, asked at minutes ${backend.filmsAsked.join(', ')}`
      )
      await startOver()
    }
  )

  await check('resumes inside the backend floor do not use up the retries', async () => {
    const backend = realBackend()
    requestCatchUp()
    await settle()
    assert.equal(pendingRetry()?.ms, RETRY_MS)
    // Each answered with the failed pass's report again, `at` and all.
    const waits: number[] = []
    for (const minutes of [0.5, 1, 1.5]) {
      backend.clock = START + minutes * MINUTE
      requestCatchUp()
      await settle()
      waits.push((pendingRetry()?.ms ?? 0) / MINUTE)
    }
    assert.deepEqual(backend.simklAsked, [0], 'no pass ran inside the floor')
    assert.deepEqual(waits, [3, 3, 3], 'still the first wait: nothing more had failed')
    await startOver()
  })

  await check('resumes answered with the same report leave the armed retry alone', async () => {
    answer = () => Promise.resolve(report({ error: 'Simkl answered 503' }))
    requestCatchUp()
    await settle()
    // The first retry is answered clean (the backend in its backoff), which
    // arms the second.
    const last = report()
    answer = () => Promise.resolve(last)
    await fireRetry()
    const armed = pendingRetry()
    assert.equal(armed?.ms, 2 * RETRY_MS)
    // A phone pointed at a backend that is playing: each resume is handed
    // the last report back.
    calls = 0
    for (let resume = 0; resume < 3; resume++) {
      requestCatchUp()
      await settle()
    }
    assert.equal(calls, 3)
    assert.equal(pendingRetry(), armed, 'the same timer, not pushed back by each resume')
    await startOver()
  })

  await check(
    'a retry whose own ask got the same report back is still owed, the last one too',
    async () => {
      let last = report()
      answer = () => Promise.resolve((last = report({ error: 'Simkl answered 503' })))
      requestCatchUp()
      await settle()
      const waits: number[] = []
      for (let retry = 0; retry < 4; retry++) {
        waits.push((pendingRetry()?.ms ?? 0) / MINUTE)
        await fireRetry()
      }
      assert.deepEqual(waits, [3, 6, 12, 24])
      assert.equal(pendingRetry()?.ms, 16 * RETRY_MS, 'the last retry')
      // Its ask lands inside the floor of a pass another client asked for, or
      // while the backend plays: the same report back, and no pass ran.
      answer = () => Promise.resolve(last)
      await fireRetry()
      assert.equal(pendingRetry()?.ms, 16 * RETRY_MS, 'the last retry is asked again')
      // Asked again, it fails for real, and the run is over.
      answer = () => Promise.resolve(report({ error: 'Simkl answered 503' }))
      await fireRetry()
      assert.equal(pendingRetry(), null, 'nothing past the last retry')
      await startOver()
    }
  )

  await check('a failure while a pass is put off keeps its retries for after', async () => {
    // A film read failed while the anime catalogue is still being grouped.
    answer = () => Promise.resolve(report({ error: 'Simkl answered 503', deferred: true }))
    requestCatchUp()
    await settle()
    const waits = [(pendingRetry()?.ms ?? 0) / MINUTE]
    for (let ask = 0; ask < 5; ask++) {
      await fireRetry()
      waits.push((pendingRetry()?.ms ?? 0) / MINUTE)
    }
    assert.deepEqual(waits, [3, 3, 3, 3, 3, 3], 'put off: asked every three minutes, as before')
    // The deferral ends, with the films still in the backend's backoff.
    answer = () => Promise.resolve(report())
    await fireRetry()
    assert.equal(pendingRetry()?.ms, 2 * RETRY_MS, 'the retries the failure is owed start now')
    await startOver()
  })

  await check('a pass put off is still asked again, as before', async () => {
    answer = () => Promise.resolve(report({ deferred: true }))
    requestCatchUp()
    await settle()
    assert.equal(pendingRetry()?.ms, RETRY_MS)
    timers.clear()
  })

  console.log(`\n${pass} passed`)
}

void main()
