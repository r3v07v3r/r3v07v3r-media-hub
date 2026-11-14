'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import type { EpisodeSyncService, ShowSyncRow } from '@shared/media-hub/types'
import {
  seasonEpisodes,
  showSyncSides,
  type SeasonBubble,
  type SeasonEpisodes,
  type ShowSyncSideKey
} from '@shared/media-hub/showSyncSides'
import overlayStyles from './Overlays.module.css'
import styles from './SyncReviewPanel.module.css'

const SERVICE_NAMES: Record<EpisodeSyncService, string> = { simkl: 'Simkl', trakt: 'Trakt' }
const SIDE_NAMES: Record<ShowSyncSideKey, string> = { local: 'Here', ...SERVICE_NAMES }

/** The episodes listed per season, per title, kept while the app runs: the
 *  panel is opened and closed many times for the same rows, and main's own
 *  cache still costs a round trip each time. */
const listedCache = new Map<string, SeasonEpisodes>()

/** How many metadata lookups the panel has out at once. A first Trakt
 *  comparison can list hundreds of shows, and asking for all of them
 *  together puts that many lookups ahead of whatever the person opens next
 *  (a detail page, Play) in main's scheduler. */
const LOOKUPS_AT_ONCE = 4
let lookupsRunning = 0
const waitingLookups: Array<() => void> = []

function startWaitingLookups(): void {
  while (lookupsRunning < LOOKUPS_AT_ONCE && waitingLookups.length > 0) {
    waitingLookups.shift()!()
  }
}

/** Runs `lookup` when a slot is free. The returned function takes it back
 *  out of the queue if it has not started, so a row whose panel is closed
 *  before its turn costs nothing. */
function queueLookup(lookup: () => Promise<void>): () => void {
  const start = (): void => {
    lookupsRunning += 1
    const done = (): void => {
      lookupsRunning -= 1
      startWaitingLookups()
    }
    lookup().then(done, done)
  }
  waitingLookups.push(start)
  startWaitingLookups()
  return () => {
    const index = waitingLookups.indexOf(start)
    if (index >= 0) waitingLookups.splice(index, 1)
  }
}

/** The title's episodes per season, from its metadata, once it has loaded;
 *  an empty map until then and when the lookup fails (no season turns green
 *  without one). Nothing is asked until the row is on screen (`visible`). */
function useSeasonEpisodes(row: ShowSyncRow, visible: boolean): SeasonEpisodes {
  const [listed, setListed] = useState<SeasonEpisodes>(() => listedCache.get(row.id) ?? new Map())
  useEffect(() => {
    // The initial state already read the cache; a row is keyed by its id.
    if (!visible || listedCache.has(row.id)) return
    const api = window.api?.mediaHub?.catalog
    if (!api) return
    let current = true
    const drop = queueLookup(() =>
      api
        .meta(row.type, row.id)
        .then((item) => {
          const next = seasonEpisodes(item.videos)
          listedCache.set(row.id, next)
          if (current) setListed(next)
        })
        .catch(() => {})
    )
    return () => {
      current = false
      drop()
    }
  }, [row.id, row.type, visible])
  return listed
}

/** Whether the element the returned ref is attached to is on screen (or
 *  close to it) inside the panel's scrolling list. Once seen it stays true:
 *  the lookup it gates is wanted once, not again on every scroll. A callback
 *  ref, as in MediaGrid, so the observer follows the node itself. */
function useSeenOnScreen(): [(node: HTMLElement | null) => void, boolean] {
  const [seen, setSeen] = useState(false)
  const observerRef = useRef<IntersectionObserver | null>(null)
  const ref = useCallback((node: HTMLElement | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!node) return
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true)
          observer.disconnect()
        }
      },
      // The list the row sits in is the root, not the viewport: the list
      // scrolls on its own and clips the rows below it, so a margin on the
      // viewport never reached them and a row was asked for only once it
      // was already showing.
      { root: node.parentElement, rootMargin: '300px' }
    )
    observer.observe(node)
    observerRef.current = observer
  }, [])
  return [ref, seen]
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
 *  held on its own, and Use beside each to bring the other sides back to
 *  that line as far as each service allows (a service keeps what it
 *  recorded on its own). */
