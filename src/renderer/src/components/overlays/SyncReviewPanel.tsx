'use client'

import { useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import type {
  EpisodeSyncService,
  ShowSyncRow,
  ShowSyncServiceRow,
  SyncEpisode
} from '@shared/media-hub/types'
import overlayStyles from './Overlays.module.css'
import styles from './SyncReviewPanel.module.css'

const SERVICE_NAMES: Record<EpisodeSyncService, string> = { simkl: 'Simkl', trakt: 'Trakt' }

/** "1–3, 5" for episodes 1, 2, 3 and 5 of one season. */
function episodeRanges(numbers: number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length; i++) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]))
    i = j
  }
  return parts.join(', ')
}

function count(list: SyncEpisode[]): string {
  return `${list.length} ${list.length === 1 ? 'episode' : 'episodes'}`
}

/** One line per season: what arrived, what was sent, what cannot be sent. */
function seasonLines(part: ShowSyncServiceRow, name: string): string[] {
  const seasons = [
    ...new Set([...part.arrived, ...part.sent, ...part.unsendable].map((ep) => ep.season))
  ].sort((a, b) => a - b)
  return seasons.map((season) => {
    const of = (list: SyncEpisode[]): number[] =>
      list.filter((ep) => ep.season === season).map((ep) => ep.episode)
    const said: string[] = []
    const arrived = of(part.arrived)
    const sent = of(part.sent)
    const unsendable = of(part.unsendable)
    if (arrived.length) said.push(`from ${name}: ${episodeRanges(arrived)}`)
    if (sent.length) said.push(`sent to ${name}: ${episodeRanges(sent)}`)
    if (unsendable.length) said.push(`not at ${name}: ${episodeRanges(unsendable)}`)
    if (part.blockedSeasons.includes(season)) said.push(`cannot be sent to ${name}`)
    return `${season === 0 ? 'Specials' : `Season ${season}`} — ${said.join(' · ')}`
  })
}

/** A show the automatic step merged: what arrived from where and what was
 *  sent where, the seasons and episodes on demand, and the choices. */
