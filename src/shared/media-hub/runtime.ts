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
 * The runtime `value` describes, in whole minutes, or undefined when the
 * string carries no recognisable duration.
 *
 * Anything unrecognisable is undefined rather than a guess — a title
 * contributing nothing to an estimate is honest, where a wrong number is not.
 */
export function parseRuntimeMinutes(value: unknown): number | undefined {
  const text = String(value ?? '').toLowerCase()
  if (!text) return undefined
  // An explicit hours-and-minutes form wins, including when the minutes are
  // absent ("2h") or unlabelled ("1 h 30").
  const hours = text.match(/(\d+)\s*h/)
  if (hours) {
    const rest = text.slice(text.indexOf(hours[0]) + hours[0].length)
    const minutes = rest.match(/(\d+)/)
    const total = Number(hours[1]) * 60 + (minutes ? Number(minutes[1]) : 0)
    return total > 0 ? total : undefined
  }
  const plain = text.match(/(\d+)/)
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
