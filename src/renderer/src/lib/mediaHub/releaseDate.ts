// Shared "has this actually come out yet" logic for movies, series and
// anime — used by DetailHero (the Play button), AboutPanel (the About
// panel's Released fact) and EpisodesSection (per-episode tiles), so a
// title/episode reads the same everywhere rather than each panel guessing
// independently.

/** A bare YYYY-MM-DD is built from local calendar components rather than
 *  handed to `new Date(string)`, which per spec reads a date-ONLY string as
 *  UTC midnight (a date-TIME string without an offset is read as local —
 *  the inconsistency is the trap). Cinemeta/Kitsu dates are date-only, so
 *  west of Greenwich a plain `new Date(released)` would read a title as
 *  released a day earlier than it actually is — mattering most exactly on
 *  release day itself. Anything with a time in it still goes through the
 *  normal parse. */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

export function parseReleaseDate(date: string | undefined): Date | null {
  if (!date) return null
  const parts = DATE_ONLY.exec(date.trim())
  const parsed = parts
    ? new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
    : new Date(date)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** True only when the date is real AND strictly after today — a title that
 *  released earlier today is not "coming soon" just because playback
 *  hasn't caught up with it yet.
 *
 *  Compares calendar days, not instants: a source can hand this a full ISO
 *  datetime (CatalogItem.releaseDate allows one), and a bare instant
 *  comparison against local midnight would keep a title released EARLIER
 *  TODAY reading as "future" for the rest of the day — any time past
 *  00:00:00 is later than midnight, so the compare never flips false until
 *  the calendar date itself rolls over. Normalizing both sides to midnight
 *  first makes "today" compare equal, not greater. */
export function isFutureRelease(date: string | undefined): boolean {
  const parsed = parseReleaseDate(date)
  if (!parsed) return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const releaseDay = new Date(parsed)
  releaseDay.setHours(0, 0, 0, 0)
  return releaseDay.getTime() > today.getTime()
}

/** "12 Mar 2003" — compact, locale-aware. Null for an empty/unparseable date. */
export function formatReleaseDate(date: string | undefined): string | null {
  const parsed = parseReleaseDate(date)
  if (!parsed) return null
  return parsed.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Has this episode still to come out? The date decides when there is one
 *  (isFutureRelease's calendar-day rule, so an episode out earlier today is
 *  not "coming"); with no usable date, main's own verdict on `upcoming`
 *  does — see Episode.upcoming (shared/media-hub/types.ts) for how it is
 *  reached and why the date takes precedence over it. The tile grid,
 *  its multi-select and its per-tile menu all ask this one question, so
 *  an episode can never be selectable but not playable, or the reverse. */
export function isUpcomingEpisode(episode: { released?: string; upcoming?: boolean }): boolean {
  if (parseReleaseDate(episode.released)) return isFutureRelease(episode.released)
  return episode.upcoming === true
}
