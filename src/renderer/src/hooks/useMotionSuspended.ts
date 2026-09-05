'use client'

import { useEffect, useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'

/** True whenever ambient/decorative animation work should stop entirely,
 *  not just slow down, because nothing would actually be on screen to see
 *  it: the window is hidden/minimized (Page Visibility API), or a movie is
 *  playing — PlaybackOverlay is a full-screen opaque surface, but the
 *  routed page and all its chrome (sidebar, background blobs, hero art
 *  drift, ...) stay mounted underneath it (see AppShell.tsx), so their
 *  animations kept
 *  compositing for an audience of nobody. Distinct from useReducedMotion,
 *  which reflects the OS accessibility preference regardless of
 *  visibility — this is purely "is any of this even visible right now." */
export function useMotionSuspended(): boolean {
  const { playbackMedia } = useAppState()
  const [hidden, setHidden] = useState(() => document.hidden)

  useEffect(() => {
    function onChange() {
      setHidden(document.hidden)
    }
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])

  return hidden || Boolean(playbackMedia)
}
