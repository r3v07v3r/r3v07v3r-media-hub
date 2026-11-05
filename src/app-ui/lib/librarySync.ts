// HOW THE PHONE AND TV APP LEARNS WHAT WAS WATCHED ELSEWHERE.
//
// The desktop settles its tracking services in a review panel; this app has
// none, so it asks the backend for a catch-up instead (tracking.catchUp — see
// main/media-hub/simklCatchUp.ts): the watchlist pull, then what Simkl says
// was watched. It asks when the app opens, whenever it comes back to the
// front, and a few more times on its own after a pass fails (see
// retryFailedPass); the screens that show the library refetch when a pass
// reports a change.
//
// A module-level store, read through useSyncExternalStore, for the same
// reason the desktop's updater status is one (renderer/src/hooks/
// updateStatusStore.ts): the pass is started by the shell, not by a screen,
// and a screen that mounts mid-pass has to see that it is running.

import { useEffect, useEffectEvent, useSyncExternalStore } from 'react'
import type { CatchUpReport } from '@shared/media-hub/types'
import { api } from './api'

export interface CatchUpSnapshot {
  /** A pass this app asked for has not answered yet. */
  inFlight: boolean
  /** The newest answer, or null before the first one. */
  report: CatchUpReport | null
}

/** How long to wait before asking again when a pass put part of its work off
 *  (anime, until the catalog has been organised into its seasons). */
const DEFERRED_RETRY_MS = 3 * 60 * 1000

/** How many times a failed pass is asked again, each wait twice the last:
 *  three minutes, then 6, 12, 24 and 48, so the last ask comes an hour and a
 *  half after the failure. The waits have to outgrow the backend's own
 *  backoffs (simklCatchUp.ts: five minutes for Simkl's activities, doubling
 *  to an hour, and half an hour for a library read), which a pass inside
 *  sits out without asking Simkl at all; asks every three minutes would all
 *  land inside the half-hour one. Past the last the backend is down, and
 *  polling it for the rest of the session would be noise. The next resume
 *  still asks. */
const FAILED_RETRY_LIMIT = 5

/** How long a burst of change signals is collapsed for before one refetch. */
const REFRESH_DEBOUNCE_MS = 800

/** Replaced wholesale on every change, never mutated: useSyncExternalStore
 *  compares snapshots by identity and would miss an in-place edit. */
let snapshot: CatchUpSnapshot = { inFlight: false, report: null }
const listeners = new Set<() => void>()
let running = false
/** A forced pass was asked for while another was running — see requestCatchUp. */
let forceAfter = false
let retryTimer: number | undefined
/** Asks made since a pass failed. A run of them goes on to the limit
 *  whatever the passes in between bring (see requestCatchUp); the first
 *  clean answer after it, or a fresh link, starts the count over. */
let failedPasses = 0
/** The wait of the failed-pass retry armed and not yet answered by a pass
 *  that ran, or 0. Kept apart from the count, which is already at the limit
 *  while the last retry is still to come. */
let owedRetryMs = 0

