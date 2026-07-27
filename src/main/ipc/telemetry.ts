import { ipcMain, WebContents } from 'electron'
import { Worker } from 'worker_threads'
import { join } from 'path'
import { IPC_CHANNELS, SystemSnapshot } from '../../shared/ipc-types'

const EMPTY_SNAPSHOT: SystemSnapshot = {
  cpu: { loadPercent: 0, speedGHz: null, cores: 0, temperatureC: null },
  gpu: null,
  memory: { usedGB: 0, totalGB: 0, usedPercent: 0 },
  network: { downKbps: 0, upKbps: 0, interface: null },
  timestamp: Date.now()
}

let worker: Worker | null = null
let latestSnapshot: SystemSnapshot = EMPTY_SNAPSHOT
const subscribers = new Set<WebContents>()

// See telemetryWorker.ts's own header comment for why this collection runs
// off-thread: the systeminformation calls it makes measured at 700ms-1s+ of
// genuine main-thread blocking each poll on this class of hardware, which
// read as the whole app freezing every ~1.5s.
function ensureWorker(): Worker {
  if (worker) return worker
  worker = new Worker(join(__dirname, 'telemetryWorker.js'))
  worker.on('message', (message: { type: 'snapshot'; snapshot: SystemSnapshot } | { type: 'error'; message: string }) => {
    if (message.type !== 'snapshot') return
    latestSnapshot = message.snapshot
    for (const wc of subscribers) {
      if (!wc.isDestroyed()) wc.send(IPC_CHANNELS.systemSnapshot, message.snapshot)
    }
  })
  // A crashed worker just means telemetry goes stale (latestSnapshot stops
  // updating) rather than taking the app down — the gauges freeze at their
  // last value instead of erroring, matching how a single failed
  // si.currentLoad() etc. call used to be swallowed in the old inline loop.
  worker.on('error', () => {
    worker = null
  })
  worker.postMessage('start')
  return worker
}

export function registerTelemetryIpc(): void {
  ipcMain.handle(IPC_CHANNELS.systemSnapshot, async () => {
    ensureWorker()
    return latestSnapshot
  })

  ipcMain.on('system:subscribe', (event) => {
    subscribers.add(event.sender)
    ensureWorker()
    event.sender.once('destroyed', () => subscribers.delete(event.sender))
  })
  ipcMain.on('system:unsubscribe', (event) => {
    subscribers.delete(event.sender)
  })
}
