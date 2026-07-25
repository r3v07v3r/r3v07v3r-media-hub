'use client'

import { useEffect, useState } from 'react'
import { WeatherSnapshot } from '@renderer/types'

/** Mock weather feed. Structured as an async "load" so swapping in a real
 *  provider (OpenWeather, a device sensor, whatever) is a one-function
 *  change — every consumer only ever sees the WeatherSnapshot shape. */
export function useWeather() {
  const [weather, setWeather] = useState<WeatherSnapshot>({
    tempC: 21,
    condition: 'clear',
    loading: true
  })

  useEffect(() => {
    let cancelled = false
    const t = setTimeout(() => {
      if (cancelled) return
      setWeather({ tempC: 21, condition: 'clear', loading: false })
    }, 700)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [])

  return weather
}
