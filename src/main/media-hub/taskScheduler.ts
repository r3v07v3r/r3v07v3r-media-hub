// The app's central work manager. New — not a port of anything in
// r3v07v3r-media-hub, which had no equivalent: every background job in the
// original (and, until now, in this port) owned its own setInterval/
// setTimeout and fired whenever its own clock said so, with no idea that
// anything else existed. The result was a main process that could be
// running the update check, a thousand-entry Kitsu crawl, the anime
// franchise-grouping pass, a Simkl watch-history reconcile and one
// unbounded `metadata()` fetch per tracked title all at the same moment —
// each of them individually reasonable, collectively enough to stop the
// main thread answering the OS and put "(Not Responding)" in the title bar.
//
// Everything that reaches the network or does bulk work on behalf of the
// app now goes through schedule() instead, which gives four things no
// amount of per-caller politeness pacing could:
//
//   1. A hierarchy. Work is tagged with what it is FOR, not how big it is:
//      `interactive` (someone is looking at a spinner), `visible` (the
//      screen that is open needs it), `background` (keeping data true),
//      `maintenance` (nice to have, some day). Lower tiers stand down
//      while a higher tier is waiting rather than competing with it.
//   2. Real concurrency limits — globally, per tier, and per upstream
//      (a "lane"), so a burst aimed at Kitsu can't also starve Simkl and
//      no burst at all can saturate the event loop.
//   3. Coalescing. Two callers asking for the same thing at the same time
//      (which is exactly what catalog:list and home:personalized did on
//      every cold start) get one piece of work and share its result.
//   4. Backpressure. Playback, or a window nobody can see, lowers the
//      whole system's ceiling instead of every job having to remember to
//      check for itself.
//
// Deliberately dependency-free (no electron, no logger import) so it can be
// unit-tested directly with tsx — see tests/taskScheduler.test.ts. Callers
// report their own failures; this module only decides when work runs.

export type TaskPriority = 'interactive' | 'visible' | 'background' | 'maintenance'

export const PRIORITY_RANK: Record<TaskPriority, number> = {
  interactive: 0,
  visible: 1,
  background: 2,
  maintenance: 3
}

/**
 * How loaded the app is right now, as the highest level any registered
 * source is reporting. Sources are named (see setPressure) so two of them
 * raising and lowering independently can't clobber each other.
 *
 *  - `idle`     nothing special is happening; the full budget is available.
 *  - `busy`     the person is actively driving the app, or it is still
 *               starting up. Maintenance stops entirely, background halves.
 *  - `critical` playback is running. Everything that isn't someone waiting
 *               on a spinner gets out of the way — mpv and the stream cache
 *               need the main thread and the bandwidth far more than a
 *               franchise-grouping pass does.
 */
export type SchedulerPressure = 'idle' | 'busy' | 'critical'

const PRESSURE_RANK: Record<SchedulerPressure, number> = { idle: 0, busy: 1, critical: 2 }

/** Total tasks allowed to run at once, per pressure level. */
const GLOBAL_BUDGET: Record<SchedulerPressure, number> = { idle: 12, busy: 8, critical: 4 }

/** Per-tier ceilings. A tier at 0 is suspended, not merely slowed. */
const TIER_BUDGET: Record<SchedulerPressure, Record<TaskPriority, number>> = {
  idle: { interactive: 8, visible: 6, background: 4, maintenance: 2 },
  busy: { interactive: 8, visible: 5, background: 2, maintenance: 0 },
  critical: { interactive: 4, visible: 2, background: 1, maintenance: 0 }
}

export interface LaneConfig {
  /** Tasks from this lane allowed to run at once. */
  concurrency: number
  /** Minimum gap between two dispatches out of this lane. This is the
   *  politeness pacing the crawlers used to implement with their own
   *  `await sleep(350)` between batches — expressed once, here, where it
   *  applies to every caller of that upstream rather than only the one
   *  that remembered to sleep. */
  minGapMs?: number
}

