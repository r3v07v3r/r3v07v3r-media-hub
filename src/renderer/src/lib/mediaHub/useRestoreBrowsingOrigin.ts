import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useAppState } from '@renderer/context/AppStateContext'
import { restoreBrowsingOrigin } from './browsingContext'

/**
 * Applies a captured BrowsingOrigin's scroll/rail/focus restoration once,
 * when this page's route matches the origin a Back press just stepped out
 * of (see AppStateContext's popBrowsingOrigin/pendingRestore). A no-op if
 * nothing is pending, or if what is pending is for a different route (e.g.
 * the person opened a title from Search, went back, then separately
 * navigated here some other way).
 *
 * Call from any page a detail page can be opened from (category pages,
 * Home, My Stuff). `ready` should reflect whether this page's own content
 * is actually present yet — restoring before that would scroll/focus into
 * an empty page.
 */
export function useRestoreBrowsingOrigin(ready: boolean): void {
  const { pendingRestore, clearPendingRestore } = useAppState()
  const location = useLocation()
  const appliedRef = useRef(false)
  // Snapshotted once, at this component instance's first render — NOT a
  // live subscription. Kept from when this read the trail directly, where
  // it was load-bearing: the page a title gets opened FROM is, by
  // construction, the same route openDetail just captured an origin FOR
  // (that's the whole point — you capture where you currently are), so a
  // live dependency meant that the instant openDetail set it, THIS SAME
  // still-mounted page's route trivially matched its own freshly-captured
  // origin.route and it self-consumed via the rAFs below before ever
  // navigating back to it — confirmed live via a debug trace (the value
  // went null -> {captured origin} -> null, all before the detail page
  // ever read it).
  //
  // `pendingRestore` is written only by an actual Back press, never by
  // openDetail, so that particular race is gone at the source. The
  // snapshot stays anyway: a fresh mount is exactly the moment a restore
  // is wanted, and freezing the value keeps this a genuinely one-shot
  // effect rather than one that re-arms on unrelated state changes.
  const originAtMountRef = useRef(pendingRestore)

  useEffect(() => {
    const origin = originAtMountRef.current
    if (!ready || !origin || appliedRef.current) return
    const current = `${location.pathname}${location.search}`
    if (current !== origin.route) return
    // appliedRef is only set INSIDE the rAF callback that actually runs
    // the restore, not preemptively here — verified live that dev-mode
    // StrictMode's effect -> cleanup -> effect double-invoke otherwise
    // breaks this: setting it early let the first (cancelled) invocation
    // claim the one-shot guard before its own rAFs ever fired, so the
    // second invocation's guard check saw it already "applied" and
    // skipped scheduling new ones — net result, the cancelled rAFs were
    // the only ones ever scheduled, and the restore silently never ran.
    let raf2 = -1
    const raf1 = requestAnimationFrame(() => {
      // Two rAFs, not one: the first lets this render's DOM actually
      // commit, the second waits for the layout that commit produced to
      // settle — scrollIntoView landing correctly on a freshly-mounted
      // grid needs both, one frame was occasionally still too early.
      raf2 = requestAnimationFrame(() => {
        if (appliedRef.current) return
        appliedRef.current = true
        restoreBrowsingOrigin(origin)
        clearPendingRestore()
      })
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [ready, location.pathname, location.search, clearPendingRestore])
}
