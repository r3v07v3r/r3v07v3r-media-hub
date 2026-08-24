// The app's recurring background work, in one place, on one clock.
//
// This is the other half of taskScheduler.ts. That module decides which
// piece of work runs next when several want to run at once; this one
// decides when work should want to run at all — and, more to the point,
// puts every recurring job in the app under a single heartbeat instead of
// each one owning a private setInterval that fires on its own schedule
// with no idea the others exist.
//
// What that used to look like, spread across four files: the update check
// fired 10s after launch and every 6h after that; the idle stream-cache
// sweep fired at startup and every hour; the anime franchise-grouping pass
// fired 15s after any anime catalog fetch; the watch-history reconcile
// fired 8s after the renderer mounted. Nothing coordinated them, so
// whether they collided was down to how long the person's last session
// happened to be. Two of them landing together during the opening seconds
// of a cold start — which is exactly when the catalogs are being crawled —
// is a main process that has stopped answering the OS.
//
// Now there is one 30-second tick. It knows what is due, what is already
// running, and what the app is currently under (see SchedulerPressure), so
// a job that is not worth doing right now simply is not started rather
// than being started and then competing. Nothing here bypasses the
// scheduler: a job's actual requests still queue in their upstream's lane
// at the job's own tier, so "due" never means "immediately, ahead of the
// person using the app".

import type { ActivitySnapshot } from '../../shared/media-hub/types'
import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import { handle } from './ipcGuard'
import { sendToRenderer } from './rendererBridge'
import { catalogData } from './catalog'
import { logError } from './logger'
import { pruneIdleSessions } from './streamCache'
import { runBackgroundWatchSync } from './tracking'
import { checkForUpdates } from './autoUpdate'
import {
  coalesce,
  currentPressure,
  onSchedulerChange,
  schedulerSnapshot,
  type SchedulerPressure,
  type TaskPriority
} from './taskScheduler'

/** How often the registry looks at what is due. One timer for every
 *  recurring job in the app. Coarse on purpose — nothing here is
 *  time-critical to the second, and a tick that costs nothing is a tick
 *  that can afford to be the only one. */
const HEARTBEAT_MS = 30_000

const PRESSURE_RANK: Record<SchedulerPressure, number> = { idle: 0, busy: 1, critical: 2 }

export interface RecurringJob {
  /** Stable id. Also the coalescing key, so a slow run can never be
   *  started a second time by the next tick. */
  name: string
  /** Shown in the activity view. */
  label: string
  everyMs: number
  /** How long after startup the first run may happen. Deliberately not
   *  zero for anything: the opening seconds of a launch belong to getting
   *  the app on screen. */
  firstRunAfterMs: number
  priority: TaskPriority
  /**
   * Highest app pressure this job will start under. A job past this level
   * is DEFERRED, not skipped — its due time is not advanced, so it runs at
   * the first tick after the pressure lifts rather than being silently
   * dropped for a whole interval because someone happened to be watching
   * something when it came due.
   */
  maxPressure: SchedulerPressure
  run: () => Promise<unknown>
}

interface JobState {
  job: RecurringJob
  dueAt: number
  running: boolean
}

const jobs: JobState[] = []
let heartbeat: ReturnType<typeof setInterval> | null = null

/**
 * Spreads the first run of each job out instead of letting them all come
 * due on the same tick. Derived from the job's position in the registry
 * rather than from a random number, so the stagger is the same every
 * launch and a slow start is reproducible rather than occasionally.
 */
function stagger(index: number): number {
  return index * 20_000
}

export function registerRecurringJob(job: RecurringJob): void {
  jobs.push({
    job,
    dueAt: Date.now() + job.firstRunAfterMs + stagger(jobs.length),
    running: false
  })
}

function tick(): void {
  const now = Date.now()
  const pressure = PRESSURE_RANK[currentPressure()]

  for (const state of jobs) {
    if (state.running || now < state.dueAt) continue
    // Deferred, not skipped — dueAt is deliberately left where it is.
    if (pressure > PRESSURE_RANK[state.job.maxPressure]) continue

    state.running = true
    // The interval is measured from the START of a run, not its end, so a
    // job that takes twenty minutes does not then wait its full interval
    // on top of that. The `running` flag is what stops a run overlapping
    // itself when the work outlasts its own interval.
    state.dueAt = now + state.job.everyMs
    // Announced here, and again when it settles, rather than left to the
    // scheduler's own change events. A job that finds a warm cache does
    // no scheduled work at all — which, now that the catalog refresh
    // honours the cache, is the common case — so nothing else would ever
    // tell the activity panel this happened, and it would sit showing a
    // job as due "now" forever while it was quietly running on time.
    onActivityChanged()
    void coalesce(`job:${state.job.name}`, () => state.job.run())
      .catch((error) => logError(`job:${state.job.name}`, error))
      .finally(() => {
        state.running = false
        onActivityChanged()
      })
  }
}

/** Starts the heartbeat. Call once, from main-process startup, after the
 *  database exists — several of these jobs read it on their first run. */
