'use client'

// Bringing the desktop up to date with what was watched elsewhere.
//
// The backend's catch-up (main/media-hub/simklCatchUp.ts) takes in what
// Simkl says was watched — films, series episodes, anime episodes — that
// this library does not have yet, and only ever adds; the Trakt history
// pull rides along with it. The phone and TV app ask for it on open and on
// every resume (app-ui/lib/librarySync.ts). This is the desktop's half:
// once when the window opens, and again when it comes back to the front.
// What the catch-up cannot settle on its own (Simkl saying a film here is
// NOT watched) is still the review panel's, which AppStateContext opens a
// few seconds after launch.
//
// The backend keeps the phone's rules: a call within two minutes of the
// last pass is answered with that pass, and nothing runs while something is
// playing (the player window puts the scheduler under critical pressure).
// On top of that a desktop window gains focus far more often than a phone
// resumes, and every pass that gets through is a Simkl request against the
// 500 a day the phone shares, so focus asks at most every ten minutes. A
// pass that put anime off until the catalog is grouped is asked again in a
// few minutes, as on the phone.

import { useEffect } from 'react'

/** The least time between two catch-ups asked for by the window gaining focus. */
const FOCUS_GAP_MS = 10 * 60 * 1000
/** When a pass that deferred part of its work is asked again. */
const DEFERRED_RETRY_MS = 3 * 60 * 1000

export function useServiceCatchUp(): void {
  useEffect(() => {
    const tracking = window.api?.mediaHub?.tracking
    if (!tracking?.catchUp) return
    let lastAsked = 0
    let running = false
    let retry: number | undefined

    const ask = (): void => {
      if (running) return
      running = true
      lastAsked = Date.now()
      void tracking
        .catchUp()
        .then((report) => {
          window.clearTimeout(retry)
          if (report?.deferred) retry = window.setTimeout(ask, DEFERRED_RETRY_MS)
        })
        // A pass that failed has nothing to show; the next focus asks again.
        .catch(() => {})
        .finally(() => {
          running = false
        })
    }

    const onFocus = (): void => {
      if (Date.now() - lastAsked >= FOCUS_GAP_MS) ask()
    }

    ask()
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.clearTimeout(retry)
    }
  }, [])
}
