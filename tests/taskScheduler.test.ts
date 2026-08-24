// Unit tests for the central work manager (src/main/media-hub/
// taskScheduler.ts) — the four properties the "(Not Responding)" fix
// actually rests on: coalescing (one crawl, not one per caller), per-lane
// concurrency (an upstream can't be flooded), the tier hierarchy
// (background work stands down for anything someone is waiting on), and
// backpressure (playback suspends maintenance outright).
//
// Run with: npx tsx tests/taskScheduler.test.ts   (or npm.cmd test)

import assert from 'node:assert'
import {
  currentPressure,
  laneForUrl,
  coalesce,
  coalesceScope,
  isForegroundPriority,
  mapWithLimit,
  resetSchedulerForTests,
  schedule,
  schedulerSnapshot,
  setPressure
} from '../src/main/media-hub/taskScheduler'

let pass = 0
const failures: string[] = []

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  resetSchedulerForTests()
  try {
    await fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push(name)
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

/** A task that reports when it starts and finishes only when told to. */
function gate(): {
  task: () => Promise<string>
  started: () => boolean
  release: () => void
} {
  let didStart = false
  let done!: () => void
  const finished = new Promise<void>((resolve) => {
    done = resolve
  })
  return {
    task: async () => {
      didStart = true
      await finished
      return 'done'
    },
    started: () => didStart,
    release: () => done()
  }
}

/** Real elapsed time — needed wherever the scheduler's own wake-up is a
 *  timer (a lane's politeness gap, a pressure release), which no amount of
 *  microtask draining can bring forward. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Lets every already-queued microtask/dispatch settle before asserting.
 *  A plain `await null` only drains one turn; the scheduler hops through
 *  a promise chain per dispatch. */
function settle(turns = 8): Promise<void> {
  return new Promise((resolve) => {
    let n = turns
    const step = (): void => {
      if (n-- <= 0) return resolve()
      queueMicrotask(step)
    }
    step()
  })
}

async function main(): Promise<void> {
  await check('laneForUrl maps each upstream to its own lane', () => {
    assert.equal(laneForUrl('https://kitsu.io/api/edge/anime'), 'kitsu')
    assert.equal(
      laneForUrl('https://data.simkl.in/discover/trending/movies/week_500.json'),
      'simkl'
    )
    assert.equal(laneForUrl('https://api.simkl.com/movies/123'), 'simkl')
    assert.equal(laneForUrl('https://v3-cinemeta.strem.io/catalog/movie/top.json'), 'cinemeta')
    assert.equal(laneForUrl('https://graphql.anilist.co'), 'anilist')
    assert.equal(laneForUrl('https://example.invalid/thing'), 'default')
    // A non-URL must not throw its way out of a scheduling decision.
    assert.equal(laneForUrl('not a url'), 'default')
  })

  await check('the same key runs once and both callers share the result', async () => {
    let runs = 0
    const work = async (): Promise<number> => {
      runs++
      return 42
    }
    const [a, b] = await Promise.all([
      schedule(work, { key: 'catalog:anime', priority: 'visible' }),
      schedule(work, { key: 'catalog:anime', priority: 'background' })
    ])
    assert.equal(runs, 1, 'the second caller started a second copy of the work')
    assert.equal(a, 42)
    assert.equal(b, 42)
  })

  await check('a failed keyed task does not pin its rejection for later callers', async () => {
    let runs = 0
    await assert.rejects(
      schedule(
        () => {
          runs++
          throw new Error('upstream is down')
        },
        { key: 'catalog:movie' }
      ),
      /upstream is down/
    )
    // The key must be free again — a retry is a real retry, not the same
    // rejection handed back forever.
    const second = await schedule(
      () => {
        runs++
        return 'recovered'
      },
      { key: 'catalog:movie' }
    )
    assert.equal(second, 'recovered')
    assert.equal(runs, 2)
  })

  await check('a lane never runs more than its concurrency at once', async () => {
    // `default` is configured at 4 with no politeness gap, so this
    // isolates the concurrency cap from the pacing tested below.
    const gates = Array.from({ length: 9 }, () => gate())
    const all = gates.map((g, i) =>
      schedule(g.task, { lane: 'default', priority: 'visible', label: `page ${i}` })
    )
    await settle()
    assert.equal(
      gates.filter((g) => g.started()).length,
      4,
      'more than the lane budget was dispatched at once'
    )
    gates.forEach((g) => g.release())
    await Promise.all(all)
  })

  await check('a paced lane spreads its dispatches out instead of bursting', async () => {
    // kitsu carries minGapMs: 120 — the politeness pacing the crawlers
    // used to implement with their own `await sleep(350)` between batches.
    const gates = Array.from({ length: 4 }, () => gate())
    const all = gates.map((g, i) =>
      schedule(g.task, { lane: 'kitsu', priority: 'visible', label: `kitsu page ${i}` })
    )
    await settle()
    assert.equal(
      gates.filter((g) => g.started()).length,
      1,
      'the whole batch went out at once instead of being paced'
    )
    await sleep(280)
    const started = gates.filter((g) => g.started()).length
    assert.ok(
      started >= 2 && started <= 3,
      `expected the gap to have released 2-3 of 4 after 280ms, got ${started}`
    )
    gates.forEach((g) => g.release())
    await Promise.all(all)
  })

  await check('background work stands down while interactive work is queued', async () => {
    // Fill the interactive tier so its own work has to queue, then confirm
    // the background task behind it is not quietly dispatched into the
    // slots the queued interactive work is waiting for.
    const busy = Array.from({ length: 8 }, () => gate())
    const held = busy.map((g) => schedule(g.task, { lane: 'default', priority: 'interactive' }))

    const queuedInteractive = gate()
    const waitingHigh = schedule(queuedInteractive.task, {
      lane: 'kitsu',
      priority: 'interactive'
    })

    const low = gate()
    const waitingLow = schedule(low.task, { lane: 'simkl', priority: 'background' })
    await settle()

    assert.equal(
      low.started(),
      false,
      'background work ran while interactive work was still queued'
    )

    busy.forEach((g) => g.release())
    await settle(20)
    queuedInteractive.release()
    await settle(20)
    assert.equal(low.started(), true, 'background work never resumed after the queue drained')
    low.release()
    await Promise.all([...held, waitingHigh, waitingLow])
  })

  await check('playback pressure suspends maintenance and keeps interactive running', async () => {
    setPressure('playback', 'critical')
    assert.equal(currentPressure(), 'critical')

    const chore = gate()
    const choreDone = schedule(chore.task, { lane: 'default', priority: 'maintenance' })
    const urgent = gate()
    const urgentDone = schedule(urgent.task, { lane: 'default', priority: 'interactive' })
    await settle()

    assert.equal(urgent.started(), true, 'interactive work was blocked by playback pressure')
    assert.equal(chore.started(), false, 'maintenance work ran during playback')

    urgent.release()
    await urgentDone
    setPressure('playback', 'idle')
    await sleep(20)
    assert.equal(chore.started(), true, 'maintenance never resumed once playback ended')
    chore.release()
    await choreDone
  })

  await check('pressure sources are independent — the highest one wins', () => {
    setPressure('playback', 'critical')
    setPressure('startup', 'busy')
    assert.equal(currentPressure(), 'critical')
    setPressure('playback', 'idle')
    assert.equal(currentPressure(), 'busy', 'releasing one source dropped the other one too')
    setPressure('startup', 'idle')
    assert.equal(currentPressure(), 'idle')
  })

  await check('mapWithLimit preserves order and yields null for a failed item', async () => {
    const result = await mapWithLimit(['a', 'b', 'c', 'd'], async (item) => {
      if (item === 'c') throw new Error('no metadata for c')
      return item.toUpperCase()
    })
    assert.deepEqual(result, ['A', 'B', null, 'D'])
  })

  await check('mapWithLimit never runs more than its limit at once', async () => {
    let live = 0
    let peak = 0
    const items = Array.from({ length: 40 }, (_, i) => i)
    await mapWithLimit(
      items,
      async () => {
        live++
        peak = Math.max(peak, live)
        await sleep(1)
        live--
        return true
      },
      5
    )
    assert.ok(peak <= 5, `fan-out peaked at ${peak} concurrent operations, limit is 5`)
  })

  await check('coalesce runs composite work once and shares the result', async () => {
    let runs = 0
    const crawl = async (): Promise<string> => {
      runs++
      await sleep(5)
      return 'catalog'
    }
    const [a, b, c] = await Promise.all([
      coalesce('catalog:anime', crawl),
      coalesce('catalog:anime', crawl),
      coalesce('catalog:anime', crawl)
    ])
    assert.equal(runs, 1, 'the crawl ran more than once for concurrent callers')
    assert.deepEqual([a, b, c], ['catalog', 'catalog', 'catalog'])
    // Released on settle, so a later refresh is a real refresh.
    await coalesce('catalog:anime', crawl)
    assert.equal(runs, 2)
  })

  await check('a failed coalesce is not pinned for later callers', async () => {
    await assert.rejects(
      coalesce('catalog:series', async () => {
        throw new Error('kitsu is down')
      }),
      /kitsu is down/
    )
    assert.equal(await coalesce('catalog:series', async () => 'recovered'), 'recovered')
  })

  await check('a composite waiting on scheduled leaves cannot deadlock', async () => {
    // The reason composites use coalesce() and not schedule(): if the
    // outer operation held a worker slot while the leaf requests it is
    // waiting on queued for the same budget, enough concurrent composites
    // would take every slot and none of their children could ever start.
    // Pressure is pinned at critical, where the visible tier is only 2 —
    // three composites at once is more than the tier can hold.
    setPressure('playback', 'critical')
    const composite = (kind: string): Promise<string[]> =>
      coalesce(`catalog:${kind}`, async () => {
        const pages = await Promise.all(
          [0, 1, 2, 3].map((page) =>
            schedule(async () => `${kind}:${page}`, {
              lane: 'kitsu',
              priority: 'visible',
              label: `${kind} page ${page}`
            })
          )
        )
        return pages
      })

    const all = await Promise.all([composite('movie'), composite('series'), composite('anime')])
    assert.equal(all.length, 3)
    assert.ok(all.every((pages) => pages.length === 4))
    setPressure('playback', 'idle')
  })

  await check('foreground and background callers do not share a coalescing key', () => {
    // A detail page opening must never join a background reconcile pass's
    // fetch for the same title: it would inherit the tier that fetch was
    // scheduled at, and then stand down for the very requests the detail
    // page had just queued itself.
    assert.equal(isForegroundPriority('interactive'), true)
    assert.equal(isForegroundPriority('visible'), true)
    assert.equal(isForegroundPriority('background'), false)
    assert.equal(isForegroundPriority('maintenance'), false)

    // The pair that matters — catalog:list and home:personalized, both
    // visible — still share, which is the duplicate-crawl fix.
    assert.equal(coalesceScope('visible'), coalesceScope('interactive'))
    assert.notEqual(coalesceScope('visible'), coalesceScope('maintenance'))
    assert.equal(coalesceScope('background'), coalesceScope('maintenance'))
  })

  await check('a burst of work costs one dispatch pass, not one per task', async () => {
    // schedule() used to run a dispatch pass synchronously on every
    // enqueue, and each pass sorts the whole queue — so a crawl enqueuing
    // its pages in one Promise.all paid a sort per page over a queue
    // growing to the page count. At the anime catalog's 2,000-page depth
    // that measures at ~2 million comparisons on the thread that answers
    // the window: the exact kind of stall this module exists to remove
    // rather than relocate.
    //
    // Counted by watching Array.prototype.sort rather than by timing,
    // which would make this a flaky benchmark instead of a statement
    // about behaviour.
    const realSort = Array.prototype.sort
    let sorts = 0
    Array.prototype.sort = function <T>(this: T[], ...args: [((a: T, b: T) => number)?]): T[] {
      sorts++
      return realSort.apply(this, args) as T[]
    }

    const burst = 300
    const gates = Array.from({ length: burst }, () => gate())
    let all: Promise<string>[]
    try {
      all = gates.map((g, i) =>
        schedule(g.task, {
          lane: 'default',
          // Mixed tiers so ordering is real work, not a no-op over an
          // already-sorted queue.
          priority: i % 2 ? 'visible' : 'background',
          label: `page ${i}`
        })
      )
      await settle()
    } finally {
      Array.prototype.sort = realSort
    }

    assert.ok(
      sorts <= 4,
      `a burst of ${burst} tasks triggered ${sorts} dispatch passes; it should coalesce into one`
    )
    // Still dispatched correctly, not merely cheaply.
    const snapshot = schedulerSnapshot()
    assert.equal(snapshot.running.length, 4, 'the lane budget was not respected under a burst')
    assert.equal(snapshot.queued, burst - 4)

    gates.forEach((g) => g.release())
    await Promise.all(all)
  })

  await check('the snapshot reports what is running and what is waiting', async () => {
    const gates = Array.from({ length: 7 }, () => gate())
    const all = gates.map((g, i) =>
      schedule(g.task, { lane: 'default', priority: 'visible', label: `catalog page ${i}` })
    )
    await settle()
    const snapshot = schedulerSnapshot()
    assert.equal(snapshot.running.length, 4)
    assert.equal(snapshot.queued, 3)
    assert.equal(snapshot.queuedByPriority.visible, 3)
    assert.equal(snapshot.pressure, 'idle')
    assert.ok(snapshot.running.every((task) => task.lane === 'default'))
    assert.ok(snapshot.running[0].label.startsWith('catalog page'))
    gates.forEach((g) => g.release())
    await Promise.all(all)
  })

  resetSchedulerForTests()
  console.log(
    failures.length
      ? `\n${pass} passed, ${failures.length} failed: ${failures.join(', ')}`
      : `\n${pass} passed`
  )
}

void main()
