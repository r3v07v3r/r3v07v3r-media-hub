// The one serial chain per title, for every remote push about that title:
// watch history (tracking.ts), plan and un-plan (watchlists.ts), and
// scrobbles. They act on the same title at the same services — marking a
// title watched takes it off the Trakt watchlist, the undo puts it back —
// so they take turns on one chain and none can overtake another. A second
// queue anywhere is a second order: pushes on two chains do not wait on
// each other, whatever either chain promises about itself.
// tests/serialQueue.test.ts holds the main process to this one.
//
// Imports nothing but the queue itself — no electron, no tracking.ts, no
// watchlists.ts — so both of those can import it without a cycle, and a
// plain tsx test can load it.
//
// KEYED BY THE ID ALONE. Local identity is the id alone (db.isTracked(id),
// db.untrack(id), db.unmarkWatched(item.id)), and callers disagree on
// `type`: the mark, unmark and season handlers pass the renderer's, which
// may be undefined, while trackingToggle and setTitleStatus default it to
// 'movie'. A key that included it put one title on two chains. The mark,
// plan and title-status callers pass the id canonicalWriteId gave them;
// the scrobble handler keys on payload.item.id as the player sent it, so a
// scrobble for a legacy Simkl-keyed card can still run on a different
// chain from that title's marks.
//
// NEVER ENQUEUE FROM INSIDE A TASK AND AWAIT IT. A task that queues on its
// own key and waits for the result is waiting behind itself: the title's
// chain hangs until restart, and every later push for it silently stops.
// Code already running on the chain calls the work directly (see
// applyLocalPlanChange in watchlists.ts).
//
// WHAT THIS DOES NOT DO. It orders pushes; it does not make them arrive.
// What does is kept elsewhere: a history push that fails is written down
// and retried with the next sync (historyRetry.ts, through tracking.ts),
// and so is a plan change (planned:pending-removals in watchlists.ts). Both
// retries run on this chain, so they stay in order with the pushes made
// since.

import { createKeyedSerialQueue } from '../../shared/media-hub/serialQueue'

export const titlePushQueue = createKeyedSerialQueue()

/** The chain a title's pushes run on: its id, and nothing else. */
export function titlePushKey(item: { id: string | number }): string {
  return String(item.id)
}
