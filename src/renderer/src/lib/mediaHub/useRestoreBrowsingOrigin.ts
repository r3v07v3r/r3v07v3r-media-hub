import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useAppState } from '@renderer/context/AppStateContext'
import { restoreBrowsingOrigin, type BrowsingOrigin } from './browsingContext'

/**
 * Applies a captured BrowsingOrigin's scroll/rail/focus restoration once,
 * when this page's route matches the origin a Back press just stepped out
 * of (see AppStateContext's popBrowsingOrigin/pendingRestore). A no-op if
 * nothing is pending, or if what is pending is for a different route (e.g.
 * the person opened a title from Search, went back, then separately
 * navigated here some other way).
 *
 * Call from any page a detail page can be opened from (category pages,
 * Home, My Stuff) and from the detail page itself, which is a place a
 * title can be opened from too. `ready` should reflect whether this page's
 * own content is actually present yet — restoring before that would
 * scroll/focus into an empty page.
 */
export function useRestoreBrowsingOrigin(ready: boolean): void {
  const { pendingRestore, clearPendingRestore } = useAppState()
  const location = useLocation()
  // WHICH origin this instance has already applied, by object identity —
  // not a boolean, and not a value frozen at mount.
  //
  // Both of those were wrong for the case that matters most on a detail
  // page. React Router reuses the SAME MediaDetailPage instance when only
  // the :id changes, so title A -> title B -> Back is one continuous
  // instance: a value snapshotted at first mount predates the Back press
  // that wrote A into pendingRestore, so the restore for A never ran and
  // the entry was never cleared — it sat there until some later openDetail
  // happened to clear it. A plain boolean has the same shape of problem
  // from the other end: once an instance has restored once, it would
  // refuse to restore the next distinct origin that arrives for it.
  //
  // Keying the guard on the origin object itself makes this "apply each
  // pending origin exactly once, whenever it shows up", which is what was
  // meant all along and works whether the page is freshly mounted or
  // reused.
  //
  // Reading pendingRestore live is safe in a way that reading the trail
  // live was not. That earlier shape self-consumed: openDetail wrote an
  // origin captured FOR the page still on screen, so that page trivially
  // matched its own freshly-captured route and cleared it via the rAFs
  // below before the detail page ever read it (confirmed at the time via a
  // debug trace — the value went null -> {captured origin} -> null without
  // ever being used). pendingRestore cannot do that: openDetail only ever
  // sets it to null, and popBrowsingOrigin sets it to an entry whose route
  // is where we are navigating TO, never where we already are.
  const appliedRef = useRef<BrowsingOrigin | null>(null)

  useEffect(() => {
    if (!ready || !pendingRestore || appliedRef.current === pendingRestore) return
    const current = `${location.pathname}${location.search}`
    if (current !== pendingRestore.route) return
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
        if (appliedRef.current === pendingRestore) return
        appliedRef.current = pendingRestore
        restoreBrowsingOrigin(pendingRestore)
        clearPendingRestore()
      })
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
    // pendingRestore is a dependency now: an entry that arrives AFTER this
    // instance mounted (the reused-detail-page case above) has to re-arm
    // this effect, not be missed by it. A back-to-back Back press replaces
    // it mid-flight, and the cleanup cancels the superseded frames.
  }, [ready, pendingRestore, location.pathname, location.search, clearPendingRestore])
}
