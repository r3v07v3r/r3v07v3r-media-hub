// New (not a port) — the bookkeeping half of "keep local" in the
// out-of-sync review (see main/media-hub/tracking.ts, which owns the
// actual pushes, and components/overlays/SyncReviewPanel.tsx, which is
// where someone clicks the button).
//
// Picking "keep local" used to be fire-and-forget: the row disappeared,
// one Simkl POST went out, and whatever happened to it — an error, an
// offline machine, a title Simkl answered 200 for but never actually
// matched — was swallowed. The decision itself was never written down
// anywhere, so the next launch recomputed the same disagreement and
// asked about the same titles again, forever. This module is the
// written-down decision: a persisted queue of pushes that survives a
// failed attempt, and the two pure state transitions over it, kept here
// (electron-free, shared) so they're testable without an app harness —
// see tests/reconcileSync.test.ts.

import type { PendingWatchStatusPush } from './types'

/** How many failed flushes an entry survives before it's dropped and
 *  reported as abandoned. A push that has failed five separate times is
 *  not going to start working on the sixth — at that point the honest
 *  thing is to say so out loud rather than retry it on every launch for
 *  the life of the install. */
export const PENDING_PUSH_MAX_ATTEMPTS = 5

/** Adds (or replaces) one decision in the queue. Keyed by id, so clicking
 *  "keep local" twice on the same title — a genuine case, since a push
 *  that never landed lets the title resurface for a second ruling —
 *  re-arms it with a fresh attempt budget instead of queueing it twice. */
export function queuePendingPush(
  queue: PendingWatchStatusPush[],
  entry: PendingWatchStatusPush
): PendingWatchStatusPush[] {
  return [...queue.filter((x) => x.id !== entry.id), { ...entry, attempts: 0 }]
}

export interface PushOutcome {
  queue: PendingWatchStatusPush[]
  abandoned: PendingWatchStatusPush[]
}

/**
 * Folds one flush's results back into the queue: confirmed entries leave,
 * failed ones stay with their attempt count bumped (until the cap, at
 * which point they leave as `abandoned` and are reported), and entries in
 * neither set are left exactly as they are — a flush is asynchronous, and
 * anything queued while it was in flight has not been attempted yet and
 * must not inherit that flush's verdict.
 */
export function applyPushOutcome(
  queue: PendingWatchStatusPush[],
  confirmedIds: Iterable<string>,
  failedIds: Iterable<string>,
  maxAttempts: number = PENDING_PUSH_MAX_ATTEMPTS
): PushOutcome {
  const confirmed = new Set(confirmedIds)
  const failed = new Set(failedIds)
  const next: PendingWatchStatusPush[] = []
  const abandoned: PendingWatchStatusPush[] = []
  for (const entry of queue) {
    if (confirmed.has(entry.id)) continue
    if (!failed.has(entry.id)) {
      next.push(entry)
      continue
    }
    const attempted = { ...entry, attempts: entry.attempts + 1 }
    if (attempted.attempts >= maxAttempts) abandoned.push(attempted)
    else next.push(attempted)
  }
  return { queue: next, abandoned }
}

/**
 * Teaches entries that stayed queued what this flush already did to the
 * remote side. An entry is pushed and then kept — because the local
 * state moved underneath it mid-request, or because a second service
 * refused it — and its recorded `remoteWatched` is now out of date by
 * exactly the push that just succeeded. Left alone, the next flush
 * weighs the current local value against that stale record, concludes
 * the two sides agree on their own, and drops the decision without ever
 * undoing what went out.
 *
 * `pushedValue` maps an id to the value a successful request actually
 * sent; entries with no entry there were never pushed and are returned
 * untouched.
 */
export function withPushedRemoteState(
  queue: PendingWatchStatusPush[],
  pushedValue: ReadonlyMap<string, boolean>
): PendingWatchStatusPush[] {
  return queue.map((entry) => {
    const pushed = pushedValue.get(entry.id)
    return pushed === undefined || pushed === entry.remoteWatched
      ? entry
      : { ...entry, remoteWatched: pushed }
  })
}
