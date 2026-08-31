'use client'

// What the watchlist pull actually did.
//
// The pull reads plan-to-watch from Simkl, Trakt and MyAnimeList and
// folds it into Planned. Without this panel its only visible effect is
// that the list gets longer, which makes every failure look identical to
// a short list — an expired token, a rate limit and an empty watchlist
// all produce "nothing new appeared".
//
// So it reports per service: connected or not, how many came back, how
// many were dropped for want of an id this app could file them under,
// and the service's own error text when there was one. The counts are
// the point; the button is a convenience.

import { useCallback, useEffect, useState } from 'react'
import type { PlannedServiceReport, PlannedSyncReport } from '@shared/media-hub/types'
import { Icon } from '@renderer/components/icons/Icon'
import { useAppState } from '@renderer/context/AppStateContext'
import styles from '@renderer/routes/Settings.module.css'

const SERVICE_LABELS: Record<PlannedServiceReport['service'], string> = {
  simkl: 'Simkl',
  trakt: 'Trakt',
  mal: 'MyAnimeList'
}

/** "just now", "12 minutes ago", "3 days ago" — precision nobody needs
 *  beyond knowing whether this is current. */
function when(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/** What the pull did, in one sentence. Removals are named separately
 *  from additions because they are the half that took something away,
 *  and folding both into a single 'synced' would hide that. */
function summarise(report: PlannedSyncReport): string {
  const parts: string[] = []
  if (report.added > 0) parts.push(`${report.added} added`)
  if (report.removed > 0) parts.push(`${report.removed} removed`)
  return parts.length ? parts.join(', ') : 'Nothing changed'
}

function line(report: PlannedServiceReport): string {
  if (!report.connected) return 'Not connected'
  if (report.error) return report.error
  const parts = [`${report.pulled} title${report.pulled === 1 ? '' : 's'}`]
  // Only mentioned when it happened. A permanent "0 unmapped" is noise on
  // the ordinary case, which is every film and series matching cleanly.
  if (report.unmapped > 0) parts.push(`${report.unmapped} unmatched`)
  return parts.join(' · ')
}

export function WatchlistSyncSection() {
  const { mediaHubSettings, refreshMediaHubSettings } = useAppState()
  const [report, setReport] = useState<PlannedSyncReport | null>(null)
  const [busy, setBusy] = useState(false)
  const twoWay = mediaHubSettings?.watchlistTwoWay !== false

  const setTwoWay = (enabled: boolean): void => {
    void window.api?.mediaHub?.tracking
      ?.setWatchlistTwoWay?.(enabled)
      .then(() => refreshMediaHubSettings())
      .catch(() => {})
  }

  const load = useCallback(async () => {
    const api = window.api?.mediaHub?.tracking
    if (!api?.plannedReport) return
    setReport(await api.plannedReport().catch(() => null))
  }, [])

  useEffect(() => {
    void Promise.resolve().then(load)
  }, [load])

  const run = (): void => {
    const api = window.api?.mediaHub?.tracking
    if (!api?.syncPlanned) return
    setBusy(true)
    void api
      .syncPlanned()
      .then(setReport)
      .catch(() => {
        // The per-service errors are inside the report; a throw here is the
        // IPC itself failing, which the unchanged panel already shows by
        // not moving.
      })
      .finally(() => setBusy(false))
  }

  return (
    <section className={`${styles.section} glass-panel`} aria-labelledby="settings-watchlists">
      <h2 id="settings-watchlists" className={styles.sectionTitle}>
        Watchlists
      </h2>
      <div className={styles.row}>
        <div className={styles.rowIcon} aria-hidden="true">
          <Icon name="tracked" size={17} />
        </div>
        <div className={styles.rowText}>
          <span className={styles.rowTitle}>Plan to watch, from every connected service</span>
          <span className={styles.rowDescription}>
            Simkl, Trakt and MyAnimeList lists are pulled in and merged into Planned. Runs on its
            own in the background; this is for when you have just added things on the web.
          </span>
        </div>
        <button type="button" className={styles.testButton} onClick={run} disabled={busy}>
          {busy ? 'Syncing…' : 'Sync now'}
        </button>
      </div>

      {/* THE ONE CONTROL THAT CAN DELETE SOMETHING, and it says so.
          On, changes here reach the services and their removals reach
          here — but only for titles this app pulled in itself, which is
          the whole safety rule and the reason the description says which
          direction is which rather than "keep in sync". */}
      <div className={styles.row}>
        <div className={styles.rowIcon} aria-hidden="true">
          <Icon name="refresh" size={17} />
        </div>
        <div className={styles.rowText}>
          <span className={styles.rowTitle}>Keep watchlists in sync</span>
          <span className={styles.rowDescription}>
            Planning something here adds it to every connected service, and un-planning removes it.
            A title that leaves a service is removed here too — but only if this app pulled it in
            from that service in the first place. Anything you added here is never removed by a
            sync. Turn this off to keep pulling without writing anything back.
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={twoWay}
          className={styles.testButton}
          onClick={() => setTwoWay(!twoWay)}
        >
          {twoWay ? 'On' : 'Off'}
        </button>
      </div>

      {report && (
        <>
          <ul className={styles.watchlistReport}>
            {report.services.map((service) => (
              <li key={service.service} className={service.error ? styles.reportError : undefined}>
                <span>{SERVICE_LABELS[service.service]}</span>
                <span>{line(service)}</span>
              </li>
            ))}
          </ul>
          <span className={styles.statusMessage}>
            {summarise(report)} — {when(report.at)}.
          </span>
        </>
      )}
    </section>
  )
}