export function startBackgroundJobs(): void {
  if (heartbeat) return

  registerRecurringJob({
    name: 'catalog-refresh',
    label: 'Refreshing the catalogs',
    // Hourly, against a cache with a 6h TTL — so this is a cheap check
    // that mostly finds nothing (three SQLite reads) and picks the crawl
    // up within an hour of the entry actually going stale, in the
    // background, rather than leaving it for whoever next opens a page.
    //
    // The pairing matters: an interval EQUAL to the TTL would check once
    // per lifetime of an entry and, landing just before an expiry, would
    // miss it by a minute and leave the next person to pay for the crawl.
    everyMs: 60 * 60 * 1000,
    // Long enough after launch that the on-demand fetches the renderer
    // makes on its own have already been served, and their results cached
    // — so this job usually finds nothing to do at all on a cold start.
    firstRunAfterMs: 5 * 60 * 1000,
    priority: 'maintenance',
    maxPressure: 'busy',
    run: async () => {
      for (const kind of ['movie', 'series', 'anime'] as const) {
        // Sequential, not Promise.all. There is no deadline here, and
        // three crawls at once is three crawls competing for the same
        // budget for no gain — the whole point of this job existing is
        // that nobody is waiting for it.
        //
        // NOT forced. Forcing would bypass the 6h cache the renderer
        // filled moments earlier and re-crawl all three catalogs — two
        // thousand anime titles among them — on every session that lasts
        // long enough to see this job fire, plus another franchise
        // grouping pass on top. Honouring the cache is what makes this a
        // refresh rather than a periodic re-download.
        await catalogData(kind, false, 'maintenance').catch((error) =>
          logError(`job:catalog-refresh:${kind}`, error)
        )
      }
    }
  })

  registerRecurringJob({
    name: 'watch-sync',
    label: 'Syncing watch history',
    everyMs: 30 * 60 * 1000,
    firstRunAfterMs: 3 * 60 * 1000,
    priority: 'background',
    maxPressure: 'busy',
    run: runBackgroundWatchSync
  })

  registerRecurringJob({
    name: 'update-check',
    label: 'Checking for updates',
    everyMs: 6 * 60 * 60 * 1000,
    // Was 10 seconds after the updater was wired up, which put an update
    // download in direct competition with the first catalog crawl on every
    // cold start. Nothing about an update is urgent enough to be the
    // second thing the app does.
    firstRunAfterMs: 2 * 60 * 1000,
    priority: 'maintenance',
    // An update DOWNLOAD is electron-updater's own business once a check
    // finds one, and it is bandwidth the person watching something would
    // rather have. Checks stay off entirely during playback.
    maxPressure: 'busy',
    run: async () => checkForUpdates()
  })

  registerRecurringJob({
    name: 'cache-prune',
    label: 'Tidying the stream cache',
    everyMs: 60 * 60 * 1000,
    firstRunAfterMs: 10 * 60 * 1000,
    priority: 'maintenance',
    // Disk hygiene for sessions that are by definition not the one
    // playing. Never worth doing while something is.
    maxPressure: 'busy',
    run: pruneIdleSessions
  })

  heartbeat = setInterval(tick, HEARTBEAT_MS)
}

/** Stops the heartbeat — wired to the app's before-quit alongside
 *  shutdownScheduler(). A job already in flight is left to settle. */
export function stopBackgroundJobs(): void {
  if (heartbeat) clearInterval(heartbeat)
  heartbeat = null
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = null
  onSchedulerChange(null)
  jobs.length = 0
}

/** Everything the work manager is doing, in one payload — what is running
 *  now, what is queued behind it, and when each recurring job is next due.
 *  So "why does the app feel busy" and "why has nothing synced" both have
 *  an answer that does not require reading this file. */
export function activitySnapshot(): ActivitySnapshot {
  return {
    ...schedulerSnapshot(),
    jobs: jobs.map((state) => ({
      name: state.job.name,
      label: state.job.label,
      dueAt: state.dueAt,
      running: state.running
    }))
  }
}

// The scheduler can change state many times a second while a crawl is
// dispatching. Pushing every one of those at the renderer would make an
// activity panel a source of the very jank it exists to explain, so
// changes are throttled to something a person can actually read.
const ACTIVITY_PUSH_INTERVAL_MS = 500
let lastPushAt = 0
let pushTimer: ReturnType<typeof setTimeout> | null = null

function pushActivity(): void {
  lastPushAt = Date.now()
  sendToRenderer(MEDIA_HUB_CHANNELS.activityChanged, activitySnapshot())
}

function onActivityChanged(): void {
  if (pushTimer) return
  const wait = Math.max(0, ACTIVITY_PUSH_INTERVAL_MS - (Date.now() - lastPushAt))
  // Trailing edge as well as leading: the change that matters most to
  // anyone watching is the last one — the queue going empty — and a
  // purely leading-edge throttle drops exactly that.
  pushTimer = setTimeout(() => {
    pushTimer = null
    pushActivity()
  }, wait)
}

/** Registers the activity IPC and starts pushing changes at the renderer. */
export function registerActivityIpc(): void {
  handle<undefined, ActivitySnapshot>(MEDIA_HUB_CHANNELS.activityGet, () => activitySnapshot())
  onSchedulerChange(onActivityChanged)
}
