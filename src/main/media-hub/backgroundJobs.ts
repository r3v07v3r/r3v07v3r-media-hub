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
import { sendToRenderer, notifyLibraryChanged } from './rendererBridge'
import { catalogData, deepScanChunk } from './catalog'
import { enrichCredits } from './credits'
import { getDatabase } from './dbState'
import { logError } from './logger'
import { runNewEpisodeCheck } from './notifications'
import { pruneIdleSessions } from './streamCache'
import { runLanCacheFeeder } from './lanCacheFeeder'
import { runLanCacheTitleSync } from './lanCacheTitleSync'
import { runBackgroundWatchSync } from './tracking'
import {
  onRebuildRequested,
  rebuildRecommendations,
  requestRecommendationsRebuild
} from './recommendations'
import { repairAnimeSyncIds } from './animeSyncRepair'
import { checkForUpdates } from './autoUpdate'
import {
  coalesce,
  currentPressure,
  onSchedulerChange,
  schedulerSnapshot,
  type SchedulerPressure,
  type TaskPriority
} from './taskScheduler'
import { isLanCacheConnected } from './lanCache'

/** How often the registry looks at what is due. One timer for every
 *  recurring job in the app. Coarse on purpose — nothing here is
 *  time-critical to the second, and a tick that costs nothing is a tick
 *  that can afford to be the only one. */
const HEARTBEAT_MS = 30_000

/** How many titles one credits-enrichment run may look up. See the job itself. */
const CREDITS_PER_PASS = 60

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

/**
 * Brings one job's next run forward, for work that has a reason to happen
 * rather than a time to happen.
 *
 * Everything in this registry is on a clock, which is right for the jobs
 * that genuinely are periodic — a catalog goes stale on its own schedule,
 * an update might land at any time. It is wrong for work whose whole
 * trigger is that something changed: the suggestion list has no reason to
 * be rebuilt on a timer and every reason to be rebuilt when somebody
 * finishes an episode.
 *
 * Deliberately "at the next heartbeat", not "now". Three things fall out
 * of that, all of them wanted:
 *
 *  - it debounces for free. Marking a whole season watched is one rebuild,
 *    not one per episode, because they all land inside one 30s window;
 *  - the caller is a click somebody is waiting on, and this returns
 *    instantly instead of putting a re-rank in front of them;
 *  - the run still passes the pressure gate in tick(), so a request made
 *    while something is playing waits for the playback to end rather than
 *    competing with it.
 *
 * A job already due is left as it is. A job already RUNNING is not skipped
 * either, and that matters more than it looks: tick() stamps the next due
 * time when a run STARTS, so a change made while a rebuild is in flight
 * would otherwise be invisible to that run and wait out the full interval
 * before the next one. Marking it due again instead means the run in
 * progress finishes, and the following heartbeat starts a fresh one that
 * can see the change. The `running` flag in tick() is still what stops two
 * from overlapping.
 */