function ShowRow({ row }: { row: ShowSyncRow }) {
  const { decideSyncShow } = useAppState()
  const [rowRef, onScreen] = useSeenOnScreen()
  const listed = useSeasonEpisodes(row, onScreen)
  const sides = showSyncSides(row, listed)
  const serviceNames = sides
    .filter((side) => side.key !== 'local')
    .map((side) => SIDE_NAMES[side.key])
  /** What Use beside a side does, as exactly as a tooltip can. Beside a
   *  service it is not "every side matches": here takes that service's set,
   *  and the other service is sent what it had, but an episode the other
   *  service recorded on its own is left there (planShowDecision). */
  const titleForUse = (key: ShowSyncSideKey): string => {
    if (key === 'local') {
      return `Put ${serviceNames.join(' and ')} back to what was here: what came in from them is removed here and there`
    }
    const name = SIDE_NAMES[key]
    const other = serviceNames.filter((n) => n !== name)
    return other.length
      ? `Make here match ${name}; ${other.join(' and ')} is sent what ${name} had, keeping what it recorded on its own`
      : `Make here match ${name}`
  }
  return (
    <div ref={rowRef} className={styles.showRow}>
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
            title="Keep as merged: every side keeps what it has now"
            onClick={() => decideSyncShow(row, 'keep')}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      </div>
      <div className={styles.sides}>
        {sides.map((side) => {
          const name = SIDE_NAMES[side.key]
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
                title={titleForUse(side.key)}
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

/** Use … for everything: a button per side that has rows here — Here always,
 *  each service with a part in a show, Simkl for the films — that does what
 *  that side's Use does on every row. A first click arms it and says how
 *  many it covers; a second within a few seconds applies it. */
function UseAllBar() {
  const { syncShows, syncDiscrepancies, decideAllSync } = useAppState()
  const [armed, setArmed] = useState<'local' | EpisodeSyncService | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(null), 4000)
    return () => clearTimeout(timer)
  }, [armed])

  const services = (Object.keys(SERVICE_NAMES) as EpisodeSyncService[]).filter(
    (service) =>
      syncShows.some((row) => row.services[service]) ||
      (service === 'simkl' && syncDiscrepancies.length > 0)
  )
  const countFor = (side: 'local' | EpisodeSyncService): number =>
    side === 'local'
      ? syncShows.length + syncDiscrepancies.filter((d) => d.pushable !== false).length
      : syncShows.filter((row) => row.services[side]).length +
        (side === 'simkl' ? syncDiscrepancies.length : 0)
  const sides: Array<'local' | EpisodeSyncService> = ['local', ...services]
  if (syncShows.length + syncDiscrepancies.length < 2) return null

  return (
    <div className={styles.useAll}>
      <span className={styles.useAllLabel}>For everything</span>
      {sides.map((side) => {
        const name = side === 'local' ? 'Local' : SERVICE_NAMES[side]
        const count = countFor(side)
        const isArmed = armed === side
        return (
          <button
            key={side}
            type="button"
            disabled={busy || count === 0}
            className={`${styles.actionButton} ${side === 'local' ? styles.actionButtonPrimary : ''} ${isArmed ? styles.actionButtonArmed : ''}`}
            title={
              side === 'local'
                ? 'Use beside Here on every show (what came in from the services is removed, here and there) and Use Local on every film'
                : `Use beside ${name} on every show that has it${side === 'simkl' ? ', and Use Simkl on every film' : ''}`
            }
            onClick={() => {
              if (!isArmed) {
                setArmed(side)
                return
              }
              setArmed(null)
              setBusy(true)
              void decideAllSync(side).finally(() => setBusy(false))
            }}
          >
            {isArmed ? `Apply to ${count}?` : `Use ${name}`}
          </button>
        )
      })}
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
              side had before they were merged. Use brings the others back to that line as far as
              each service allows: a service keeps episodes it recorded on its own, and a dashed
              season cannot be sent there. The x keeps the merge as it is. Films wait for you to
              pick which side is right, or to be ignored.
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
        <UseAllBar />
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
