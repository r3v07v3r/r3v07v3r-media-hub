import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useAppState } from '@renderer/context/AppStateContext'
import { restoreBrowsingOrigin } from './browsingContext'

/**
 * Applies a captured BrowsingOrigin's scroll/rail/focus restoration once,
 * when this page's route matches the origin the person came FROM before
 * opening a detail page (see AppStateContext's openDetail/browsingOrigin).
 * A no-op if there's no pending origin, or if one exists but is for a
 * different route (e.g. the person opened a title from Search, went back,
 * then separately navigated here some other way).
 *
 * Call from any page a detail page can be opened from (category pages,
 * Home, My Stuff). `ready` should reflect whether this page's own content
 * is actually present yet — restoring before that would scroll/focus into
 * an empty page.
 */
export function useRestoreBrowsingOrigin(ready: boolean): void {
  const { browsingOrigin, clearBrowsingOrigin } = useAppState()
  const location = useLocation()
  const appliedRef = useRef(false)
  // Snapshotted once, at this component instance's first render — NOT a
  // live subscription to browsingOrigin. The page a title gets opened
  // FROM is, by construction, the same route openDetail just captured an
  // origin FOR (that's the whole point — you capture where you currently
  // are). A live dependency on browsingOrigin meant that the instant
  // openDetail set it, THIS SAME still-mounted page's route trivially
  // matched its own freshly-captured origin.route, so it self-consumed
  // and cleared the origin via the rAFs below before ever navigating back
  // to it — confirmed live via a debug trace (browsingOrigin went
  // null -> {captured origin} -> null, all before the detail page ever
  // read it). Freezing the value at mount sidesteps this: a fresh mount
  // only happens when this route is actually navigated TO (initial visit,
  // or the contextual back button's navigate(origin.route)), never while
  // continuing to sit on the page that just captured it.
  const originAtMountRef = useRef(browsingOrigin)

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
        clearBrowsingOrigin()
      })
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [ready, location.pathname, location.search, clearBrowsingOrigin])
}
