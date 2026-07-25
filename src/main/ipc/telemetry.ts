import { ipcMain, WebContents } from 'electron'
import si from 'systeminformation'
import { IPC_CHANNELS, SystemSnapshot } from '../../shared/ipc-types'

const POLL_INTERVAL_MS = 1500

let lastNetStats: si.Systeminformation.NetworkStatsData | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
const subscribers = new Set<WebContents>()

async function readSnapshot(): Promise<SystemSnapshot> {
  const [load, cpuTemp, mem, graphics, netStats] = await Promise.all([
    si.currentLoad(),
    si.cpuTemperature().catch(() => null as si.Systeminformation.CpuTemperatureData | null),
    si.mem(),
    si.graphics().catch(() => null as si.Systeminformation.GraphicsData | null),
    si.networkStats().catch(() => [] as si.Systeminformation.NetworkStatsData[])
  ])

  const primaryGpu =
    graphics?.controllers?.find((c) => (c.vram ?? 0) > 0) ?? graphics?.controllers?.[0]
  const net = netStats[0] ?? lastNetStats
  lastNetStats = netStats[0] ?? lastNetStats

  return {
    cpu: {
      loadPercent: Math.round(load.currentLoad),
      speedGHz: load.avgLoad ? null : null,
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

function startPolling(): void {
  if (pollTimer) return
  pollTimer = setInterval(async () => {
    if (subscribers.size === 0) return
    try {
      const snapshot = await readSnapshot()
      for (const wc of subscribers) {
        if (!wc.isDestroyed()) wc.send(IPC_CHANNELS.systemSnapshot, snapshot)
      }
    } catch {
      // A single failed poll shouldn't kill the interval — systeminformation
      // can throw transiently on some platforms/sandboxes (missing sensors,
      // permission-gated /sys reads, etc).
    }
  }, POLL_INTERVAL_MS)
}

export function registerTelemetryIpc(): void {
  ipcMain.handle(IPC_CHANNELS.systemSnapshot, async () => readSnapshot())

  ipcMain.on('system:subscribe', (event) => {
    subscribers.add(event.sender)
    startPolling()
    event.sender.once('destroyed', () => subscribers.delete(event.sender))
  })
  ipcMain.on('system:unsubscribe', (event) => {
    subscribers.delete(event.sender)
  })
}
