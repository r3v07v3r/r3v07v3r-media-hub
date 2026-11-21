// Reading a stored runtime as a number of minutes.
//
// The value is a DISPLAY string from whichever source supplied the title —
// "48 min", "2h 15m", "1 h 30", or a bare "148" — so the shape has to be
// recognised rather than assumed. Taking the first number, which is what the
// renderer's own copy of this did, read "1h 40min" as one minute: every
// feature film in the catalog showed a runtime of "1 min" to "3 min" on its
// card, and the viewing-stats estimate under-reported a film by most of its
// length for the same reason.
//
// Lives in shared/ because both processes ask the same question of the same
// strings: main for the stats estimate, the renderer for every runtime it
// displays or filters on. One parser means they cannot disagree.

/**
 * How much of a runtime string is looked at. Every real form ("48 min",
 * "2h 15m", "1 h 30", "148") fits comfortably; in main the value comes from
 * plays.metadata_json, which a restored backup writes verbatim, so it has no
 * length limit of its own.
 */
export const MAX_RUNTIME_TEXT = 64

/**
 * The runtime `value` describes, in whole minutes, or undefined when the
 * string carries no recognisable duration.
 *
 * Anything unrecognisable is undefined rather than a guess — a title
 * contributing nothing to an estimate is honest, where a wrong number is not.
 *
 * Bounded work: the input is truncated to MAX_RUNTIME_TEXT and every digit
 * run in the patterns has a fixed upper length. The previous unanchored
 * /(\d+)\s*h/ backtracked quadratically over a long digit run with no 'h',
 * which a crafted backup row could use to stall the main process whenever
 * the stats view was opened.
 */
export function parseRuntimeMinutes(value: unknown): number | undefined {
  const text = String(value ?? '')
    .slice(0, MAX_RUNTIME_TEXT)
    .toLowerCase()
  if (!text) return undefined
  // An explicit hours-and-minutes form wins, including when the minutes are
  // absent ("2h") or unlabelled ("1 h 30").
  const hours = /(\d{1,3})\s{0,3}h/.exec(text)
  if (hours) {
    const rest = text.slice(hours.index + hours[0].length)
    const minutes = /(\d{1,4})/.exec(rest)
    const total = Number(hours[1]) * 60 + (minutes ? Number(minutes[1]) : 0)
    return total > 0 ? total : undefined
  }
  const plain = /(\d{1,5})/.exec(text)
  if (!plain) return undefined
  const total = Number(plain[1])
  return total > 0 ? total : undefined
}

/** As {@link parseRuntimeMinutes}, but 0 for an unrecognisable value — for
 *  the summing callers, where "unknown" and "adds nothing" are the same
 *  thing and an optional number would only be coalesced away. */
export function runtimeMinutesOrZero(value: unknown): number {
  return parseRuntimeMinutes(value) ?? 0
}