// One lane per upstream, sized to what that API tolerates rather than to
// what this app would like. `local` covers work that touches only disk or
// CPU (SQLite, JSON of a whole catalog) — kept deliberately narrow because
// that work runs ON the main thread and is precisely what a blocked window
// is made of.
const LANES: Record<string, LaneConfig> = {
  kitsu: { concurrency: 5, minGapMs: 120 },
  simkl: { concurrency: 3, minGapMs: 150 },
  cinemeta: { concurrency: 4, minGapMs: 80 },
  // ~24 requests/minute sustained, under AniList's confirmed 30/min
  // ceiling with headroom for their limit being per-IP and shared with
  // whatever else is running on the machine. Serial, because two
  // concurrent requests inside one gap is a burst of two.
  anilist: { concurrency: 1, minGapMs: 2_500 },
  tmdb: { concurrency: 4, minGapMs: 60 },
  mal: { concurrency: 2, minGapMs: 300 },
  omdb: { concurrency: 2, minGapMs: 200 },
  torbox: { concurrency: 4, minGapMs: 50 },
  update: { concurrency: 1 },
  local: { concurrency: 2 },
  default: { concurrency: 4 }
}

const DEFAULT_LANE: LaneConfig = { concurrency: 4 }

/** Host fragment -> lane. A substring match, so `data.simkl.in` and
 *  `api.simkl.com` both land in the same bucket without listing every
 *  subdomain an upstream might answer on. */
const LANE_HOSTS: [string, string][] = [
  ['kitsu.io', 'kitsu'],
  ['simkl', 'simkl'],
  ['cinemeta', 'cinemeta'],
  ['strem.io', 'cinemeta'],
  ['anilist.co', 'anilist'],
  ['themoviedb.org', 'tmdb'],
  ['tmdb.org', 'tmdb'],
  ['myanimelist.net', 'mal'],
  ['omdbapi.com', 'omdb'],
  ['torbox.app', 'torbox']
]

/** Which lane an upstream URL belongs to. Callers that already know
 *  (a job that is not a single request) can pass a lane name directly. */
export function laneForUrl(url: string | URL): string {
  let host: string
  try {
    host = new URL(String(url)).hostname.toLowerCase()
  } catch {
    return 'default'
  }
  for (const [fragment, lane] of LANE_HOSTS) if (host.includes(fragment)) return lane
  return 'default'
}

/**
 * A task that has waited this long stops respecting the stand-down rule
 * below (it still respects tier and lane limits). Without this, a steady
 * drip of interactive work — which is what an app someone is actually
 * using looks like — could keep the background tier permanently parked and
 * the watch-history sync would simply never happen.
 */
const STARVATION_MS = 60_000

/** Tiers at or below this rank yield to anything more important that is
 *  already waiting, instead of racing it for the remaining slots. */
const YIELDING_RANK = PRIORITY_RANK.background

export interface ScheduleOptions {
  /** What this work is for. Drives the hierarchy — see TaskPriority. */
  priority?: TaskPriority
  /** Which upstream's budget this spends. Derive it from a URL with
   *  `laneForUrl` when the task is one request. Defaults to `default`. */
  lane?: string
  /** Coalescing key. A second schedule() with the same key, while the
   *  first is still queued or running, joins it and shares its result
   *  rather than starting a second copy of the same work. */
  key?: string
  /** Shown in the activity snapshot. Defaults to the key, then the lane. */
  label?: string
  /** Set `false` to leave an already-queued task with the same `key` at
   *  the priority it was queued with. The default promotes it — the case
   *  where a background prefetch is already in flight and then someone
   *  opens the page that is waiting on it. Ignored without a key. */
  promote?: boolean
}

interface QueuedTask {
  id: number
  key: string | null
  label: string
  lane: string
  priority: TaskPriority
  enqueuedAt: number
  start: () => void
}

interface RunningTask {
  id: number
  key: string | null
  label: string
  lane: string
  priority: TaskPriority
  startedAt: number
}

let nextId = 1
const queue: QueuedTask[] = []
const running = new Map<number, RunningTask>()
const inFlightByKey = new Map<string, Promise<unknown>>()
const queuedByKey = new Map<string, QueuedTask>()
const laneLastDispatch = new Map<string, number>()
const pressureSources = new Map<string, SchedulerPressure>()

let pumpTimer: ReturnType<typeof setTimeout> | null = null
let pumping = false
let changeListener: (() => void) | null = null

function laneConfig(lane: string): LaneConfig {
  return LANES[lane] ?? DEFAULT_LANE
}

function runningInLane(lane: string): number {
  let n = 0
  for (const task of running.values()) if (task.lane === lane) n++
  return n
}

