import { useEffect, useRef, useState } from 'react'
import { PerformanceSnapshot } from '@renderer/types'
import { useReducedMotion } from './useReducedMotion'

function smoothStep(current: number, target: number, amount = 0.35) {
  return current + (target - current) * amount
}

/** Real system telemetry via the main-process IPC bridge (systeminformation
 *  — see src/main/ipc/telemetry.ts), smoothed on a fast local tick so the
 *  gauges don't visibly jump every time a new ~1.5s snapshot arrives. Falls
 *  back to a static idle-looking snapshot if window.api isn't present
 *  (e.g. this component rendered outside Electron, such as a plain browser
 *  tab during Playwright/dev-server visual verification) rather than
 *  crashing or silently pretending to have live data. */
export function usePerformanceMetrics() {
  const reducedMotion = useReducedMotion()
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
    if (!window.api?.system) return
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
  }, [])

  useEffect(() => {
    if (reducedMotion) {
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
      setSnapshot((prev) => ({
        cpu: smoothStep(prev.cpu, targets.current.cpu),
        gpu: smoothStep(prev.gpu, targets.current.gpu),
        ram: smoothStep(prev.ram, targets.current.ram),
        netDownMbps: smoothStep(prev.netDownMbps, targets.current.netDown),
        netUpMbps: smoothStep(prev.netUpMbps, targets.current.netUp)
      }))
    }, 220)
    return () => clearInterval(id)
  }, [reducedMotion])

  return { ...snapshot, live }
}
