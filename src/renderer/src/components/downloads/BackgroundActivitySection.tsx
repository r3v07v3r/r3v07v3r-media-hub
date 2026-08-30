// What the app's central work manager is doing, on the page that is
// already about work the app is doing on your behalf.
//
// This exists because "the app feels busy" was previously unanswerable
// from inside the app. Every background job ran on a private timer in the
// main process with no way to see it, so the only way to find out why a
// window had stopped responding was to read the source. Now the two
// questions that actually get asked — "what is it doing right now" and
// "why hasn't my watch history synced" — are both on screen.
//
// Pushed from main rather than polled: the scheduler tells the renderer
// when its state changes (throttled — see backgroundJobs.ts), so a panel
// nobody is looking at costs nothing at all.

import { useEffect, useState } from 'react'
import type { ActivityJob, ActivitySnapshot, ActivityTask } from '@shared/media-hub/types'
import styles from './BackgroundActivity.module.css'

/** Only refreshes the "next due in" countdowns. The running/queued half of
 *  this panel is push-driven and does not need a timer — but a job that is
 *  40 minutes out produces no scheduler events at all while it waits, so
 *  its countdown would otherwise sit frozen at whatever it read when the
 *  last unrelated push happened to arrive. */
const COUNTDOWN_TICK_MS = 10_000

const PRESSURE_COPY: Record<ActivitySnapshot['pressure'], string> = {
  idle: 'Idle — background work is running freely',
  busy: 'Busy — background work has been throttled',
  critical: 'Playing — background work is paused'
}

const PRIORITY_COPY: Record<ActivityTask['priority'], string> = {
  interactive: 'waiting on you',
  visible: 'this screen',
  background: 'background',
  maintenance: 'upkeep'
}

const PRIORITY_ORDER: ActivityTask['priority'][] = [
  'interactive',
  'visible',
  'background',
  'maintenance'
]

function relative(ms: number): string {
  if (ms <= 0) return 'now'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

function JobRow({ job, now }: { job: ActivityJob; now: number }) {
  return (
    <div className={styles.jobRow}>
      <span className={styles.jobLabel}>{job.label}</span>
      <span className={styles.jobDue}>
        {job.running ? 'running now' : `in ${relative(job.dueAt - now)}`}
      </span>
    </div>
  )
}

export function BackgroundActivitySection({
  onlyWhenBusy = false
}: {
  /**
   * Render nothing while the app is idle.
   *
   * On the viewer's Downloads page this panel was permanent furniture: a
   * pressure line, "Nothing running right now", and the whole scheduled-job
   * table, above the two things somebody opened the page for. Lanes,
   * priorities and next-run countdowns are worth showing WHILE something
   * is happening and are noise the rest of the time.
   */
  onlyWhenBusy?: boolean
} = {}) {
  const [snapshot, setSnapshot] = useState<ActivitySnapshot | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const api = window.api?.mediaHub?.activity
    if (!api) return
    let cancelled = false
    // One read for the state as it already is — subscribing only reports
    // what changes AFTER it, and a quiet app may not change for minutes.
    api.get().then(
      (initial) => {
        if (!cancelled) setSnapshot(initial)
      },
      () => {
        // Leaves the panel in its "not available" state below, which is
        // the honest reading when main can't be asked.
      }
    )
    const unsubscribe = api.onChanged((next) => setSnapshot(next))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS)
    return () => clearInterval(id)
  }, [])

  if (!snapshot) return null
  if (onlyWhenBusy && snapshot.running.length === 0 && snapshot.queued === 0) return null

  const queuedTiers = PRIORITY_ORDER.filter((tier) => snapshot.queuedByPriority[tier] > 0)

  return (
    <section className={`${styles.section} glass-panel`}>
      <h2 className={styles.sectionTitle}>
        <span className={styles.liveDot} />
        Background Activity
      </h2>

      <p className={`${styles.pressure} ${styles[snapshot.pressure]}`}>
        {PRESSURE_COPY[snapshot.pressure]}
      </p>

      {snapshot.running.length === 0 ? (
        <p className={styles.empty}>Nothing running right now.</p>
      ) : (
        snapshot.running.map((task) => (
          <div key={`${task.label}-${task.startedAt}`} className={styles.taskRow}>
            <span className={styles.taskLabel}>{task.label}</span>
            <span className={styles.taskMeta}>
              {task.lane} · {PRIORITY_COPY[task.priority]} · {relative(now - task.startedAt)}
            </span>
          </div>
        ))
      )}

      {snapshot.queued > 0 && (
        <p className={styles.queued}>
          {snapshot.queued} waiting (
          {queuedTiers.map((t) => `${snapshot.queuedByPriority[t]} ${PRIORITY_COPY[t]}`).join(', ')}
          )
        </p>
      )}

      {snapshot.jobs.length > 0 && (
        <div className={styles.jobs}>
          <h3 className={styles.jobsTitle}>Scheduled</h3>
          {snapshot.jobs.map((job) => (
            <JobRow key={job.name} job={job} now={now} />
          ))}
        </div>
      )}
    </section>
  )
}
