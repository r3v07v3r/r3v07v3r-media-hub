'use client'

import { useEffect, useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import type { EpisodeSyncService, ShowSyncRow } from '@shared/media-hub/types'
import {
  seasonTotals,
  showSyncSides,
  type SeasonBubble,
  type ShowSyncSideKey
} from '@shared/media-hub/showSyncSides'
import overlayStyles from './Overlays.module.css'
import styles from './SyncReviewPanel.module.css'

const SERVICE_NAMES: Record<EpisodeSyncService, string> = { simkl: 'Simkl', trakt: 'Trakt' }
const SIDE_NAMES: Record<ShowSyncSideKey, string> = { local: 'Here', ...SERVICE_NAMES }

/** Episodes per season, per title, kept while the app runs: the panel is
 *  opened and closed many times for the same rows, and main's own cache
 *  still costs a round trip each time. */
const totalsCache = new Map<string, Map<number, number>>()

/** The title's episodes per season, from its metadata, once it has loaded;
 *  an empty map until then and when the lookup fails (no season turns green
 *  without one). */
function useSeasonTotals(row: ShowSyncRow): Map<number, number> {
  const [totals, setTotals] = useState<Map<number, number>>(
    () => totalsCache.get(row.id) ?? new Map()
  )
  useEffect(() => {
    // The initial state already read the cache; a row is keyed by its id.
    if (totalsCache.has(row.id)) return
    const api = window.api?.mediaHub?.catalog
    if (!api) return
    let current = true
    api
      .meta(row.type, row.id)
      .then((item) => {
        const next = seasonTotals(item.videos)
        totalsCache.set(row.id, next)
        if (current) setTotals(next)
      })
      .catch(() => {})
    return () => {
      current = false
    }
  }, [row.id, row.type])
  return totals
}

function bubbleTitle(bubble: SeasonBubble, side: string): string {
  const season = `Season ${bubble.season}`
  const progress =
    bubble.state === 'done'
      ? `all ${bubble.total} episodes`
      : bubble.state === 'none'
        ? 'nothing watched'
        : bubble.total
          ? `${bubble.watched} of ${bubble.total} episodes, up to episode ${bubble.last}`
          : `${bubble.watched} episodes, up to episode ${bubble.last}`
  const blocked = bubble.blocked ? ` · cannot be sent to ${side}, so it stays as it is there` : ''
  return `${season} — ${progress}${blocked}`
}

/** One season on one side: green when every episode is held, blue with the
 *  episode reached when some are, grey when none are. */
function Bubble({ bubble, side }: { bubble: SeasonBubble; side: string }) {
  const className = [
    styles.bubble,
    bubble.state === 'done' ? styles.bubbleDone : '',
    bubble.state === 'part' ? styles.bubblePart : '',
    bubble.state === 'none' ? styles.bubbleNone : '',
    bubble.blocked ? styles.bubbleBlocked : ''
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <span className={className} title={bubbleTitle(bubble, side)}>
      S{bubble.season}
      {bubble.state === 'part' && <em>E{bubble.last}</em>}
    </span>
  )
}

/** A show the automatic step merged: a line per side with what that side
 *  held on its own, and Use beside each to make every other side match it. */
function ShowRow({ row }: { row: ShowSyncRow }) {
  const { decideSyncShow } = useAppState()
  const totals = useSeasonTotals(row)
  const sides = showSyncSides(row, totals)
  const others = (key: ShowSyncSideKey): string =>
    sides
      .filter((side) => side.key !== key)
      .map((side) => SIDE_NAMES[side.key])
      .join(' and ')
  return (
    <div className={styles.showRow}>
      <div className={styles.row}>
        {row.poster && <img className={styles.poster} src={row.poster} alt="" />}
        <div className={styles.info}>
          <span className={styles.itemTitle}>
            {row.title} {row.year ? `(${row.year})` : ''}
          </span>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.ignoreButton}
            aria-label={`Keep ${row.title} as merged`}
            title="Keep as merged: every side now has everything"
            onClick={() => decideSyncShow(row, 'keep')}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      </div>
      <div className={styles.sides}>
        {sides.map((side) => {
          const name = SIDE_NAMES[side.key]
          const had = side.key === 'local' ? 'was here' : `${name} had`
          return (
            <div key={side.key} className={styles.side}>
              <span className={styles.sideName}>{name}</span>
              <div className={styles.bubbles}>
                {side.seasons.map((bubble) => (
                  <Bubble key={bubble.season} bubble={bubble} side={name} />
                ))}
              </div>
              <button
                type="button"
                className={styles.actionButton}
                title={`Make ${others(side.key)} match what ${had}`}
                onClick={() =>
                  side.key === 'local'
                    ? decideSyncShow(row, 'undo')
                    : decideSyncShow(row, 'here-match-service', side.key)
                }
              >
                Use
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Rendered from GlobalOverlays.tsx, driven by AppStateContext's
 *  syncDiscrepancies/syncShows/syncReviewOpen. Two sections.
 *
 *  Shows: what the automatic step merged, show by show (see
 *  main/media-hub/episodeSync.ts), drawn as a line per side — here, then
 *  each service with a part in the row — with a bubble per season showing
 *  how far that side had got on its own (shared/media-hub/showSyncSides.ts).
 *  Merging is what already happened, so the choices are the ways back:
 *  Use beside a side makes every other side match it (here: undo; a
 *  service: here-match-service, which also passes its set on to the other
 *  service), and Keep (the x) accepts the merge.
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
              Where this app and your tracking services differed. For a show, each line is what one
              side had before they were merged: Use makes the others match it, the x keeps the
              merge. Films wait for you to pick which side is right, or to be ignored.
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
