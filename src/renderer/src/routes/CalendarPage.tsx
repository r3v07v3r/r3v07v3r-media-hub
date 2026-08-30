'use client'

// What is airing, on its own page.
//
// It lived as one tab inside My Stuff, behind a strip of eight — which put
// the one view somebody opens to answer "is there anything on tonight"
// two clicks deep, next to Stats and Not for me. It is a different
// question from "what have I collected", so it is a different page.
//
// The view itself is unchanged: the same waiting-for strip over the same
// six-and-a-half-week grid, reading the same catalog.calendar() feed.

import { useEffect, useMemo, useState } from 'react'
import type { CalendarEntry } from '@shared/media-hub/types'
import type { MediaItem } from '@renderer/types'
import { useAppState } from '@renderer/context/AppStateContext'
import { useRestoreBrowsingOrigin } from '@renderer/lib/mediaHub/useRestoreBrowsingOrigin'
import styles from './MyStuff.module.css'

export default function CalendarPage() {
  useRestoreBrowsingOrigin(true)
  return (
    <div className={styles.wrap}>
      <h1 className={styles.heading}>Calendar</h1>
      <p className={styles.headingDescription}>
        Episodes airing for the shows on your list, a week back and six weeks ahead.
      </p>
      <CalendarView />
    </div>
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
        Nothing scheduled. Only shows you have planned appear here, and their episode lists fill in
        over several sessions in the background — so a show you added a moment ago may not be
        covered yet.
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
