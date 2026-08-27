import { useEffect, useRef, useState } from 'react'
import { PerformanceSnapshot } from '@renderer/types'
import { useReducedMotion } from './useReducedMotion'
import { useMotionSuspended } from './useMotionSuspended'

function smoothStep(current: number, target: number, amount = 0.35) {
  return current + (target - current) * amount
}

/** Real system telemetry via the main-process IPC bridge (systeminformation
 *  — see src/main/ipc/telemetry.ts), smoothed on a fast local tick so the
 *  gauges don't visibly jump every time a new snapshot arrives. Falls
 *  back to a static idle-looking snapshot if window.api isn't present
 *  (e.g. this component rendered outside Electron, such as a plain browser
 *  tab during Playwright/dev-server visual verification) rather than
 *  crashing or silently pretending to have live data. */
export function usePerformanceMetrics(enabled = true) {
  const reducedMotion = useReducedMotion()
  // The widget this feeds can be mounted but invisible (Home underneath a
  // full-screen movie, or the window minimized) — no reason to keep
  // re-rendering a smoothing tween nobody can see every 220ms.
  const motionSuspended = useMotionSuspended()
  // `enabled: false` is the caller saying the gauges aren't on screen at
  // all (PerformanceWidget on a short window, or with the panel switched
  // off in Settings) — same treatment as motionSuspended below, which is
  // the same statement made about a hidden window rather than a hidden
  // panel: don't subscribe, so main can terminate the telemetry worker,
  // and don't run the smoothing tween either.
  const skipSmoothing = reducedMotion || motionSuspended || !enabled
  const [snapshot, setSnapshot] = useState<PerformanceSnapshot>({
    cpu: 0,
    gpu: 0,
    ram: 0,
    netDownMbps: 0,
    netUpMbps: 0
  })
  const targets = useRef({ cpu: 0, gpu: 0, ram: 0, netDown: 0, netUp: 0 })
  const [live, setLive] = useState(false)

  useEffect(() => {
    // Home stays mounted beneath the opaque player overlay. Stop the
    // subscription as well as the visual tween while it is hidden/minimized
    // so the WMI-backed worker can be terminated instead of continuing to
    // compete with the renderer for CPU nobody can see being spent.
    if (!window.api?.system || motionSuspended || !enabled) return
    const unsubscribe = window.api.system.subscribe((s) => {
      setLive(true)
      targets.current = {
        cpu: s.cpu.loadPercent,
        gpu: s.gpu?.loadPercent ?? 0,
        ram: s.memory.usedPercent,
        netDown: s.network.downKbps / 1024,
        netUp: s.network.upKbps / 1024
      }
    })
    return unsubscribe
  }, [motionSuspended, enabled])

  useEffect(() => {
    if (skipSmoothing) {
      setSnapshot({
        cpu: targets.current.cpu,
        gpu: targets.current.gpu,
        ram: targets.current.ram,
        netDownMbps: targets.current.netDown,
        netUpMbps: targets.current.netUp
      })
      return
    }
    const id = setInterval(() => {
      setSnapshot((prev) => {
        const next = {
          cpu: smoothStep(prev.cpu, targets.current.cpu),
          gpu: smoothStep(prev.gpu, targets.current.gpu),
          ram: smoothStep(prev.ram, targets.current.ram),
          netDownMbps: smoothStep(prev.netDownMbps, targets.current.netDown),
          netUpMbps: smoothStep(prev.netUpMbps, targets.current.netUp)
        }
        // Once all gauges have reached their targets, return the existing
        // object so React skips a needless Home/PerformanceWidget render
        // every 220ms until the next telemetry update arrives.
        return Object.entries(next).every(
          ([key, value]) => Math.abs(value - prev[key as keyof PerformanceSnapshot]) < 0.05
        )
          ? prev
          : next
      })
    }, 220)
    return () => clearInterval(id)
  }, [skipSmoothing])

  return { ...snapshot, live }
}
