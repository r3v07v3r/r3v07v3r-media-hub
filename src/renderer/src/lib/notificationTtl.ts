// How long a toast stays before it removes itself. Kept out of
// OverlayContext.tsx, which uses it, so tests/statusActions.test.ts can
// import it without importing a component module.

import type { AppNotification } from '@renderer/types'

/** How long a toast stays on screen before it removes itself. */
const NOTIFICATION_TTL_MS = 4200
/** Errors get longer: they are read after the fact, not glanced at. */
const ERROR_TTL_MS = 10_000

/**
 * When a toast removes itself, or null for one that waits to be dismissed.
 *
 * An error that offers an action — "Couldn't start playback. Retry" — used
 * to vanish on the same 4.2s timer as "Synced 3 titles", taking its only
 * Retry with it. Two seconds of that were spent looking at a spinner, so
 * what a person saw was a Play button that did nothing and no explanation
 * anywhere. Such a toast now stays until the action is taken or it is
 * dismissed with its own close control (NotificationLayer offers one).
 */
export function notificationTtlMs(
  notification: Pick<AppNotification, 'tone' | 'action' | 'durationMs'>
): number | null {
  // A toast that names its own lifetime keeps it — see durationMs.
  if (notification.durationMs !== undefined) return notification.durationMs
  // Anything else offering an action stays until it is used or dismissed: an
  // "Undo" that vanishes four seconds after a sixty-episode mark is not a
  // way back. The close button is always there.
  if (notification.action) return null
  return notification.tone !== 'error' ? NOTIFICATION_TTL_MS : ERROR_TTL_MS
}

/** The most toasts on screen at once. The column has no scroll of its own,
 *  and a toast that waits to be dismissed (an error with Retry, an Undo)
 *  would otherwise stack once per failed Play until each was closed by hand. */
export const MAX_NOTIFICATIONS = 8

type Placed = Pick<AppNotification, 'tone' | 'message' | 'action' | 'durationMs' | 'profileId'>

/** Whether two toasts say the same thing: same tone, words, action and
 *  profile. A second one replaces the first rather than standing under it. */
function sameNotification(a: Placed, b: Placed): boolean {
  return (
    a.tone === b.tone &&
    a.message === b.message &&
    a.action?.label === b.action?.label &&
    a.profileId === b.profileId
  )
}

/**
 * The toasts on screen once `next` is added, and the ones it pushed off
 * (their timers are the caller's to clear). An earlier toast saying the same
 * thing goes, so a fourth failed Play of the same title leaves one Retry,
 * and past MAX_NOTIFICATIONS the oldest goes, one that would have left by
 * itself first: a waiting Undo or Retry is kept over a passing "Synced".
 * `next` itself is always kept.
 */
export function addNotification<T extends Placed>(
  current: readonly T[],
  next: T
): { kept: T[]; dropped: T[] } {
  const dropped = current.filter((x) => sameNotification(x, next))
  const kept = current.filter((x) => !dropped.includes(x))
  while (kept.length >= MAX_NOTIFICATIONS) {
    const timed = kept.findIndex((x) => notificationTtlMs(x) !== null)
    const [gone] = kept.splice(timed >= 0 ? timed : 0, 1)
    dropped.push(gone)
  }
  kept.push(next)
  return { kept, dropped }
}