export function requestJobRun(name: string): void {
  const state = jobs.find((entry) => entry.job.name === name)
  if (!state) return
  const now = Date.now()
  if (state.dueAt <= now) return
  state.dueAt = now
  // So the activity panel shows it as due immediately, rather than still
  // counting down to a time that no longer applies.
  onActivityChanged()
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
    name: 'new-episodes',
    label: 'Checking for new episodes',
    // Six-hourly. Air dates land on a day, not a minute, and something out
    // this morning is no less out this afternoon — checking more often would
    // be a metadata pass per hour to tell somebody something they will hear
    // either way.
    everyMs: 6 * 60 * 60 * 1000,
    // Well after launch, and after the catalog refresh above has had a chance
    // to fill the metadata this reads. On a cold start it would otherwise be
    // the thing that triggers every one of those fetches itself.
    firstRunAfterMs: 10 * 60 * 1000,
    priority: 'maintenance',
    // Deferred rather than skipped while something is playing, like everything
    // else here — a notification is the last thing anybody wants mid-film, and
    // it will still be true afterwards.
    maxPressure: 'idle',
    run: runNewEpisodeCheck
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

  // The whole library, without a button. The deep scan was a press on the
  // library page — one chunk of the upstream catalog per press, a resumable
  // bookmark, an honest 'exhausted' at the end — which meant most people
  // never got past the standing crawl's depth. The same chunk now runs on
  // its own, one kind at a time, only when nothing else is going on, until
  // upstream has no more to give; a press still works and simply joins it.
  // Skipped while a household cache server is paired: its own crawl feeds
  // this index for every device in the house (lanCacheTitleSync), and a
  // second walk of the same pages from each device would be waste.
  registerRecurringJob({
    name: 'catalog-deep-scan',
    label: 'Reading more of the catalog',
    everyMs: 60 * 60 * 1000,
    firstRunAfterMs: 15 * 60 * 1000,
    priority: 'maintenance',
    maxPressure: 'idle',
    run: async () => {
      if (isLanCacheConnected()) return
      let grew = false
      for (const kind of ['movie', 'series', 'anime'] as const) {
        try {
          // The job's own lane, not the button's: 'maintenance' is what
          // critical pressure suspends, so playback starting mid-scan
          // pauses the remaining pages instead of sharing the process
          // with them — see deepScanChunk.
          const report = await deepScanChunk(kind, 'maintenance')
          if (report.added > 0) grew = true
        } catch (error) {
          logError('job:deep-scan', error)
        }
      }
      if (grew) notifyLibraryChanged('deep-scan', 'index')
    }
  })

  registerRecurringJob({
    name: 'anime-sync-repair',
    label: 'Repairing anime watch history',
    // A recurring job for work that happens at most once, because what it
    // is really waiting for is the anime-grouping pass, and there is no
    // event to hang that on — see animeSyncRepair.ts. Every run after the
    // repair lands is one settings read that returns immediately.
    //
    // Hourly rather than tighter for the same reason: on the one launch
    // where it has something to do, grouping takes minutes, so the cost of
    // arriving late is that the repair happens on the NEXT launch instead
    // — invisible either way, since the rows have already been wrong for
    // however long the person has had the old build.
    everyMs: 60 * 60 * 1000,
    // After catalog-refresh's own first run, so on an install whose
    // catalog is cold the grouping pass it kicks off has already had a
    // chance to finish.
    firstRunAfterMs: 7 * 60 * 1000,
    priority: 'maintenance',
    // It rewrites rows the detail page and every badge read, so it waits
    // for a quiet moment rather than doing that underneath somebody.
    maxPressure: 'idle',
    run: async () => {
      const result = repairAnimeSyncIds()
      // The ranking is derived from watch history, and rows have just
      // moved. The renderer has no equivalent hook — there is no
      // main-to-renderer "history changed" broadcast (the Trakt import
      // gets away without one because the renderer refreshes when its own
      // call returns) — so the grids pick this up the next time they
      // fetch, which for a pass that runs once, at idle, minutes into a
      // session is the next navigation or the next launch.
      if (result.repaired) requestRecommendationsRebuild()
    }
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
    name: 'lancache-feeder',
    label: 'Warming the cache server',
    // Half-hourly: pre-fetching is by definition not urgent, and the
    // daemon downloads one file at a time regardless. What this cadence
    // really bounds is how soon after "track" a title starts arriving
    // on-site.
    everyMs: 30 * 60 * 1000,
    firstRunAfterMs: 4 * 60 * 1000,
    priority: 'background',
    // Deferred during playback like everything else: the scraper calls and
    // the daemon's own TorBox download both compete for the bandwidth the
    // person watching is using.
    maxPressure: 'busy',
    run: runLanCacheFeeder
  })

  registerRecurringJob({
    name: 'lancache-title-sync',
    label: 'Syncing the household title index',
    // Hourly: the daemon re-crawls six-hourly, so most passes are one page
    // of nothing per kind. What this cadence bounds is how soon a freshly
    // paired device inherits the household's depth.
    everyMs: 60 * 60 * 1000,
    firstRunAfterMs: 2 * 60 * 1000,
    priority: 'background',
    maxPressure: 'busy',
    run: async () => {
      await runLanCacheTitleSync()
    }
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

  registerRecurringJob({
    name: 'recommendations',
    label: 'Updating your suggestions',
    // The ranking itself is milliseconds; what this cadence really paces
    // is how often the stored list is allowed to drift from a catalog
    // that only moves every six hours anyway (see catalog-refresh above).
    // Between these runs, the event-driven requests below are what keep
    // it current — this interval is the floor, not the mechanism.
    everyMs: 6 * 60 * 60 * 1000,
    // After catalog-refresh's own first run, so the first rebuild of a
    // session ranks over rows that job has already had a chance to renew
    // rather than re-ranking and then immediately being out of date.
    firstRunAfterMs: 6 * 60 * 1000,
    priority: 'maintenance',
    maxPressure: 'busy',
    run: async () => {
      await rebuildRecommendations('maintenance')
    }
  })

  registerRecurringJob({
    name: 'credits-enrichment',
    label: 'Learning what you like',
    // Often, because each run is deliberately small. A full pass over this
    // app's catalog and watch history is roughly four thousand titles, and
    // doing it in one burst would be a long run of requests against two
    // APIs for a ranking improvement nobody is waiting on. Sixty titles
    // every half hour gets there over a few sessions and is invisible
    // while it does — which is the point.
    everyMs: 30 * 60 * 1000,
    firstRunAfterMs: 8 * 60 * 1000,
    priority: 'maintenance',
    // The only job in this registry held to `idle`. Everything else here
    // is either quick or genuinely due; this one is pure background
    // improvement with no deadline of any kind, so it has no business
    // running while the app is under any load at all.
    maxPressure: 'idle',
    run: async () => {
      const history = getDatabase().history()
      const catalogs = await Promise.all(
        (['movie', 'series', 'anime'] as const).map((kind) =>
          catalogData(kind, false, 'maintenance').catch(() => [])
        )
      )
      // Watch history first. Those titles are what the taste profile is
      // built FROM, so covering them is what makes the whole signal work
      // at all — a fully enriched catalog with an unenriched history has
      // nothing to compare against and changes no ranking.
      const filled = await enrichCredits(
        [
          ...history.map((entry) => ({ id: String(entry.id), type: entry.type })),
          ...catalogs.flat()
        ],
        CREDITS_PER_PASS,
        'maintenance'
      )
      if (filled) sendToRenderer(MEDIA_HUB_CHANNELS.activityChanged, activitySnapshot())
    }
  })

  // What turns "I just finished an episode" into a rebuild. Deliberately
  // routed through the registry rather than run at the call site: this way
  // a rebuild obeys the same pressure gate and the same never-twice-at-
  // once rule as every other recurring job, instead of being the one piece
  // of background work that can start while something is playing.
  onRebuildRequested(() => requestJobRun('recommendations'))

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
  // Or a request arriving during shutdown re-arms a job list that is
  // about to be emptied, against a database before-quit is closing.
  onRebuildRequested(null)
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
