// Runs system telemetry collection on a worker thread instead of Electron's
// main thread. Measured on this class of hardware: si.currentLoad()/
// si.mem()/si.networkStats() together block the Node event loop for
// 700ms-1s+ per call (WMI-backed queries on Windows), and si.graphics()
// adds another ~200-900ms. telemetry.ts polls this on a fixed interval, so
// running it on the main thread stalled window responsiveness and any
// pending IPC roughly every poll cycle — the "interface freezes every few
// seconds" symptom. A worker thread has its own V8 isolate/event loop, so
// however long systeminformation takes here never blocks the main thread;
// only the postMessage() handoff of the finished snapshot does, which is
// cheap.
//
// Self-rescheduling via setTimeout *after* each poll finishes (not
// setInterval) also fixes a second, compounding bug in the original code:
// setInterval doesn't wait for an async callback to resolve, so once a
// single poll started taking longer than POLL_INTERVAL_MS, subsequent
// polls piled up and ran concurrently instead of one at a time.

import { parentPort } from 'worker_threads'
import si from 'systeminformation'
import type { SystemSnapshot } from '../../shared/ipc-types'

// These WMI-backed calls are expensive even off the Electron main thread:
// they still compete with Chromium for CPU time on lower-powered machines.
// Five seconds keeps the dashboard useful as a status panel without turning
// it into a permanent system probe that can make the UI feel unresponsive.
const POLL_INTERVAL_MS = 5000
// si.graphics() alone runs ~200-900ms on this class of hardware (see the
// file-header comment) — by far the most expensive of these calls, for a
// gauge that only needs to look "live," not genuinely real-time. Querying
// it on every 1.5s cycle was paying that full cost 3x as often as the GPU
// number actually needed to move; every 3rd cycle (~15s) keeps the gauge
// visibly live while cutting that specific cost by two-thirds.
const GRAPHICS_POLL_EVERY = 3

let lastNetStats: si.Systeminformation.NetworkStatsData | null = null
let lastGraphics: si.Systeminformation.GraphicsData | null = null
let cycle = 0

async function readSnapshot(): Promise<SystemSnapshot> {
  const shouldPollGraphics = cycle % GRAPHICS_POLL_EVERY === 0
  cycle += 1
  const [load, cpuTemp, mem, graphics, netStats] = await Promise.all([
    si.currentLoad(),
    si.cpuTemperature().catch(() => null as si.Systeminformation.CpuTemperatureData | null),
    si.mem(),
    shouldPollGraphics
      ? si.graphics().catch(() => null as si.Systeminformation.GraphicsData | null)
      : Promise.resolve(lastGraphics),
    si.networkStats().catch(() => [] as si.Systeminformation.NetworkStatsData[])
  ])
  lastGraphics = graphics

  const primaryGpu =
    graphics?.controllers?.find((c) => (c.vram ?? 0) > 0) ?? graphics?.controllers?.[0]
  const net = netStats[0] ?? lastNetStats
  lastNetStats = netStats[0] ?? lastNetStats

  return {
    cpu: {
      loadPercent: Math.round(load.currentLoad),
      speedGHz: null,
      cores: load.cpus?.length ?? 0,
      temperatureC:
        cpuTemp && typeof cpuTemp.main === 'number' && !Number.isNaN(cpuTemp.main)
          ? Math.round(cpuTemp.main)
          : null
    },
    gpu: primaryGpu
      ? {
          loadPercent:
            typeof primaryGpu.utilizationGpu === 'number' ? primaryGpu.utilizationGpu : null,
          vramUsedMB: typeof primaryGpu.memoryUsed === 'number' ? primaryGpu.memoryUsed : null,
          vramTotalMB: typeof primaryGpu.vram === 'number' ? primaryGpu.vram : null,
          model: primaryGpu.model ?? null,
          temperatureC:
            typeof primaryGpu.temperatureGpu === 'number' ? primaryGpu.temperatureGpu : null
        }
      : null,
    memory: {
      usedGB: Math.round((mem.active / 1024 ** 3) * 10) / 10,
      totalGB: Math.round((mem.total / 1024 ** 3) * 10) / 10,
      usedPercent: Math.round((mem.active / mem.total) * 100)
    },
    network: {
      downKbps: net ? Math.round((net.rx_sec ?? 0) / 128) : 0,
      upKbps: net ? Math.round((net.tx_sec ?? 0) / 128) : 0,
      interface: net?.iface ?? null
    },
    timestamp: Date.now()
  }
}

let polling = false

async function pollLoop(): Promise<void> {
  if (polling) return
  polling = true
  while (polling) {
    try {
      const snapshot = await readSnapshot()
      parentPort?.postMessage({ type: 'snapshot', snapshot })
    } catch (error) {
      parentPort?.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
    }
    if (!polling) break
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

parentPort?.on('message', (message: string) => {
  if (message === 'start') void pollLoop()
  else if (message === 'stop') polling = false
})
