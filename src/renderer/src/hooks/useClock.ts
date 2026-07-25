'use client'

import { useEffect, useState } from 'react'

/** Live clock, updated once a minute (seconds aren't shown, so there's no
 *  reason to re-render every second). Starts null so the server-rendered
 *  markup and the first client render match (avoids hydration mismatch)
 *  — the real time appears on mount. */
export function useClock() {
  const [now, setNow] = useState<Date | null>(null)

  useEffect(() => {
    function tick() {
      setNow(new Date())
    }
    tick()
    const id = setInterval(tick, 30_000)
    return () => clearInterval(id)
  }, [])

  const time = now
    ? now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : '--:--'
  const date = now
    ? now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    : ''

  return { time, date }
}