function runningInTier(priority: TaskPriority): number {
  let n = 0
  for (const task of running.values()) if (task.priority === priority) n++
  return n
}

export function currentPressure(): SchedulerPressure {
  let level: SchedulerPressure = 'idle'
  for (const value of pressureSources.values()) {
    if (PRESSURE_RANK[value] > PRESSURE_RANK[level]) level = value
  }
  return level
}

/**
 * Raises or lowers the app-wide backpressure from one named source.
 * Sources are independent — playback reporting `critical` and the window
 * reporting `idle` resolves to `critical`, and playback ending puts it
 * back without the window having to say anything. Pass `idle` to release.
 */
export function setPressure(source: string, level: SchedulerPressure): void {
  const previous = currentPressure()
  if (level === 'idle') pressureSources.delete(source)
  else pressureSources.set(source, level)
  if (currentPressure() !== previous) {
    notifyChange()
    schedulePump(0)
  }
}

/** Called whenever the running/queued set changes, so the renderer's
 *  activity view can be pushed rather than polled. Set once at wiring
 *  time; see backgroundJobs.ts. */
export function onSchedulerChange(listener: (() => void) | null): void {
  changeListener = listener
}

let notifyQueued = false
function notifyChange(): void {
  if (!changeListener || notifyQueued) return
  // Coalesced to the end of the current turn: a pump that dispatches six
  // tasks is one change as far as anyone watching is concerned, not six.
  notifyQueued = true
  queueMicrotask(() => {
    notifyQueued = false
    changeListener?.()
  })
}

/** Sorts queued work into the order it should be considered: most
 *  important first, and oldest first within a tier so nothing at the same
 *  importance jumps a queue it joined later. */
function compareTasks(a: QueuedTask, b: QueuedTask): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.enqueuedAt - b.enqueuedAt
}

function schedulePump(delayMs: number): void {
  if (pumpTimer) clearTimeout(pumpTimer)
  // Deliberately NOT unref'd. An unref'd wake-up is one Node is free to
  // skip if it is the last handle standing, which silently abandons
  // everything still queued behind it. Work that has been accepted is
  // seen through instead, and shutdownScheduler() — wired to the app's
  // before-quit — is what stops it, rather than a timer flag that also
  // happens to drop work mid-session.
  pumpTimer = setTimeout(
    () => {
      pumpTimer = null
      pump()
    },
    Math.max(0, delayMs)
  )
}

function pump(): void {
  // A task that settles synchronously would otherwise re-enter this
  // mid-scan and dispatch against a queue it is in the middle of editing.
  if (pumping) return
  pumping = true
  try {
    dispatchLoop()
  } finally {
    pumping = false
  }
}

function dispatchLoop(): void {
  const pressure = currentPressure()
  const globalBudget = GLOBAL_BUDGET[pressure]
  const tierBudget = TIER_BUDGET[pressure]
  const now = Date.now()

  queue.sort(compareTasks)

  // The most important thing anybody is waiting for. Tiers at or below
  // YIELDING_RANK stand down while something above them is still queued,
  // which is the actual "hierarchy" — not merely a smaller share of the
  // slots, but genuinely getting out of the way.
  const mostImportantQueued = queue.length ? PRIORITY_RANK[queue[0].priority] : Infinity

  // The earliest moment a task that was skipped this pass could become
  // eligible purely by the clock — a lane's politeness gap expiring, or a
  // stood-down task reaching its starvation cutoff. Skips that are only
  // about capacity (tier full, lane full, global full) deliberately do NOT
  // set this: the completion that frees the slot pumps us, so polling for
  // it would be a timer that never stops firing while anything is queued.
  let earliestRetryAt = Infinity

  for (let i = 0; i < queue.length;) {
    if (running.size >= globalBudget) break
    const task = queue[i]
    const rank = PRIORITY_RANK[task.priority]
    const starving = now - task.enqueuedAt >= STARVATION_MS

    if (rank >= YIELDING_RANK && mostImportantQueued < rank && !starving) {
      earliestRetryAt = Math.min(earliestRetryAt, task.enqueuedAt + STARVATION_MS)
      i++
      continue
    }
    if (runningInTier(task.priority) >= tierBudget[task.priority]) {
      i++
      continue
    }
    const lane = laneConfig(task.lane)
    if (runningInLane(task.lane) >= lane.concurrency) {
      i++
      continue
    }
    if (lane.minGapMs) {
      const readyAt = (laneLastDispatch.get(task.lane) ?? 0) + lane.minGapMs
      if (readyAt > now) {
        earliestRetryAt = Math.min(earliestRetryAt, readyAt)
        i++
        continue
      }
    }

    queue.splice(i, 1)
    if (task.key) queuedByKey.delete(task.key)
    laneLastDispatch.set(task.lane, now)
    running.set(task.id, {
      id: task.id,
      key: task.key,
      label: task.label,
      lane: task.lane,
      priority: task.priority,
      startedAt: now
    })
    task.start()
    // Deliberately no `i++`: the splice already moved the next candidate
    // into this index.
  }

  if (earliestRetryAt !== Infinity) schedulePump(earliestRetryAt - now)
  notifyChange()
}

