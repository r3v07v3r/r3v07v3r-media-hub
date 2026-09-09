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
 *  hasn't caught up with it yet. */
export function isFutureRelease(date: string | undefined): boolean {
  const parsed = parseReleaseDate(date)
  if (!parsed) return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return parsed.getTime() > today.getTime()
}

/** "12 Mar 2003" — compact, locale-aware. Null for an empty/unparseable date. */
export function formatReleaseDate(date: string | undefined): string | null {
  const parsed = parseReleaseDate(date)
  if (!parsed) return null
  return parsed.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}
