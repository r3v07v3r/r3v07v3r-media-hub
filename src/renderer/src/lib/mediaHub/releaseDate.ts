// Shared "has this actually come out yet" logic for movies, series and
// anime — used by DetailHero (the Play button), AboutPanel (the About
// panel's Released fact) and EpisodesSection (per-episode tiles), so a
// title/episode reads the same everywhere rather than each panel guessing
// independently.

import { parseReleaseDate } from '@shared/media-hub/releaseDate'

// The parse itself lives in shared/media-hub/releaseDate.ts now, so that
// hasAired and the upcoming-episode rules in main read a bare calendar day
// exactly as this file does (local midnight); re-exported so this module's
// callers are unchanged.
export { parseReleaseDate }

/** True only when the date is real AND still ahead of now.
 *
 *  A bare instant comparison, on purpose. A date-only string parses to
 *  LOCAL midnight (parseReleaseDate), so a title dated today has been "out"
 *  since 00:00 and reads as released all day, and one dated tomorrow reads
 *  as coming until midnight — the calendar-day answer, with no day
 *  truncation needed. A full datetime is compared as the instant it names:
 *  an episode AniList schedules for 20:00 UTC today is not out at 09:00,
 *  and the tile must not offer Play for it — the same rule hasAired
 *  (shared/media-hub/catalog-logic.ts) applies to the same string, so the
 *  grid and the next-up card cannot disagree about an episode airing later
 *  today. This used to truncate both sides to local midnight, which made
 *  exactly that episode playable from midnight on. */
export function isFutureRelease(date: string | undefined, now: number = Date.now()): boolean {
  const parsed = parseReleaseDate(date)
  if (!parsed) return false
  return parsed.getTime() > now
}

/** "12 Mar 2003" — compact, locale-aware. Null for an empty/unparseable date. */
export function formatReleaseDate(date: string | undefined): string | null {
  const parsed = parseReleaseDate(date)
  if (!parsed) return null
  return parsed.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Has this episode still to come out? The date decides when there is one
 *  (isFutureRelease, so an episode out earlier today is not "coming" and
 *  one airing later today still is); with no usable date, main's own
 *  verdict on `upcoming` does — see Episode.upcoming
 *  (shared/media-hub/types.ts) for how it is reached and why the date
 *  takes precedence over it. The tile grid, its multi-select and its
 *  per-tile menu all ask this one question, so an episode can never be
 *  selectable but not playable, or the reverse. */
export function isUpcomingEpisode(
  episode: { released?: string; upcoming?: boolean },
  now: number = Date.now()
): boolean {
  if (parseReleaseDate(episode.released)) return isFutureRelease(episode.released, now)
  return episode.upcoming === true
}