function finish(id: number): void {
  running.delete(id)
  notifyChange()
  // Synchronously rather than via schedulePump, so a chain of small tasks
  // doesn't pay a timer hop each — but through pump()'s re-entry guard, so
  // a task that settles during dispatchLoop can't recurse into it.
  if (pumping) schedulePump(0)
  else pump()
}

/**
 * Queues `run` and resolves with its result. This is the way work should
 * reach the network, or do bulk local work, in the main process.
 *
 * Rejections propagate to the caller untouched — the scheduler decides
 * *when* something runs, never what its failure means.
 */
export function schedule<T>(run: () => Promise<T> | T, options: ScheduleOptions = {}): Promise<T> {
  const key = options.key ?? null
  const priority = options.priority ?? 'background'

  if (key) {
    const existing = inFlightByKey.get(key)
    if (existing) {
      // Already running, or queued. Either way the caller wants the same
      // answer, so it joins rather than starting a second copy.
      const pending = queuedByKey.get(key)
      if (pending && options.promote !== false) {
        // A prefetch someone is now actually waiting for gets pulled up
        // the queue instead of finishing on its original, lazier schedule.
        if (PRIORITY_RANK[priority] < PRIORITY_RANK[pending.priority]) {
          pending.priority = priority
          schedulePump(0)
        }
      }
      return existing as Promise<T>
    }
  }

  const id = nextId++
  const lane = options.lane ?? 'default'
  const label = options.label ?? key ?? lane

  let startTask!: () => void
  const promise = new Promise<T>((resolve, reject) => {
    startTask = () => {
      // The task body runs outside this executor: a throw from `run()`
      // itself (not from the promise it returns) must reject this
      // promise rather than escape into the pump.
      void (async () => {
        try {
          resolve(await run())
        } catch (error) {
          reject(error)
        } finally {
          finish(id)
        }
      })()
    }
  })

  const task: QueuedTask = {
    id,
    key,
    label,
    lane,
    priority,
    enqueuedAt: Date.now(),
    start: startTask
  }

  if (key) {
    queuedByKey.set(key, task)
    inFlightByKey.set(key, promise)
    // Cleared on settle either way — a failed catalog fetch must not pin
    // its own rejection in the coalescing map and hand it to every future
    // caller of the same key.
    void promise
      .catch(() => {})
      .finally(() => {
        if (inFlightByKey.get(key) === promise) inFlightByKey.delete(key)
        if (queuedByKey.get(key) === task) queuedByKey.delete(key)
      })
  }

  queue.push(task)
  pump()
  return promise
}

// ---------------------------------------------------------------------------
// Composite work
//
// schedule() above is for LEAF work — one request, one bulk local job.
// Something that occupies a worker slot and, while it holds it, does not
// wait on anything else that also needs one.
//
// A composite (catalogData crawling fifty pages, metadata() fetching a
// record plus its categories plus its episode list) must NOT go through
// schedule(): it would hold a slot for its whole lifetime while the leaf
// requests it is waiting on queue for the same budget. Three of those at
// once against a tier ceiling of two is a deadlock that only breaks when
// the pressure level happens to change.
//
// So composites get the two things they actually need — not being run
// twice over, and not all starting at once — from the two helpers below,
// neither of which takes a worker slot. The rule is: schedule the leaves,
// coalesce the composites.
// ---------------------------------------------------------------------------

