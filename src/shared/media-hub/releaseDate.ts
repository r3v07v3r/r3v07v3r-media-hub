// The one parse for a release date, shared by main and the renderer.
//
// Every rule that asks "is this out yet" — hasAired (catalog-logic.ts),
// the upcoming-episode rules (upcomingEpisodes.ts), the renderer's
// isFutureRelease/isUpcomingEpisode — must read a date string the same way,
// or the tile that blocks Play and the rule that counts progress disagree
// by a timezone's worth of hours around every release. They used to: the
// renderer parsed a bare day as LOCAL midnight while main parsed it as UTC
// midnight, and west of Greenwich an episode AniList had confirmed aired
// stayed blocked for the difference.

/** A bare YYYY-MM-DD is built from local calendar components rather than
 *  handed to `new Date(string)`, which per spec reads a date-ONLY string
 *  as UTC midnight (a date-TIME string without an offset is read as local
 *  — the inconsistency is the trap). Cinemeta/Kitsu/TMDB dates are
 *  date-only, so west of Greenwich a plain `new Date(released)` would read
 *  a title as released a day earlier than it actually is — mattering most
 *  exactly on release day itself. Anything with a time in it still goes
 *  through the normal parse, as the instant it names. */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

/** True for a bare calendar day — the shape every catalogue source
 *  (Kitsu's airdate, TMDB's air_date, Cinemeta's released) hands over, as
 *  opposed to the ISO instants this app learns from AniList's schedule. */
export function isDateOnly(date: string | undefined | null): boolean {
  return DATE_ONLY.test(String(date ?? '').trim())
}

export function parseReleaseDate(date: string | undefined | null): Date | null {
  if (!date) return null
  const parts = DATE_ONLY.exec(date.trim())
  const parsed = parts
    ? new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
    : new Date(date)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** The instant a release date names, or null for none/unparseable. */
export function releaseInstant(date: string | undefined | null): number | null {
  const parsed = parseReleaseDate(date)
  return parsed ? parsed.getTime() : null
}
