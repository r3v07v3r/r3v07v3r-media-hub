// HOW THE PHONE AND TV APP LEARNS WHAT WAS WATCHED ELSEWHERE.
//
// The desktop settles its tracking services in a review panel; this app has
// none, so it asks the backend for a catch-up instead (tracking.catchUp — see
// main/media-hub/simklCatchUp.ts): the watchlist pull, then what Simkl says
// was watched. It asks when the app opens and whenever it comes back to the
// front, and the screens that show the library refetch when a pass reports a
// change.
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

/**
 * Ask the backend to catch up. Safe to call as often as anything likes: the
 * backend answers a call made within a couple of minutes of the last pass, or
 * during one, with that pass's report rather than doing the work again.
 *
 * Never while the player is up. A catch-up is network and database work, and
 * nothing may compete with a stream that is filling its buffer; the next
 * resume or visit to Home asks again.
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
  if (window.location.hash.startsWith('#/player')) return
  if (running) {
    if (options?.force) forceAfter = true
    return
  }
  running = true
  update({ inFlight: true })
  mediaHub.tracking
    .catchUp(options)
    .then((report) => {
      update({ report })
      if (report.deferred) {
        // One timer, replaced rather than stacked, so a run of deferred
        // answers never turns into a run of overlapping retries.
        window.clearTimeout(retryTimer)
        retryTimer = window.setTimeout(() => requestCatchUp(), DEFERRED_RETRY_MS)
      }
    })
    // A pass that failed outright has nothing to show; the last report stands
    // and the next resume asks again.
    .catch(() => {})
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
