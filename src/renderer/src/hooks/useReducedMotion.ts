'use client'

import { useEffect, useState } from 'react'

/** Respects the OS-level prefers-reduced-motion setting (spec section 15
 *  / 19). Components use this to skip continuous decorative animation
 *  (Ken Burns drift, ambient pulses, flowing outlines) — not to disable
 *  functional transitions like a progress bar filling in. */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    function onChange() {
      setReduced(mq.matches)
    }
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return reduced
}