const compositeByKey = new Map<string, Promise<unknown>>()

/**
 * Single-flight for composite work. A second call with the same key, while
 * the first is still running, joins it and shares its result.
 *
 * This is what stops catalog:list and home:personalized — which both ask
 * for all three catalogs, and which the renderer fires within a few
 * milliseconds of each other on every cold start — from running two full
 * Kitsu crawls side by side and each writing the result over the other's.
 *
 * Deliberately does not occupy a worker slot: the leaf requests inside
 * `run` are the things that are scheduled, and a composite waiting on its
 * own children for a slot it is holding is a deadlock.
 */
export function coalesce<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = compositeByKey.get(key)
  if (existing) return existing as Promise<T>

  const promise = (async () => run())()
  compositeByKey.set(key, promise)
  // Released on settle either way — a failed crawl must not pin its own
  // rejection under this key and hand it back to every later caller.
  void promise
    .catch(() => {})
    .finally(() => {
      if (compositeByKey.get(key) === promise) compositeByKey.delete(key)
    })
  return promise
}

/** How many composite operations may be in flight at once by default. The
 *  point is not socket count (the leaf scheduler owns that) but everything
 *  that happens around the requests: a composite's synchronous prologue —
 *  a SQLite read and a JSON.parse of a cached record, in metadata()'s case
 *  — runs on the main thread, and two hundred of those back to back is its
 *  own visible stall regardless of how politely the fetches behind them
 *  are paced. */
const DEFAULT_COMPOSITE_LIMIT = 6

/**
 * Runs `items` through `worker`, at most `limit` at a time — the bounded
 * replacement for the `Promise.all(items.map(...))` fan-outs that started
 * one metadata resolve per tracked title all at once, twice over
 * (tracking:list and home:personalized each did it).
 *
 * Order is preserved. A worker that rejects yields `null` for that item
 * rather than failing the batch, because every call site of this shape
 * already treated a per-item failure that way.
 */
export async function mapWithLimit<TIn, TOut>(
  items: readonly TIn[],
  worker: (item: TIn, index: number) => Promise<TOut>,
  limit = DEFAULT_COMPOSITE_LIMIT
): Promise<(TOut | null)[]> {
  const results: (TOut | null)[] = new Array(items.length).fill(null)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      try {
        results[index] = await worker(items[index], index)
      } catch {
        // Left as null — see the doc comment.
      }
    }
  })
  await Promise.all(workers)
  return results
}

export interface SchedulerSnapshot {
  pressure: SchedulerPressure
  running: { label: string; lane: string; priority: TaskPriority; startedAt: number }[]
  queued: number
  queuedByPriority: Record<TaskPriority, number>
}

/** What the scheduler is doing right now — for the renderer's activity
 *  view, and the first thing to look at when the app feels slow. */
export function schedulerSnapshot(): SchedulerSnapshot {
  const queuedByPriority: Record<TaskPriority, number> = {
    interactive: 0,
    visible: 0,
    background: 0,
    maintenance: 0
  }
  for (const task of queue) queuedByPriority[task.priority]++
  return {
    pressure: currentPressure(),
    running: [...running.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(({ label, lane, priority, startedAt }) => ({ label, lane, priority, startedAt })),
    queued: queue.length,
    queuedByPriority
  }
}

/**
 * Stops accepting work and drops whatever is still queued — wired to the
 * app's before-quit. Anything already running is left to settle (nothing
 * here can cancel an in-flight fetch), but nothing new is dispatched, so
 * a pending crawl can't hold the process open past the point the person
 * asked it to close.
 */
export function shutdownScheduler(): void {
  queue.length = 0
  queuedByKey.clear()
  compositeByKey.clear()
  if (pumpTimer) clearTimeout(pumpTimer)
  pumpTimer = null
  changeListener = null
}

/** Test seam — drops all queued work and every pressure source. Running
 *  tasks are left to settle on their own; nothing here can cancel work
 *  that has already started. */
export function resetSchedulerForTests(): void {
  queue.length = 0
  queuedByKey.clear()
  inFlightByKey.clear()
  compositeByKey.clear()
  laneLastDispatch.clear()
  pressureSources.clear()
  if (pumpTimer) clearTimeout(pumpTimer)
  pumpTimer = null
}
