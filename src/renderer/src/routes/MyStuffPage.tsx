// My Stuff, as the README has always described it.
//
// This page rendered one grid — the watchlist — while the README promised
// "watchlisted, liked, disliked, watched, and in-progress". The other four
// were never missing data; they were missing a place to be shown. Everything
// here reads state the app already holds, except History, which reads the
// append-only `plays` table that now exists.
//
// Tabs rather than five nav entries, per the roadmap's first ground rule: the
// navigation stays at seven, and everything about "what I have watched and
// what I mean to" belongs behind one destination.

import { useEffect, useMemo, useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { useCatalogByIds } from '@renderer/lib/mediaHub/useCatalogByIds'
import { Icon } from '@renderer/components/icons/Icon'
import { useRestoreBrowsingOrigin } from '@renderer/lib/mediaHub/useRestoreBrowsingOrigin'
import { useMediaHubLists, useMediaHubPlays } from '@renderer/lib/mediaHub/hooks'
import { applyWatchStateFilters } from '@renderer/lib/mediaHub/categoryFilters'
import type { MediaItem } from '@renderer/types'
import type { CustomListItem, PlayRecord, ViewingStats } from '@shared/media-hub/types'
import styles from './MyStuff.module.css'
import { MediaGrid } from '@renderer/components/category/MediaGrid'
import type { PlannedSyncReport, RemoteList } from '@shared/media-hub/types'
import { PlannedFilters } from '@renderer/components/mystuff/PlannedFilters'
import { UpcomingPlanned } from '@renderer/components/mystuff/UpcomingPlanned'
import {
  applyPlannedFilters,
  EMPTY_PLANNED_FILTERS,
  type PlannedFilterState
} from '@renderer/components/mystuff/plannedFilterRules'

type TabId = 'list' | 'progress' | 'watched' | 'rated' | 'history' | 'stats' | 'dropped'

const TABS: { id: TabId; label: string }[] = [
  { id: 'list', label: 'Lists' },
  { id: 'progress', label: 'In progress' },
  { id: 'watched', label: 'Watched' },
  { id: 'rated', label: 'Rated' },
  { id: 'history', label: 'History' },
  { id: 'stats', label: 'Stats' },
  { id: 'dropped', label: 'Not for me' }
]

/** "S02E04", or nothing at all for a film. */
function episodeLabel(play: PlayRecord): string {
  if (play.season == null || play.episode == null) return ''
  return `S${String(play.season).padStart(2, '0')}E${String(play.episode).padStart(2, '0')}`
}

/**
 * When a viewing happened, in the terms people actually think in.
 *
 * Today and yesterday get named rather than dated, because "2 March" for
 * something watched last night reads as a much older memory than it is.
 */
function playedWhen(iso: string): string {
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return ''
  const today = new Date()
  const days = Math.floor(
    (new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() -
      new Date(when.getFullYear(), when.getMonth(), when.getDate()).getTime()) /
      86_400_000
  )
  if (days <= 0) return `Today, ${when.toLocaleTimeString([], { timeStyle: 'short' })}`
  if (days === 1) return `Yesterday, ${when.toLocaleTimeString([], { timeStyle: 'short' })}`
  if (days < 7) return `${days} days ago`
  return when.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * Every viewing, newest first, with the one thing a history is for: being
 * corrected.
 *
 * Removing a row deletes that PLAY and nothing else. An episode watched three
 * times stays watched after one of them is removed, which is the whole reason
 * the plays table is separate from the watched index — un-watching something
 * is a different action, and it lives on the title's own page.
 */
function HistoryList() {
  const { libraryKey } = useAppState()
  const { plays, loaded, remove } = useMediaHubPlays(libraryKey)
  if (!loaded) return <p className={styles.empty}>Reading your history…</p>
  if (plays.length === 0) {
    return (
      <p className={styles.empty}>Nothing watched yet. Titles appear here as you finish them.</p>
    )
  }
  return (
    <ol className={styles.history}>
      {plays.map((play) => (
        <li key={play.playId} className={styles.historyRow}>
          <div className={styles.historyArt}>
            {play.poster ? <img src={play.poster} alt="" /> : null}
          </div>
          <div className={styles.historyBody}>
            <span className={styles.historyTitle}>
              {play.title}
              {episodeLabel(play) ? (
                <span className={styles.historyEpisode}>{episodeLabel(play)}</span>
              ) : null}
            </span>
            <span className={styles.historyWhen}>{playedWhen(play.watchedAt)}</span>
          </div>
          <button
            type="button"
            className={styles.remove}
            onClick={() => void remove(play.playId)}
            aria-label={`Remove this viewing of ${play.title}`}
          >
            <Icon name="x" size={12} />
            Remove
          </button>
        </li>
      ))}
    </ol>
  )
}

/** The month label under each bar: "Mar", and the year when it changes. */
function monthLabel(month: string, index: number, all: { month: string }[]): string {
  const [year, monthNumber] = month.split('-')
  const name = new Date(Date.UTC(Number(year), Number(monthNumber) - 1, 1)).toLocaleDateString(
    undefined,
    { month: 'short' }
  )
  const previousYear = index > 0 ? all[index - 1].month.slice(0, 4) : null
  return previousYear && previousYear !== year ? `${name} ${year.slice(2)}` : name
}

/**
 * What the viewing adds up to.
 *
 * Fetched on mount, not held in app state: nothing else reads it, and it is a
 * full pass over the plays table that would be pure waste for anybody who
 * never opens this tab.
 */
function StatsView() {
  // Library-keyed like the hooks in lib/mediaHub/hooks.ts, and for the same
  // reasons: this reads IPC directly, and both a profile switch and a restore
  // change what is underneath it while this tab stays mounted.
  const { libraryKey } = useAppState()
  const [stats, setStats] = useState<ViewingStats | null>(null)
  const [loaded, setLoaded] = useState(() => !window.api?.mediaHub)

  useEffect(() => {
    let cancelled = false
    const api = window.api?.mediaHub
    if (!api) return
    api.stats
      .get()
      .then((result) => {
        if (cancelled) return
        setStats(result)
        setLoaded(true)
      })
      .catch(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [libraryKey])

  if (!loaded) return <p className={styles.empty}>Working it out…</p>
  if (!stats || stats.totalPlays === 0) {
    return (
      <p className={styles.empty}>
        Nothing to count yet. Numbers appear here once you have finished something.
      </p>
    )
  }

  const busiestMonth = Math.max(1, ...stats.byMonth.map((point) => point.plays))
  const topGenrePlays = Math.max(1, ...stats.topGenres.map((entry) => entry.plays))

  return (
    <div className={styles.stats}>
      <div className={styles.statRow}>
        <div className={styles.stat}>
          <span className={styles.statValue}>{stats.totalPlays}</span>
          <span className={styles.statLabel}>Viewings</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{stats.totalTitles}</span>
          <span className={styles.statLabel}>Titles</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{stats.estimatedHours}</span>
          {/* "About" rather than a precise figure, because it is one: a play
              records what was watched and when, not for how long, so a title
              stopped at 85% still counts for its full runtime. Saying so is
              better than implying a precision that is not there. */}
          <span className={styles.statLabel}>Hours, about</span>
        </div>
      </div>

      <section className={styles.statSection}>
        <h2 className={styles.statHeading}>Last twelve months</h2>
        <div className={styles.chart}>
          {stats.byMonth.map((point, index) => (
            <div key={point.month} className={styles.chartColumn}>
              <div
                className={styles.chartBar}
                style={{ height: `${Math.round((point.plays / busiestMonth) * 100)}%` }}
                title={`${point.plays} in ${point.month}`}
              />
              <span className={styles.chartLabel}>
                {monthLabel(point.month, index, stats.byMonth)}
              </span>
            </div>
          ))}
        </div>
      </section>

      {stats.topGenres.length > 0 && (
        <section className={styles.statSection}>
          <h2 className={styles.statHeading}>What you watch</h2>
          <ul className={styles.bars}>
            {stats.topGenres.map((entry) => (
              <li key={entry.genre} className={styles.bar}>
                <span className={styles.barLabel}>{entry.genre}</span>
                <span className={styles.barTrack}>
                  <span
                    className={styles.barFill}
                    style={{ width: `${Math.round((entry.plays / topGenrePlays) * 100)}%` }}
                  />
                </span>
                <span className={styles.barValue}>{entry.plays}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {stats.mostPlayed.length > 0 && (
        <section className={styles.statSection}>
          <h2 className={styles.statHeading}>Seen again</h2>
          <ul className={styles.bars}>
            {stats.mostPlayed.map((entry) => (
              <li key={entry.contentId} className={styles.bar}>
                <span className={styles.barLabel}>{entry.title}</span>
                <span className={styles.barValue}>{entry.plays}&times;</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/**
 * My List and any named lists somebody has made, behind one set of chips.
 *
 * My List is deliberately first and cannot be renamed or deleted: it is the
 * watchlist the tracking services sync against, not one collection among
 * several. The custom lists beside it are arbitrary and belong to nobody but
 * the person who made them.
 */
/** How long ago the lists were last pulled. Coarse on purpose — the
 *  question is whether this is current, not the exact minute. */
function syncWhen(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

function ListsView({ watchlist }: { watchlist: MediaItem[] }) {
  const { openDetail, libraryKey, plannedSources, adaptCatalogItems } = useAppState()
  const [filters, setFilters] = useState<PlannedFilterState>(EMPTY_PLANNED_FILTERS)
  const [report, setReport] = useState<PlannedSyncReport | null>(null)
  const [syncing, setSyncing] = useState(false)

  // The same button and the same figure as the Settings panel, because
  // this is where somebody is actually looking at the list and noticing
  // it is out of date. Making them go to Settings to refresh what is on
  // screen is the sort of errand a settings page should not be for.
  useEffect(() => {
    const api = window.api?.mediaHub?.tracking
    if (!api?.plannedReport) return
    void api
      .plannedReport()
      .then(setReport)
      .catch(() => {
        // No report yet is an ordinary state, not an error to announce.
      })
  }, [])

  const runSync = (): void => {
    const api = window.api?.mediaHub?.tracking
    if (!api?.syncPlanned) return
    setSyncing(true)
    void api
      .syncPlanned()
      .then(setReport)
      .catch(() => {})
      .finally(() => setSyncing(false))
  }

  const filtered = useMemo(
    () => applyPlannedFilters(watchlist, filters, plannedSources),
    [watchlist, filters, plannedSources]
  )

  const { lists, loaded, create, rename, remove, removeItem } = useMediaHubLists(libraryKey)
  // null selects My List; a list id selects that one.
  const [selected, setSelected] = useState<string | null>(null)
  // Carries the list it came from.
  //
  // Switching from one list to another kept the previous list's titles on
  // screen until the new fetch landed — and Remove reads the SELECTED list id
  // with the ROW's content id, so a click in that window called
  // removeItem(newList, oldTitle): a silent no-op at best, and at worst
  // removing something from a list nobody was looking at.
  const [items, setItems] = useState<{ key: string; values: CustomListItem[] } | null>(null)
  const [naming, setNaming] = useState(false)
  const [draftName, setDraftName] = useState('')
  // A selected list that has just been deleted falls back to My List rather
  // than leaving the chips with nothing highlighted.
  const selectedList = lists.find((list) => list.id === selected) ?? null
  const effective = selectedList?.id ?? null

  // THE LISTS SOMEBODY BUILT ELSEWHERE, read only.
  //
  // Named lists in Trakt and Simkl — "Halloween 2025", "Films Dad would
  // like" — sit beside the ones made here rather than in a section of
  // their own, because from where somebody is standing they are all just
  // their lists. What tells them apart is the service badge on the chip
  // and the fact that these cannot be edited: a named list has an author,
  // and reading one is not permission to reorder it.
  const [remoteLists, setRemoteLists] = useState<RemoteList[]>([])
  useEffect(() => {
    const api = window.api?.mediaHub?.lists
    if (!api?.remoteLists) return
    void api
      .remoteLists()
      .then((result) => setRemoteLists(result.lists))
      .catch(() => {
        // Nothing to show is the ordinary state for somebody who has made
        // no lists; it is not worth an error.
      })
  }, [])
  const selectedRemote = remoteLists.find((list) => list.id === selected) ?? null

  // Matched against the INDEX by id (stage 4), so a remote list's rows
  // carry this app's own artwork and ratings rather than the thin record
  // the service returned — and a list is never truncated to whatever the
  // bounded candidate pool happened to hold. Anything the index has
  // never seen is still dropped: a card with no art and no detail page
  // to open is not a row worth drawing.
  const remoteIds = useMemo(
    () => new Set((selectedRemote?.items ?? []).map((entry) => entry.id)),
    [selectedRemote]
  )
  const { items: remoteListItems } = useCatalogByIds(remoteIds, adaptCatalogItems)

  useEffect(() => {
    if (!effective) return
    let cancelled = false
    window.api?.mediaHub?.lists
      .items(effective)
      .then((result) => {
        if (!cancelled) setItems({ key: effective, values: result.items })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // `lists` is a dependency because a remove changes the counts, and what is
    // shown has to change with them.
  }, [effective, lists])

  // Null while a fetch for THIS list has not landed, which is what stops the
  // previous list's rows being rendered — and clicked — under the new one.
  const currentItems = items?.key === effective ? items.values : null

  async function submitName() {
    const name = draftName.trim()
    setNaming(false)
    setDraftName('')
    if (!name) return
    const created = await create(name)
    if (created) setSelected(created.id)
  }

  return (
    <>
      <div className={styles.chips}>
        <button
          type="button"
          className={`${styles.chip} ${effective === null ? styles.chipActive : ''}`}
          onClick={() => setSelected(null)}
        >
          Planned <span className={styles.chipCount}>{watchlist.length}</span>
        </button>
        {lists.map((list) => (
          <button
            key={list.id}
            type="button"
            className={`${styles.chip} ${effective === list.id ? styles.chipActive : ''}`}
            onClick={() => setSelected(list.id)}
          >
            {list.name} <span className={styles.chipCount}>{list.count}</span>
          </button>
        ))}
        {remoteLists.map((list) => (
          <button
            key={list.id}
            type="button"
            className={`${styles.chip} ${selected === list.id ? styles.chipActive : ''}`}
            onClick={() => setSelected(list.id)}
            title={list.description || `From ${list.service === 'trakt' ? 'Trakt' : 'Simkl'}`}
          >
            <span className={styles.chipService}>
              {list.service === 'trakt' ? 'Trakt' : 'Simkl'}
            </span>
            {list.name} <span className={styles.chipCount}>{list.items.length}</span>
          </button>
        ))}
        {naming ? (
          <form
            className={styles.chipForm}
            onSubmit={(event) => {
              event.preventDefault()
              void submitName()
            }}
          >
            <input
              autoFocus
              className={styles.chipInput}
              value={draftName}
              maxLength={80}
              placeholder="List name"
              aria-label="New list name"
              onChange={(event) => setDraftName(event.target.value)}
              onBlur={() => void submitName()}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setNaming(false)
                  setDraftName('')
                }
              }}
            />
          </form>
        ) : (
          <button
            type="button"
            className={styles.chip}
            onClick={() => setNaming(true)}
            disabled={!loaded}
          >
            + New list
          </button>
        )}
      </div>

      {selectedRemote ? (
        <>
          {/* Read only, and it says so rather than offering controls that
              would fail. The titles open like any other; what is missing
              is the rename, the delete and the per-row remove that a
              local list carries. */}
          <p className={styles.footnote}>
            {selectedRemote.description
              ? `${selectedRemote.description} — from ${
                  selectedRemote.service === 'trakt' ? 'Trakt' : 'Simkl'
                }, read only here.`
              : `From ${
                  selectedRemote.service === 'trakt' ? 'Trakt' : 'Simkl'
                }. Read only here — edit it there.`}
          </p>
          <MediaGrid
            showKind
            items={remoteListItems}
            emptyTitle="Nothing in this list"
            emptyMessage="It is empty on the service, or holds only entries this app cannot open — people and episodes are skipped."
          />
        </>
      ) : effective === null || !selectedList ? (
        <>
          {/* Where the list stands and how to refresh it, above the list
              itself. The time matters as much as the button: "planned"
              pulled from three services is only as true as its last
              pull, and a list with no timestamp invites the assumption
              that it is live. */}
          <div className={styles.syncRow}>
            <button
              type="button"
              className={styles.syncButton}
              onClick={runSync}
              disabled={syncing}
            >
              <Icon name="refresh" size={13} />
              {syncing ? 'Syncing…' : 'Sync lists'}
            </button>
            <span className={styles.syncMeta}>
              {report ? `Last refreshed ${syncWhen(report.at)}` : 'Not synced yet'}
              {report?.services.some((service) => service.error)
                ? ' · a service reported a problem, see Settings'
                : ''}
            </span>
          </div>

          {/* Above the filters: what is on the list but not out yet.
              It answers a different question from the rest of the
              page — "what am I waiting for" rather than "what can I
              watch" — and unfiltered, because filtering a list of
              four announced films is not a thing anybody needs. */}
          <UpcomingPlanned items={watchlist} />

          <PlannedFilters
            items={watchlist}
            filters={filters}
            onChange={setFilters}
            resultCount={filtered.length}
          />

          <MediaGrid
            showKind
            items={filtered}
            emptyTitle={
              watchlist.length > 0 ? 'Nothing matches those filters' : 'Nothing planned yet'
            }
            emptyMessage={
              watchlist.length > 0
                ? 'Try widening a filter or clearing them all.'
                : 'Anything you mark Plan to Watch appears here, along with your Simkl, Trakt and MyAnimeList lists.'
            }
          />
          {watchlist.length > 0 && (
            <p className={styles.footnote}>
              Right-click a title to take it off the list, mark it watched, or set it aside.
            </p>
          )}
        </>
      ) : (
        <>
          <div className={styles.listActions}>
            <button
              type="button"
              className={styles.remove}
              onClick={() => {
                const name = window.prompt('Rename this list', selectedList.name)
                if (name !== null) void rename(effective, name)
              }}
            >
              Rename
            </button>
            <button
              type="button"
              className={styles.remove}
              onClick={() => {
                // Confirmed because it takes the contents with it: the foreign
                // key cascades, and there is no undo behind this.
                if (window.confirm(`Delete "${selectedList.name}" and everything in it?`)) {
                  void remove(effective)
                  setSelected(null)
                }
              }}
            >
              Delete list
            </button>
          </div>
          {currentItems === null ? (
            <p className={styles.empty}>Opening…</p>
          ) : currentItems.length === 0 ? (
            <p className={styles.empty}>
              Nothing in this list yet. Add titles from their own page.
            </p>
          ) : (
            <div className={styles.grid}>
              {currentItems.map((item) => (
                <div key={item.contentId} className={styles.card}>
                  <button
                    type="button"
                    className={styles.art}
                    onClick={() =>
                      // A stored row carries only what a list needs to draw
                      // itself, so opening one hands the catalog an id and a
                      // kind rather than pretending this is a full MediaItem.
                      openDetail({ id: item.contentId, mediaKind: item.type } as MediaItem)
                    }
                  >
                    {item.poster ? (
                      <img className={styles.artImage} src={item.poster} alt="" />
                    ) : null}
                  </button>
                  <div className={styles.info}>
                    <span className={styles.title}>{item.title}</span>
                    <button
                      type="button"
                      className={styles.remove}
                      onClick={() => void removeItem(effective, item.contentId)}
                      aria-label={`Remove ${item.title} from ${selectedList.name}`}
                    >
                      <Icon name="x" size={12} />
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  )
}

export default function MyStuffPage() {
  const {
    myList,
    continueWatching,
    dislikedIds,
    ratings,
    mediaHubSettings,
    watchedIds,
    adaptCatalogItems
  } = useAppState()
  const [tab, setTab] = useState<TabId>('list')
  useRestoreBrowsingOrigin(true)

  // Global defaults only, no per-page override — same as the Mood Browser.
  // Memoised because this page subscribes to the whole app context: without
  // it, a full pass over a catalog well past a thousand entries re-ran on
  // every unrelated state change, a toast appearing included.
  const hideFilters = useMemo(
    () => ({
      hideWatched: mediaHubSettings?.hideWatchedDefault ?? false,
      hideCompleted: mediaHubSettings?.hideCompletedDefault ?? false,
      hideDisliked: mediaHubSettings?.hideDislikedDefault ?? false
    }),
    [mediaHubSettings]
  )

  // STAGE 4: every tab that used to scan the loaded catalog now fetches
  // its exact ids from the INDEX. The loaded catalog is a bounded
  // candidate pool, and a tracked/rated/watched title has every right
  // to live outside it — these tabs are precisely the surfaces that
  // must not shrink when the pool does.
  const { items: listRows } = useCatalogByIds(myList, adaptCatalogItems)
  const listItems = useMemo(
    () => applyWatchStateFilters(listRows, hideFilters),
    [listRows, hideFilters]
  )

  // Straight off the Continue Watching row rather than re-derived from the
  // catalog: that row is already the authority on what is part-watched, and
  // it carries titles the browse catalog may not currently hold.
  const progressItems = useMemo(
    () => continueWatching.map((entry) => entry.media),
    [continueWatching]
  )

  // The watched/completed flags are baked in at adaptation (adapters.ts);
  // the id set decides WHAT to fetch, the adapter decides what it means.
  const { items: watchedRows } = useCatalogByIds(watchedIds, adaptCatalogItems)
  const watchedItems = useMemo(
    () => watchedRows.filter((m) => m.completed || m.watched),
    [watchedRows]
  )

  // Highest score first, because a list of things you rated is a list you
  // scan for the best of them.
  const ratingIds = useMemo(() => new Set(ratings.keys()), [ratings])
  const { items: ratedRows } = useCatalogByIds(ratingIds, adaptCatalogItems)
  const ratedItems = useMemo(
    () => [...ratedRows].sort((a, b) => (ratings.get(b.id) ?? 0) - (ratings.get(a.id) ?? 0)),
    [ratedRows, ratings]
  )

  const { items: droppedItems } = useCatalogByIds(dislikedIds, adaptCatalogItems)

  return (
    <div className={styles.wrap}>
      <h1 className={styles.heading}>My Stuff</h1>

      <div className={styles.tabs} role="tablist" aria-label="My Stuff">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={`${styles.tab} ${tab === entry.id ? styles.tabActive : ''}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === 'list' && <ListsView watchlist={listItems} />}

      {tab === 'progress' && (
        <MediaGrid
          items={progressItems}
          emptyTitle="Nothing started"
          emptyMessage="Anything you leave part-way through waits here."
        />
      )}

      {tab === 'watched' && (
        <MediaGrid
          items={watchedItems}
          emptyTitle="Nothing finished yet"
          emptyMessage="Titles you finish collect here, including anything brought in from a tracking service."
        />
      )}

      {tab === 'rated' && (
        <>
          <MediaGrid
            items={ratedItems}
            emptyTitle="Nothing rated yet"
            emptyMessage="Give a title a score on its own page and it appears here, best first."
          />
          {ratedItems.length > 0 && (
            <p className={styles.footnote}>
              Highest first. Your scores steer what gets recommended — a genre watched often but
              enjoyed little stops leading the row.
            </p>
          )}
        </>
      )}

      {tab === 'history' && <HistoryList />}

      {tab === 'stats' && <StatsView />}

      {tab === 'dropped' && (
        <>
          <MediaGrid
            items={droppedItems}
            emptyTitle="Nothing set aside"
            emptyMessage="Titles you mark “Not interested” collect here."
          />
          {droppedItems.length > 0 && (
            <p className={styles.footnote}>
              Right-click a title and choose Remove dislike to start seeing it again.
            </p>
          )}
        </>
      )}
    </div>
  )
}
