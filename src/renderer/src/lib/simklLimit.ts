/** Simkl's own page where the person sees today's requests per app. */
export const SIMKL_CONNECTED_APPS_URL = 'https://simkl.com/settings/connected-apps/'

/**
 * When a spent Simkl allowance comes back, in the viewer's own clock: "at
 * 6:00 AM" today, "tomorrow at 6:00 AM", or a weekday further out (a reset
 * is at most a day away, but a clock change or a long-asleep machine can
 * make it read oddly, so the date is said rather than guessed).
 */
export function simklResetLabel(until: number, now: number = Date.now()): string {
  const at = new Date(until)
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const today = new Date(now)
  const tomorrow = new Date(now)
  tomorrow.setDate(today.getDate() + 1)
  if (at.toDateString() === today.toDateString()) return `at ${time}`
  if (at.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`
  return `on ${at.toLocaleDateString([], { weekday: 'long' })} at ${time}`
}

/** The one sentence both the toast and the Simkl card say. */
export function simklLimitMessage(until: number, now: number = Date.now()): string {
  return (
    `Simkl's daily request limit for your account is used up, so nothing is being sent to Simkl right now. ` +
    `What you watch is saved here and synced ${simklResetLabel(until, now)}.`
  )
}
