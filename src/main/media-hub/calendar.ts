// What is airing, and what just did.
//
// `airing` and `newEpisodeCount` have been computed for every tracked title
// for a long time and have only ever driven a badge. The air dates behind them
// are sitting in each title's cached episode list, which makes the calendar
// every competitor has — Sonarr's, Trakt's, Simkl's, AniList's — a matter of
// reading data this app already holds rather than a new integration.
//
// Cache-first, deliberately. This answers a tab somebody opened, and a cold
// read of every tracked title would be one network round trip per show before
// anything appeared. `metadata()` serves its 24-hour cache when it has one, so
// an ordinary session answers from disk; a title never opened contributes
// nothing until the background passes have covered it, and the empty state
// says so rather than implying the show has no episodes coming.

import type { CalendarEntry, CatalogItem, Episode } from '../../shared/media-hub/types'
import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import { metadata } from './catalog'
import { getDatabase } from './dbState'
import { handle } from './ipcGuard'
import { mapWithLimit } from './taskScheduler'

/** How far back the window reaches. A week covers "did I miss one" without
 *  turning the view into a second history. */
const PAST_DAYS = 7
/** And how far forward. Beyond about six weeks the schedules stop being
 *  reliable — announced dates move — so promising more would be promising
 *  something the sources cannot keep. */
const FUTURE_DAYS = 42

/** Bounded for the same reason every other fan-out in this app is: a tracked
 *  list of two hundred shows must not become two hundred concurrent reads. */
const CONCURRENCY = 6

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * Episodes of one title inside the window.
 *
 * `unplayable` entries are skipped — they are the synthetic Specials bucket
 * (see core.ts's disambiguateVideos), which carries no real coordinate and
 * frequently no meaningful date either.
 */
function withinWindow(
  item: CatalogItem,
  videos: Episode[] | undefined,
  from: number,
  to: number
): CalendarEntry[] {
  const out: CalendarEntry[] = []
  for (const video of videos ?? []) {
    if (video.unplayable) continue
    const released = String(video.released || '').trim()
    if (!released) continue
    const at = new Date(released).getTime()
    if (!Number.isFinite(at) || at < from || at > to) continue
    out.push({
      contentId: String(item.id),
      type: item.type,
      title: String(item.title ?? 'Untitled'),
      poster: String(item.poster ?? ''),
      season: Number(video.season),
      episode: Number(video.episode),
      episodeTitle: String(video.title ?? ''),
      airsOn: dayKey(new Date(at))
    })
  }
  return out
}

/**
 * Every tracked show's episodes inside the window, oldest first.
 *
 * Movies are excluded rather than dated by release: a film's release date is
 * not something the person is waiting on episode by episode, and mixing the
 * two turns a schedule into a list of things that came out.
 */
export async function upcomingEpisodes(now = new Date()): Promise<CalendarEntry[]> {
  const from = now.getTime() - PAST_DAYS * 86_400_000
  const to = now.getTime() + FUTURE_DAYS * 86_400_000

  const tracked = getDatabase()
    .tracked()
    .filter((item) => item.type !== 'movie')
  if (tracked.length === 0) return []

  const details = await mapWithLimit(
    tracked,
    async (item) => {
      try {
        return await metadata(item.type, item.id, 'background')
      } catch {
        // One unreachable title costs its own rows, never the calendar.
        return null
      }
    },
    CONCURRENCY
  )

  const entries: CalendarEntry[] = []
  for (const item of details) {
    if (!item) continue
    entries.push(...withinWindow(item, item.videos, from, to))
  }

  // Sorted by date, then by the title and episode within a day, so a show
  // dropping a whole season at midnight reads in order rather than shuffled.
  entries.sort(
    (a, b) =>
      a.airsOn.localeCompare(b.airsOn) ||
      a.title.localeCompare(b.title) ||
      a.season - b.season ||
      a.episode - b.episode
  )
  return entries
}

export function registerCalendarIpc(): void {
  handle<undefined, { entries: CalendarEntry[] }>(MEDIA_HUB_CHANNELS.calendarGet, async () => ({
    entries: await upcomingEpisodes()
  }))
}
