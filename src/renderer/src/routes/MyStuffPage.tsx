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

/** `day` shifted by whole days, in the same UTC-day-key terms as `dayKey` on
 *  the main side — everything here compares these strings, never Date math
 *  across a local timezone. */
function dayOffset(day: string, delta: number): string {
  return new Date(new Date(`${day}T00:00:00Z`).getTime() + delta * 86_400_000)
    .toISOString()
    .slice(0, 10)
}

/** How many upcoming cards the strip shows before it collapses the rest
 *  behind "+N more" — enough to read as a week at a glance without the row
 *  turning into the whole six-week window. */
const STRIP_LIMIT = 10

/**
 * "What's airing": the last day, then what's coming, as a single scannable
 * row instead of a page you have to scroll to find out what you're waiting
 * for.
 *
 * `entries` arrives sorted ascending by day already (see calendar.ts), so
 * filtering it to "yesterday or later" keeps that order for free — no
 * re-sort needed. Everything from yesterday counts as recent; everything
 * from today on counts as upcoming, and that's the boundary the divider and
 * the collapse limit both key off.
 */
function UpNextStrip({
  entries,
  today,
  yesterday,
  onOpen
}: {
  entries: CalendarEntry[]
  today: string
  yesterday: string
  onOpen: (media: MediaItem) => void
}) {
  const [expanded, setExpanded] = useState(false)

  const items = useMemo(() => entries.filter((e) => e.airsOn >= yesterday), [entries, yesterday])
  const firstUpcoming = items.findIndex((e) => e.airsOn >= today)
  const recentCount = firstUpcoming === -1 ? items.length : firstUpcoming
  const upcomingCount = firstUpcoming === -1 ? 0 : items.length - firstUpcoming
  const visibleCount =
    recentCount + (expanded ? upcomingCount : Math.min(upcomingCount, STRIP_LIMIT))
  const visible = items.slice(0, visibleCount)
  const hiddenCount = items.length - visible.length

  if (items.length === 0) return null

  return (
    <section className={styles.upNext}>
      <h2 className={styles.statHeading}>What&rsquo;s airing</h2>
      <div className={styles.upNextRow}>
        {visible.map((entry, index) => (
          <div
            key={`${entry.contentId}:${entry.season}:${entry.episode}`}
            className={styles.upNextItem}
          >
            {index === recentCount && recentCount > 0 && (
              <span className={styles.upNextDivider} aria-hidden="true" />
            )}
            <button
              type="button"
              className={styles.upNextCard}
              onClick={() => onOpen({ id: entry.contentId, mediaKind: entry.type } as MediaItem)}
            >
              <span className={styles.upNextArt}>
                {entry.poster ? <img src={entry.poster} alt="" /> : null}
              </span>
              <span className={styles.upNextDay}>{airDayLabel(entry.airsOn, today)}</span>
              <span className={styles.upNextTitle}>{entry.title}</span>
              <span className={styles.upNextEpisode}>
                {`S${String(entry.season).padStart(2, '0')}E${String(entry.episode).padStart(2, '0')}`}
              </span>
            </button>
          </div>
        ))}
        {hiddenCount > 0 && (
          <button type="button" className={styles.upNextMore} onClick={() => setExpanded(true)}>
            +{hiddenCount} more
          </button>
        )}
        {expanded && upcomingCount > STRIP_LIMIT && (
          <button type="button" className={styles.upNextMore} onClick={() => setExpanded(false)}>
            Show fewer
          </button>
        )}
      </div>
    </section>
  )
}

/** How far back and forward the grid reaches — matching the window the main
 *  process actually fetches (see PAST_DAYS/FUTURE_DAYS in calendar.ts), so
 *  the grid never promises a week the data behind it doesn't cover. */
const GRID_PAST_DAYS = 7
const GRID_FUTURE_DAYS = 42
/** Entries shown in a cell before it collapses the rest behind "+N more" —
 *  a season dropping eight episodes at once shouldn't blow out that day's
 *  row height for the five empty days around it. */
const CELL_LIMIT = 3

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** The grid's days, padded out to full weeks (Sunday to Saturday) on both
 *  ends so the week rows actually line up under the weekday header. */
function buildGridDays(today: string): string[] {
  const todayMs = new Date(`${today}T00:00:00Z`).getTime()
  const startMs = todayMs - GRID_PAST_DAYS * 86_400_000
  const endMs = todayMs + GRID_FUTURE_DAYS * 86_400_000
  const alignedStart = startMs - new Date(startMs).getUTCDay() * 86_400_000
  const alignedEnd = endMs + (6 - new Date(endMs).getUTCDay()) * 86_400_000
  const days: string[] = []
  for (let t = alignedStart; t <= alignedEnd; t += 86_400_000) days.push(isoDay(t))
  return days
}

