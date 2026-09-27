// Turns a catalog release-date string into the wording the title screen
// shows next to it — the movie meta line, an unreleased movie's Play
// button, and every episode row's air-date line all read from this one
// function (Title.tsx), so the three can never disagree about what "in 5
// days" means or how a date is formatted.
//
// Built on the shared date parse (parseReleaseDate) rather than a fresh
// `new Date(string)` — that parse already carries the fix for reading a
// bare YYYY-MM-DD as LOCAL midnight (see releaseDate.ts's own doc comment),
// which is exactly what keeps this countdown and hasAired's aired/unaired
// verdict from disagreeing about which calendar day a date names.
import { parseReleaseDate } from '@shared/media-hub/releaseDate'

const DAY_MS = 86_400_000

// Locale-formatted, so an already-released date always reads as a real
// date ("12 Oct 2026") rather than the raw ISO/date-only string a catalog
// source hands over.
const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric'
})

export interface ReleaseCountdown {
  /** Whether the exact instant `date` names has already passed. */
  released: boolean
  /** What to show: a short date once released; before that, "Today" /
   *  "Tomorrow" / "In N days" out to about a month, then the date itself
   *  prefixed with `verb` ("Releases" / "Airs"). */
  label: string
}

function startOfLocalDay(instant: number): number {
  const date = new Date(instant)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/**
 * `dateString` unparseable/absent -> null (the caller decides what that
 * means — a gap for an aired episode, "TBA" for an unaired one).
 *
 * Day-count wording ("Tomorrow", "In 5 days") compares LOCAL calendar
 * days, not a raw instant difference and not UTC days — an episode airing
 * at 01:00 tomorrow must read "Tomorrow" the moment today ends, in
 * whatever timezone the viewer is actually in, matching how
 * `parseReleaseDate` itself reads a bare date as local midnight. `now` is
 * injectable so callers (and any future test) can pin the clock.
 */
export function releaseCountdown(
  dateString: string | undefined | null,
  verb: 'Releases' | 'Airs',
  now: number = Date.now()
): ReleaseCountdown | null {
  const date = parseReleaseDate(dateString)
  if (!date) return null
  const at = date.getTime()
  const formatted = DATE_FORMATTER.format(date)
  if (at <= now) return { released: true, label: formatted }

  const dayDiff = Math.round((startOfLocalDay(at) - startOfLocalDay(now)) / DAY_MS)
  if (dayDiff <= 0) return { released: false, label: 'Today' }
  if (dayDiff === 1) return { released: false, label: 'Tomorrow' }
  if (dayDiff <= 30) return { released: false, label: `In ${dayDiff} days` }
  return { released: false, label: `${verb} ${formatted}` }
}
