// Which country's rules apply.
//
// This module used to fetch streaming availability from TMDB (which
// carries JustWatch's data) for a "Where to watch" panel on every detail
// page. That panel is gone: a request and a parse per title, for
// rent-and-buy links, is the least useful thing this app could spend a
// round trip on.
//
// The region survived it, because two other things genuinely need to know
// it — content ratings are certified per country, and the settings
// snapshot shows the person which region the app thinks they are in. The
// file keeps its name so the imports that ask for a region do not all
// have to move for a deletion elsewhere.

import { readSettings } from './settingsStore'

/**
 * Electron, resolved at CALL time rather than imported at load time — the
 * same pattern settingsStore.ts and logger.ts carry, for the same reason.
 * `require('electron')` throws when the binary is absent, which is exactly
 * what CI's `npm ci --ignore-scripts` produces, and this module is reached
 * from preferences.ts, whose pure resolution logic is unit tested outside
 * Electron. The one use below runs only in the real app.
 */
function electron(): typeof import('electron') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('electron')
}

/**
 * The region to answer for.
 *
 * A stored setting wins. Failing that, the second half of the machine's own
 * locale ("en-GB" -> "GB") is a far better guess than any fixed default: it is
 * usually right, and when it is wrong it is wrong in a way somebody can see
 * and correct in Settings.
 */
export function watchRegion(): string {
  const stored = String(readSettings().watchRegion || '')
    .trim()
    .toUpperCase()
  if (/^[A-Z]{2}$/.test(stored)) return stored
  // Guarded, not just deferred. readSettings() above already answers {}
  // when there is no Electron to find a settings file with; this is the
  // other half of the same tolerance. The locale is a GUESS at the region —
  // one that is wrong often enough to be correctable in Settings — so a
  // guess that throws is strictly worse than falling through to the default
  // below.
  let locale = ''
  try {
    locale = electron().app?.getLocale?.() ?? ''
  } catch {
    // Not running inside Electron. 'US' it is.
  }
  const guess = locale.split(/[-_]/)[1]?.toUpperCase() ?? ''
  return /^[A-Z]{2}$/.test(guess) ? guess : 'US'
}