function update(patch: Partial<CatchUpSnapshot>): void {
  snapshot = { ...snapshot, ...patch }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function read(): CatchUpSnapshot {
  return snapshot
}

function playerIsUp(): boolean {
  return window.location.hash.startsWith('#/player')
}

/**
 * Asks again in a few minutes (or after `ms`), for a pass that put part of
 * its work off or failed.
 *
 * One timer, replaced rather than stacked, so a run of deferred answers
 * never turns into a run of overlapping retries. And one that waits the
 * player out: a request made while something is playing is refused, and
 * leaving the player is not a resume — on a TV that stays in the foreground
 * nothing else would ever ask again, and the part that was put off would
 * stay put off for the whole session. It looks again every few minutes
 * while the player is up, whatever the first wait was, so a retry that is
 * owed comes soon after the player closes.
 */
function armDeferredRetry(ms = DEFERRED_RETRY_MS): void {
  window.clearTimeout(retryTimer)
  retryTimer = window.setTimeout(() => {
    // Nothing armed from here on unless something arms it again: how an
    // answer tells it came from this ask rather than a resume's.
    retryTimer = undefined
    if (playerIsUp()) armDeferredRetry()
    else requestCatchUp()
  }, ms)
}

/**
 * Asks again after a pass that failed or reported an error, and after each
 * pass of the run that follows it, on the same timer, each wait twice the
 * last (see FAILED_RETRY_LIMIT). Without it the next ask is the next
 * resume, and a TV that stays in the foreground may never have one. Capped
 * so a dead backend is not polled for the whole session.
 */
function retryFailedPass(): void {
  if (failedPasses >= FAILED_RETRY_LIMIT) return
  failedPasses += 1
  owedRetryMs = DEFERRED_RETRY_MS * 2 ** (failedPasses - 1)
  armDeferredRetry(owedRetryMs)
}

/**
 * Ask the backend to catch up. Safe to call as often as anything likes: the
 * backend answers a call made within a couple of minutes of the last pass, or
 * during one, with that pass's report rather than doing the work again.
 *
 * Never while the player is up. A catch-up is network and database work, and
 * nothing may compete with a stream that is filling its buffer; the next
 * resume asks again, and a retry that was owed waits the player out (see
 * armDeferredRetry).
 *
 * `force` is for a fresh link: the account just changed, so the backend's
 * floor must not answer with a report about the old one. A forced call that
 * arrives while a pass is running is held and sent when that pass answers,
 * because the backend would hand it the running pass's report — a pass that
 * started before the link and so never saw the new account.
 */
export function requestCatchUp(options?: { force?: boolean }): void {
  const mediaHub = api()
  if (!mediaHub) return
  if (playerIsUp()) return
  if (running) {
    if (options?.force) forceAfter = true
    return
  }
  // A fresh link gets a run of retries of its own: the asks the last
  // account's failures used up say nothing about the new one.
  if (options?.force) {
    failedPasses = 0
    owedRetryMs = 0
  }
  running = true
  update({ inFlight: true })
  mediaHub.tracking
    .catchUp(options)
    .then((report) => {
      // Inside its two-minute floor, or while something is playing, the
      // backend answers with the last pass's report again, `at` and all. No
      // pass ran, so it is neither another failure nor a recovery: counted,
      // a few quick resumes after one failure would use up the asks and
      // push the first real one out by most of an hour. A retry whose own
      // ask got this answer is still owed, the last one too, and is asked
      // again at the same wait. One still armed is left alone: the answer
      // was a resume's, and re-arming would push that retry further off at
      // every resume (on a phone pointed at a backend that is playing, by a
      // whole wait each time).
      const replay = report.at === 0 || report.at === snapshot.report?.at
      update({ report })
      if (replay) {
        if (owedRetryMs && retryTimer === undefined) armDeferredRetry(owedRetryMs)
        if (report.deferred) armDeferredRetry()
        return
      }
      // A pass ran, so the retry owed has been asked; retryFailedPass owes
      // the next one, if there is one.
      owedRetryMs = 0
      // After a failure, a clean answer is no sign the failure is over, not
      // even one that changed something: inside its backoff the backend
      // does not ask Simkl for what failed and answers that pass clean, and
      // the change can have come from Trakt, the watchlist pull or another
      // kind. So a run of asks that a failure started goes on to its end.
      const stillFailing =
        Boolean(report.error) || (failedPasses > 0 && failedPasses < FAILED_RETRY_LIMIT)
      if (!stillFailing) failedPasses = 0
      // A pass put off is asked again in three minutes whatever happened
      // (below), and that ask serves the failure too. Counted, the asks
      // would go at that pace, inside the backend's backoff, and be used up
      // by the time the deferral ends; so the failure is only noted, as the
      // first ask of its run (the three-minute asks stand in for that one),
      // and the rest of the run goes on from the next wait (six minutes,
      // after a fresh failure) when the deferred asks stop.
      else if (report.deferred) failedPasses = Math.max(failedPasses, 1)
      else retryFailedPass()
      if (report.deferred) armDeferredRetry()
    })
    // A pass that failed outright has nothing to show; the last report stands
    // and it is asked again on the failed-pass timer (see retryFailedPass).
    .catch(() => {
      owedRetryMs = 0
      retryFailedPass()
    })
    .finally(() => {
      running = false
      update({ inFlight: false })
      if (forceAfter) {
        forceAfter = false
        requestCatchUp({ force: true })
      }
    })
}

/** The catch-up's state, for a screen that wants to say it is updating. */
export function useCatchUp(): CatchUpSnapshot {
  return useSyncExternalStore(subscribe, read, read)
}

/**
 * The moments this app asks for a catch-up: when it opens, and whenever it
 * comes back to the front. Mounted once, by App.tsx's Shell.
 *
 * Coming back to the front is two signals because there are two hosts. The
 * Android app dispatches `r3-resume` from its own onResume (MainActivity.kt),
 * since Android promises nothing about the page's visibilitychange when the
 * activity resumes; a plain browser tab has visibilitychange and nothing
 * else. Both may fire for one return, which the backend's floor absorbs.
 */
export function useCatchUpTriggers(): void {
  useEffect(() => {
    requestCatchUp()
    const onResume = () => requestCatchUp()
    const onVisibility = () => {
      if (document.visibilityState === 'visible') requestCatchUp()
    }
    window.addEventListener('r3-resume', onResume)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('r3-resume', onResume)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])
}

/**
 * Calls `onRefresh` when the library this screen shows may have changed
 * somewhere other than here: a catch-up that reports a change, the backend
 * announcing rows it wrote of its own accord (library.onChanged — the
 * watchlist pull, the catch-up's own writes), or the suggestions being
 * rebuilt.
 *
 * Those arrive in bursts — one catch-up can produce its report, a
 * library:changed and a recommendations rebuild within a second or two — so
 * they are collapsed into one trailing call rather than one refetch each.
 *
 * Only a report NEWER than the one already in the store when this screen
 * mounted counts: the screen's own first fetch already reflects that one,
 * and the backend hands the same report back to every call inside its floor.
 */
export function useLibraryRefresh(onRefresh: () => void): void {
  // An Effect Event, so a caller passing a fresh closure every render does
  // not tear down and re-open the subscriptions below each time.
  const fire = useEffectEvent(onRefresh)

  useEffect(() => {
    let timer: number | undefined
    const schedule = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => fire(), REFRESH_DEBOUNCE_MS)
    }

    let lastSeenAt = read().report?.at ?? 0
    const unsubscribeStore = subscribe(() => {
      const report = read().report
      if (!report || report.at <= lastSeenAt) return
      lastSeenAt = report.at
      if (report.changed) schedule()
    })

    const mediaHub = api()
    const unsubscribeLibrary = mediaHub?.library.onChanged((event) => {
      if (
        event.scopes.some((scope) => scope === 'history' || scope === 'planned' || scope === 'all')
      ) {
        schedule()
      }
    })
    const unsubscribeRecommendations = mediaHub?.home.onRecommendationsChanged(() => schedule())

    return () => {
      window.clearTimeout(timer)
      unsubscribeStore()
      unsubscribeLibrary?.()
      unsubscribeRecommendations?.()
    }
  }, [])
}