function ShowRow({ row }: { row: ShowSyncRow }) {
  const { decideSyncShow } = useAppState()
  const [open, setOpen] = useState(false)
  const services = (Object.keys(row.services) as EpisodeSyncService[]).filter(
    (service) => row.services[service]
  )
  const arrivedAnywhere = services.some((service) => row.services[service]!.arrived.length)
  const summary = services.flatMap((service) => {
    const part = row.services[service]!
    const name = SERVICE_NAMES[service]
    const said: string[] = []
    if (part.arrived.length) said.push(`${count(part.arrived)} from ${name}`)
    if (part.sent.length) said.push(`${count(part.sent)} sent to ${name}`)
    if (part.unsendable.length) said.push(`${count(part.unsendable)} cannot be sent to ${name}`)
    return said
  })
  return (
    <div className={styles.showRow}>
      <div className={styles.row}>
        {row.poster && <img className={styles.poster} src={row.poster} alt="" />}
        <div className={styles.info}>
          <span className={styles.itemTitle}>
            {row.title} {row.year ? `(${row.year})` : ''}
          </span>
          <span className={styles.statusRow}>{summary.join(' · ')}</span>
        </div>
        <div className={styles.actions}>
          {arrivedAnywhere && (
            <button
              type="button"
              className={styles.actionButton}
              title="Remove the episodes that arrived, here and at the service they came from"
              onClick={() => decideSyncShow(row, 'undo')}
            >
              Undo
            </button>
          )}
          <button
            type="button"
            className={styles.ignoreButton}
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} seasons of ${row.title}`}
            onClick={() => setOpen((value) => !value)}
          >
            <Icon name={open ? 'chevron-up' : 'chevron-down'} size={13} />
          </button>
          <button
            type="button"
            className={styles.ignoreButton}
            aria-label={`Keep ${row.title} as merged`}
            title="Keep as merged"
            onClick={() => decideSyncShow(row, 'keep')}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      </div>
      {open && (
        <div className={styles.showDetail}>
          {services.map((service) => {
            const part = row.services[service]!
            const name = SERVICE_NAMES[service]
            return (
              <div key={service} className={styles.serviceBlock}>
                <span className={styles.serviceName}>{name}</span>
                {seasonLines(part, name).map((line) => (
                  <span key={line} className={styles.seasonLine}>
                    {line}
                  </span>
                ))}
                <div className={styles.serviceActions}>
                  <button
                    type="button"
                    className={styles.actionButton}
                    onClick={() => decideSyncShow(row, 'service-match-here', service)}
                  >
                    Make {name} match here
                  </button>
                  <button
                    type="button"
                    className={styles.actionButton}
                    onClick={() => decideSyncShow(row, 'here-match-service', service)}
                  >
                    Make here match {name}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Rendered from GlobalOverlays.tsx, driven by AppStateContext's
 *  syncDiscrepancies/syncShows/syncReviewOpen. Two sections.
 *
 *  Shows: what the automatic step merged, show by show (see
 *  main/media-hub/episodeSync.ts) — the episodes that arrived from each
 *  service and the ones sent to it. Merging both is what already happened,
 *  so the row's choices are Undo, the two "make one side match" overrides
 *  per service, and Keep (the x), which accepts the merge.
 *
 *  Films: see tracking.ts's own header comment for how these
 *  disagreements are found and why nothing here is ever applied
 *  automatically. Each row is resolved independently: picking
 *  "Use Local"/"Use Simkl" pushes that value to the losing side, and
 *  "Ignore" just drops the item from future checks without changing
 *  either side. "Use Local" is recorded before it is sent, and a burst
 *  of them goes out as one batched request per service a few seconds
 *  after the last click — so working down this list is one push, and a
 *  row that leaves stays gone even if that push has to be retried on a
 *  later launch (see tracking.ts's pending-push queue). */
export function SyncReviewPanel() {
  const {
    syncReviewOpen,
    setSyncReviewOpen,
    syncDiscrepancies,
    resolveSyncDiscrepancy,
    syncShows
  } = useAppState()

  if (!syncReviewOpen) return null

  return (
    <div
      className={overlayStyles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label="Sync review"
      onClick={() => setSyncReviewOpen(false)}
    >
      <div
        className={`${overlayStyles.modal} ${styles.modal} glass-panel`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <div className={styles.headerText}>
            <span className={styles.title}>Sync review</span>
            <span className={styles.subtitle}>
              Where this app and your tracking services differed. Shows list the episodes that were
              merged, to keep or undo. Films wait for you to pick which side is right, or to be
              ignored.
            </span>
          </div>
          <button
            type="button"
            className={styles.closeButton}
            onClick={() => setSyncReviewOpen(false)}
            aria-label="Close"
          >
            <Icon name="x" size={13} />
          </button>
        </div>
        <div className={styles.list}>
          {syncDiscrepancies.length === 0 && syncShows.length === 0 && (
            <div className={styles.row}>
              <span className={styles.subtitle}>All caught up.</span>
            </div>
          )}
          {syncShows.length > 0 && (
            <>
              <span className={styles.sectionTitle}>Shows</span>
              {syncShows.map((row) => (
                <ShowRow key={row.id} row={row} />
              ))}
            </>
          )}
          {syncDiscrepancies.length > 0 && (
            <span className={styles.sectionTitle}>Films out of sync with Simkl</span>
          )}
          {syncDiscrepancies.map((d) => (
            <div key={d.id} className={styles.row}>
              {d.poster && <img className={styles.poster} src={d.poster} alt="" />}
              <div className={styles.info}>
                <span className={styles.itemTitle}>
                  {d.title} {d.year ? `(${d.year})` : ''}
                </span>
                <div className={styles.statusRow}>
                  <span>Here:</span>
                  <span
                    className={`${styles.statusBadge} ${d.localWatched ? styles.statusWatched : styles.statusUnwatched}`}
                  >
                    {d.localWatched ? 'Watched' : 'Not watched'}
                  </span>
                  <span>Simkl:</span>
                  <span
                    className={`${styles.statusBadge} ${d.remoteWatched ? styles.statusWatched : styles.statusUnwatched}`}
                  >
                    {d.remoteWatched ? 'Watched' : 'Not watched'}
                  </span>
                </div>
              </div>
              <div className={styles.actions}>
                {/* No "Use Local" for a row whose id can't be pushed as a
                      real id (a demo-id duplicate, typically): the push
                      would be an unverifiable title/year guess and the row
                      would come straight back — see
                      WatchStatusDiscrepancy.pushable. "Use Simkl" is the
                      one that genuinely resolves these, by rewriting the
                      local record. */}
                {d.pushable !== false ? (
                  <button
                    type="button"
                    className={`${styles.actionButton} ${styles.actionButtonPrimary}`}
                    onClick={() => resolveSyncDiscrepancy(d, 'use-local')}
                  >
                    Use Local
                  </button>
                ) : (
                  <span
                    className={styles.unpushableNote}
                    title="This entry has a local-only id that Simkl can’t recognise, so it can’t be pushed. Use Simkl to rewrite the local record."
                  >
                    Can’t push
                  </span>
                )}
                <button
                  type="button"
                  className={styles.actionButton}
                  onClick={() => resolveSyncDiscrepancy(d, 'use-remote')}
                >
                  Use Simkl
                </button>
                <button
                  type="button"
                  className={styles.ignoreButton}
                  aria-label={`Ignore ${d.title}`}
                  onClick={() => resolveSyncDiscrepancy(d, 'ignore')}
                >
                  <Icon name="x" size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