// 2023-01-01 fell on a Sunday, so counting forward from it gives Sun..Sat in
// whatever locale the user is in without pulling in a date library.
const WEEKDAY_LABELS = Array.from({ length: 7 }, (_, index) =>
  new Date(Date.UTC(2023, 0, 1 + index)).toLocaleDateString(undefined, {
    weekday: 'short',
    timeZone: 'UTC'
  })
)

/**
 * The calendar proper: a rolling six-and-a-half-week grid rather than a
 * navigable month, because the data behind it doesn't extend further than
 * that in either direction — a "next month" arrow would mostly point at an
 * empty page.
 */
function CalendarGrid({
  grouped,
  today,
  onOpen
}: {
  grouped: Map<string, CalendarEntry[]>
  today: string
  onOpen: (media: MediaItem) => void
}) {
  const gridDays = useMemo(() => buildGridDays(today), [today])
  const weeks = useMemo(() => {
    const out: string[][] = []
    for (let i = 0; i < gridDays.length; i += 7) out.push(gridDays.slice(i, i + 7))
    return out
  }, [gridDays])

  // Per-day, not global: opening one busy Friday shouldn't also blow out
  // every other Friday in the grid.
  const [expandedDays, setExpandedDays] = useState<Set<string>>(() => new Set())
  function toggleDay(day: string) {
    setExpandedDays((prev) => {
      const next = new Set(prev)
      if (next.has(day)) next.delete(day)
      else next.add(day)
      return next
    })
  }

  return (
    <div className={styles.calGridScroll}>
      <div className={styles.calGrid}>
        <div className={styles.calGridHeader}>
          {WEEKDAY_LABELS.map((label) => (
            <span key={label} className={styles.calGridHeaderCell}>
              {label}
            </span>
          ))}
        </div>
        {weeks.map((week) => (
          <div key={week[0]} className={styles.calGridWeek}>
            {week.map((day) => {
              const dayEntries = grouped.get(day) ?? []
              const dayNumber = Number(day.slice(8, 10))
              const monthLabel =
                dayNumber === 1
                  ? new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
                      month: 'short',
                      timeZone: 'UTC'
                    })
                  : ''
              const isToday = day === today
              const isPast = day < today
              const expanded = expandedDays.has(day)
              const visibleEntries = expanded ? dayEntries : dayEntries.slice(0, CELL_LIMIT)
              const hidden = dayEntries.length - visibleEntries.length

              return (
                <div
                  key={day}
                  className={`${styles.calGridCell} ${isToday ? styles.calGridCellToday : ''} ${
                    isPast ? styles.calGridCellPast : ''
                  }`}
                >
                  <span className={styles.calGridDate}>
                    {monthLabel && <span className={styles.calGridMonth}>{monthLabel}</span>}
                    {dayNumber}
                  </span>
                  {visibleEntries.length > 0 && (
                    <ul className={styles.calGridEntries}>
                      {visibleEntries.map((entry) => (
                        <li key={`${entry.contentId}:${entry.season}:${entry.episode}`}>
                          <button
                            type="button"
                            className={styles.calGridEntry}
                            onClick={() =>
                              onOpen({ id: entry.contentId, mediaKind: entry.type } as MediaItem)
                            }
                            title={`${entry.title} S${String(entry.season).padStart(2, '0')}E${String(
                              entry.episode
                            ).padStart(2, '0')}`}
                          >
                            {entry.title}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {hidden > 0 && (
                    <button
                      type="button"
                      className={styles.calGridMore}
                      onClick={() => toggleDay(day)}
                    >
                      +{hidden} more
                    </button>
                  )}
                  {expanded && dayEntries.length > CELL_LIMIT && (
                    <button
                      type="button"
                      className={styles.calGridMore}
                      onClick={() => toggleDay(day)}
                    >
                      Show fewer
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * What is airing: a quick "waiting for" strip, and a proper calendar grid
 * underneath it for browsing.
 *
 * The payload arrives flat and is grouped here, because the grouping is a
 * presentation decision — a week grid and a strip want the same data
 * arranged differently, and baking one shape into the IPC would make the
 * other a regrouping.
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
  const yesterday = dayOffset(today, -1)

  const grouped = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>()
    for (const entry of entries ?? []) {
      const bucket = map.get(entry.airsOn)
      if (bucket) bucket.push(entry)
      else map.set(entry.airsOn, [entry])
    }
    return map
  }, [entries])

  if (entries === null) return <p className={styles.empty}>Checking the schedules…</p>
  if (entries.length === 0) {
    return (
      <p className={styles.empty}>
        Nothing scheduled. Only shows in My List appear here, and their episode lists fill in over
        several sessions in the background — so a show you added a moment ago may not be covered
        yet.
      </p>
    )
  }

  return (
    <div className={styles.calendarWrap}>
      <UpNextStrip entries={entries} today={today} yesterday={yesterday} onOpen={openDetail} />
      <CalendarGrid grouped={grouped} today={today} onOpen={openDetail} />
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
    </div>
  )
}
