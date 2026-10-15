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
// 500 a day the phone shares, so focus asks at most every ten minutes, and
// the Trakt and MyAnimeList watchlists, which have no gate to ask first,
// are left to the half-hourly job unless Simkl's moved. A pass that put
// anime off until the catalog is grouped is asked again in a few minutes,
// as on the phone.
//
// A profile switch asks again: the backend keeps catch-up state per profile,
// so the pass the last profile had says nothing about the new one's library.
// The ten minutes are counted per profile, so switching back and forth does
// not ask Simkl each time.

import { useEffect, useRef } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'

/** The least time between two catch-ups asked for by the window gaining focus. */
const FOCUS_GAP_MS = 10 * 60 * 1000
/** When a pass that deferred part of its work is asked again. */
const DEFERRED_RETRY_MS = 3 * 60 * 1000

export function useServiceCatchUp(): void {
  const { activeProfileId } = useAppState()
  const profileRef = useRef(activeProfileId)
  const askIfDueRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const tracking = window.api?.mediaHub?.tracking
    if (!tracking?.catchUp) return
    /** When each profile last asked. */
    const lastAsked = new Map<string, number>()
    let running = false
    /** A switch arrived while a pass ran: ask for the new profile after it. */
    let askAfter = false
    let retry: number | undefined

    const askIfDue = (): void => {
      if (Date.now() - (lastAsked.get(profileRef.current) ?? 0) >= FOCUS_GAP_MS) ask()
    }

    const ask = (): void => {
      if (running) {
        askAfter = true
        return
      }
      running = true
      lastAsked.set(profileRef.current, Date.now())
      void tracking
        .catchUp({ leaveListsToJob: true })
        .then((report) => {
          window.clearTimeout(retry)
          if (report?.deferred) retry = window.setTimeout(ask, DEFERRED_RETRY_MS)
        })
        // A pass that failed has nothing to show; the next focus asks again.
        .catch(() => {})
        .finally(() => {
          running = false
          if (askAfter) {
            askAfter = false
            askIfDue()
          }
        })
    }

    askIfDueRef.current = askIfDue
    ask()
    window.addEventListener('focus', askIfDue)
    return () => {
      askIfDueRef.current = null
      window.removeEventListener('focus', askIfDue)
      window.clearTimeout(retry)
    }
  }, [])

  // switchProfile sets the id once main has switched, so the pass asked
  // here is the new profile's. The first change at launch (the stand-in
  // profile to the real one) asks too, once the pass the mount started has
  // ended; main answers that from the pass it just ran (its two-minute
  // floor), so it costs no Simkl request.
  useEffect(() => {
    if (profileRef.current === activeProfileId) return
    profileRef.current = activeProfileId
    askIfDueRef.current?.()
  }, [activeProfileId])
}
