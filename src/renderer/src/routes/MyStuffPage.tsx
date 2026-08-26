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
import { Link } from 'react-router-dom'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import { useRestoreBrowsingOrigin } from '@renderer/lib/mediaHub/useRestoreBrowsingOrigin'
import { useMediaHubLists, useMediaHubPlays } from '@renderer/lib/mediaHub/hooks'
import { resolveArtwork } from '@renderer/lib/artwork'
import { ArtworkImage } from '@renderer/components/media/ArtworkImage'
import { WatchStatusBadge } from '@renderer/components/media/WatchStatusBadge'
import { getWatchStatus } from '@renderer/lib/mediaHub/watchStatus'
import { applyWatchStateFilters } from '@renderer/lib/mediaHub/categoryFilters'
import type { MediaItem } from '@renderer/types'
import type {
  CalendarEntry,
  CustomListItem,
  PlayRecord,
  ViewingStats
} from '@shared/media-hub/types'
import styles from './MyStuff.module.css'

type TabId =
  'list' | 'progress' | 'watched' | 'rated' | 'calendar' | 'history' | 'stats' | 'dropped'

const TABS: { id: TabId; label: string }[] = [
  { id: 'list', label: 'Lists' },
  { id: 'progress', label: 'In progress' },
  { id: 'watched', label: 'Watched' },
  { id: 'rated', label: 'Rated' },
  { id: 'calendar', label: 'Calendar' },
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

function TitleGrid({
  items,
  emptyMessage,
  action
}: {
  items: MediaItem[]
  emptyMessage: string
  action?: { label: string; onClick: (media: MediaItem) => void }
}) {
  const { openDetail, continueWatching } = useAppState()
  if (items.length === 0) return <p className={styles.empty}>{emptyMessage}</p>
  return (
    <div className={styles.grid}>
      {items.map((media) => {
        const artwork = resolveArtwork(media)
        return (
          <div key={media.id} className={styles.card}>
            <button
              type="button"
              className={styles.art}
              data-media-id={media.id}
              onClick={() => openDetail(media)}
            >
              <ArtworkImage
                src={artwork.posterUrl ?? artwork.backdropUrl}
                alt=""
                fallbackTitle={media.title}
                artTint={media.artTint}
                sizes="160px"
                className={styles.artImage}
              />
              <WatchStatusBadge status={getWatchStatus(media, continueWatching)} />
            </button>
            <div className={styles.info}>
              <span className={styles.title}>{media.title}</span>
              {action && (
                <button
                  type="button"
                  className={styles.remove}
                  onClick={() => action.onClick(media)}
                  aria-label={`${action.label} ${media.title}`}
                >
                  <Icon name="x" size={12} />
                  {action.label}
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
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
function ListsView({
  watchlist,
  onRemoveFromWatchlist
}: {
  watchlist: MediaItem[]
  onRemoveFromWatchlist: (media: MediaItem) => void
}) {
  const { openDetail, libraryKey } = useAppState()
  const { lists, loaded, create, rename, remove, removeItem } = useMediaHubLists(libraryKey)
  // null selects My List; a list id selects that one.
  const [selected, setSelected] = useState<string | null>(null)
  const [items, setItems] = useState<CustomListItem[]>([])
  const [naming, setNaming] = useState(false)
  const [draftName, setDraftName] = useState('')
  // A selected list that has just been deleted falls back to My List rather
  // than leaving the chips with nothing highlighted.
  const selectedList = lists.find((list) => list.id === selected) ?? null
  const effective = selectedList?.id ?? null

  useEffect(() => {
    if (!effective) return
    let cancelled = false
    window.api?.mediaHub?.lists
      .items(effective)
      .then((result) => {
        if (!cancelled) setItems(result.items)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // `lists` is a dependency because a remove changes the counts, and what is
    // shown has to change with them.
  }, [effective, lists])

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
          My List <span className={styles.chipCount}>{watchlist.length}</span>
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

      {effective === null || !selectedList ? (
        <TitleGrid
          items={watchlist}
          emptyMessage="Nothing saved yet. Add a title with My List and it appears here."
          action={{ label: 'Remove', onClick: onRemoveFromWatchlist }}
        />
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
          {items.length === 0 ? (
            <p className={styles.empty}>
              Nothing in this list yet. Add titles from their own page.
            </p>
          ) : (
            <div className={styles.grid}>
              {items.map((item) => (
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

/**
 * When each day is, in words.
 *
 * Today and tomorrow get named because a date is the wrong unit for them —
 * somebody scanning a schedule for what is on tonight should not have to
 * compare two numbers to find out.
 */
function airDayLabel(day: string, today: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return day
  const diff = Math.round((date.getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC'
  })
}

/**
 * What is airing, grouped by day.
 *
 * The payload arrives flat and is grouped here, because the grouping is a
 * presentation decision — a week grid and a list want the same data arranged
 * differently, and baking one shape into the IPC would make the other a
 * regrouping.
 */
function CalendarView() {
  // Library-keyed for the same reasons as StatsView above — the calendar is
  // built from the active profile's tracked shows.
  const { openDetail, libraryKey } = useAppState()
  // Seeded from whether there is a bridge at all: outside the desktop app
  // there is nothing to wait for, and an effect that says so synchronously
  // cascades a render.
  const [entries, setEntries] = useState<CalendarEntry[] | null>(window.api?.mediaHub ? null : [])

  useEffect(() => {
    const api = window.api?.mediaHub
    if (!api) return
    let cancelled = false
    api.catalog
      .calendar()
      .then((result) => {
        if (!cancelled) setEntries(result.entries)
      })
      .catch(() => {
        if (!cancelled) setEntries([])
      })
    return () => {
      cancelled = true
    }
  }, [libraryKey])

  const today = new Date().toISOString().slice(0, 10)
  const days = useMemo(() => {
    const grouped = new Map<string, CalendarEntry[]>()
    for (const entry of entries ?? []) {
      const bucket = grouped.get(entry.airsOn)
      if (bucket) bucket.push(entry)
      else grouped.set(entry.airsOn, [entry])
    }
    return [...grouped]
  }, [entries])

  if (entries === null) return <p className={styles.empty}>Checking the schedules…</p>
  if (days.length === 0) {
    return (
      <p className={styles.empty}>
        Nothing scheduled. Only shows in My List appear here, and their episode lists fill in over
        several sessions in the background — so a show you added a moment ago may not be covered
        yet.
      </p>
    )
  }

  return (
    <div className={styles.calendar}>
      {days.map(([day, forDay]) => (
        <section key={day} className={styles.calendarDay}>
          <h2 className={`${styles.calendarDate} ${day === today ? styles.calendarDateToday : ''}`}>
            {airDayLabel(day, today)}
          </h2>
          <ul className={styles.history}>
            {forDay.map((entry) => (
              <li
                key={`${entry.contentId}:${entry.season}:${entry.episode}`}
                className={styles.historyRow}
              >
                <div className={styles.historyArt}>
                  {entry.poster ? <img src={entry.poster} alt="" /> : null}
                </div>
                <button
                  type="button"
                  className={styles.calendarEntry}
                  onClick={() =>
                    openDetail({ id: entry.contentId, mediaKind: entry.type } as MediaItem)
                  }
                >
                  <span className={styles.historyTitle}>
                    {entry.title}
                    <span className={styles.historyEpisode}>
                      {`S${String(entry.season).padStart(2, '0')}E${String(entry.episode).padStart(2, '0')}`}
                    </span>
                  </span>
                  {entry.episodeTitle ? (
                    <span className={styles.historyWhen}>{entry.episodeTitle}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

export default function MyStuffPage() {
  const {
    myList,
    toggleMyList,
    catalog,
    continueWatching,
    dislikedIds,
    toggleDisliked,
    ratings,
    mediaHubSettings
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

  const listItems = useMemo(
    () =>
      applyWatchStateFilters(
        catalog.filter((m) => myList.has(m.id)),
        hideFilters
      ),
    [catalog, myList, hideFilters]
  )

  // Straight off the Continue Watching row rather than re-derived from the
  // catalog: that row is already the authority on what is part-watched, and
  // it carries titles the browse catalog may not currently hold.
  const progressItems = useMemo(
    () => continueWatching.map((entry) => entry.media),
    [continueWatching]
  )

  // The watched/completed flags are baked into each MediaItem at conversion
  // time (see adapters.ts), so this needs no second history fetch.
  const watchedItems = useMemo(() => catalog.filter((m) => m.completed || m.watched), [catalog])

  // Highest score first, because a list of things you rated is a list you
  // scan for the best of them.
  const ratedItems = useMemo(
    () =>
      catalog
        .filter((m) => ratings.has(m.id))
        .sort((a, b) => (ratings.get(b.id) ?? 0) - (ratings.get(a.id) ?? 0)),
    [catalog, ratings]
  )

  const droppedItems = useMemo(
    () => catalog.filter((m) => dislikedIds.has(m.id)),
    [catalog, dislikedIds]
  )

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

      {tab === 'list' && <ListsView watchlist={listItems} onRemoveFromWatchlist={toggleMyList} />}

      {tab === 'progress' && (
        <TitleGrid
          items={progressItems}
          emptyMessage="Nothing started. Anything you leave part-way through waits here."
        />
      )}

      {tab === 'watched' && <TitleGrid items={watchedItems} emptyMessage="Nothing finished yet." />}

      {tab === 'rated' && (
        <>
          <TitleGrid
            items={ratedItems}
            emptyMessage="Nothing rated yet. Give a title a score on its own page and it appears here, best first."
          />
          {ratedItems.length > 0 && (
            <p className={styles.footnote}>
              Highest first. Your scores steer what gets recommended — a genre watched often but
              enjoyed little stops leading the row.
            </p>
          )}
        </>
      )}

      {tab === 'calendar' && <CalendarView />}

      {tab === 'history' && <HistoryList />}

      {tab === 'stats' && <StatsView />}

      {tab === 'dropped' && (
        <TitleGrid
          items={droppedItems}
          emptyMessage="Nothing set aside. Titles you mark “Not interested” collect here."
          action={{ label: 'Restore', onClick: (media) => toggleDisliked(media) }}
        />
      )}

      <Link to="/" className={styles.backLink}>
        ← Back to Home
      </Link>
    </div>
  )
}
