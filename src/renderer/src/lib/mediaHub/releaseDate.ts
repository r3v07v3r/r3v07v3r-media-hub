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

/** A TITLE's release date: true only when the date is real AND strictly
 *  after today's calendar day. A title that released earlier today is not
 *  "coming soon" just because playback hasn't caught up with it yet.
 *
 *  Compares calendar days, not instants, because a title's release is a
 *  day, not a moment, however its source spells it: Cinemeta writes a
 *  film's release day as a midnight-UTC datetime, and an instant compare
 *  would keep that film "unreleased" until 09:00 in Tokyo and "released"
 *  from the previous evening in Los Angeles. Normalizing both sides to
 *  local midnight makes "today" compare equal, not greater.
 *
 *  For an EPISODE, use isFutureInstant: a broadcast is a moment. */
export function isFutureRelease(date: string | undefined, now: number = Date.now()): boolean {
  const parsed = parseReleaseDate(date)
  if (!parsed) return false
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const releaseDay = new Date(parsed)
  releaseDay.setHours(0, 0, 0, 0)
  return releaseDay.getTime() > today.getTime()
}

/** An EPISODE's air date: true only when the date is real AND still ahead
 *  of now, as the instant it names. A bare calendar day (Kitsu, TMDB,
 *  Cinemeta) parses to local midnight, so a day dated today reads as out
 *  all day and one dated tomorrow as coming until midnight — the same
 *  calendar-day answer isFutureRelease gives. A full datetime is a
 *  broadcast moment: an episode AniList schedules for 20:00 UTC today is
 *  not out at 09:00, and the tile must not offer Play for it. This is the
 *  rule hasAired (shared/media-hub/catalog-logic.ts) applies to the same
 *  string, so the grid and the next-up card cannot disagree about an
 *  episode airing later today. */
export function isFutureInstant(date: string | undefined, now: number = Date.now()): boolean {
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
 *  (isFutureInstant, so an episode out earlier today is not "coming" and
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
  if (parseReleaseDate(episode.released)) return isFutureInstant(episode.released, now)
  return episode.upcoming === true
}

/**
 * Why a title on a card or the Home hero must not offer Play yet, in the
 * words to show instead — or null for one that is out.
 *
 * The full date rules when there is one ("Releases 12 Mar 2027", by
 * isFutureRelease's calendar-day compare). Without one, a bare year ahead
 * of this one is still proof enough ("Coming 2027"): the index carries
 * only `year` for rows written before it learned release dates, and a
 * title dated next year is not out whatever its day turns out to be. A
 * source's own word for a title with no date at all — Kitsu lists an
 * unaired anime as "upcoming" — is the last resort ("Coming soon").
 *
 * A title out earlier this year with no full date reads as out, which is
 * the right default: offering Play on a film that released in March is
 * ordinary, and the detail page, which fetches the full record, has the
 * last word on the ones this cannot tell apart.
 */
export function titleUnreleased(
  media: { releaseDate?: string; releaseYear?: number; status?: string },
  now: number = Date.now()
): string | null {
  if (parseReleaseDate(media.releaseDate)) {
    if (!isFutureRelease(media.releaseDate, now)) return null
    const formatted = formatReleaseDate(media.releaseDate)
    return formatted ? `Releases ${formatted}` : 'Not yet released'
  }
  if (media.releaseYear && media.releaseYear > new Date(now).getFullYear()) {
    return `Coming ${media.releaseYear}`
  }
  const status = String(media.status || '').toLowerCase()
  if (status === 'upcoming' || status === 'unreleased') return 'Coming soon'
  return null
}
