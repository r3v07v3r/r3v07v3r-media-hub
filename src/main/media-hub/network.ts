// Local-network info for the Settings page's Network card — extracted out
// of watchParty.ts (which already needed the same LAN IP for direct-mode
// hosting) rather than duplicated, since both call sites want the same
// "first non-internal IPv4 interface" answer.

import os from 'node:os'
import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import type { ConnectionTestResult, NetworkInfoResult } from '../../shared/media-hub/types'
import { handle } from './ipcGuard'

export function getLocalLanIp(): string {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address
    }
  }
  return '127.0.0.1'
}

export function registerNetworkIpc(): void {
  handle<undefined, NetworkInfoResult>(MEDIA_HUB_CHANNELS.networkInfo, () => ({
    lanIp: getLocalLanIp(),
    hostname: os.hostname()
  }))
  handle<{ screenHeight: number }, ConnectionTestResult>(
    MEDIA_HUB_CHANNELS.networkSpeedTest,
    async (_event, value) => {
      // One MiB is enough for a useful estimate without punishing metered connections.
      const testedBytes = 1024 * 1024
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 12000)
      const started = performance.now()
      try {
        const response = await fetch(`https://speed.cloudflare.com/__down?bytes=${testedBytes}`, {
          cache: 'no-store',
          signal: controller.signal
        })
        if (!response.ok) throw new Error(`Speed test failed (${response.status}).`)
        const bytes = (await response.arrayBuffer()).byteLength
        const seconds = Math.max((performance.now() - started) / 1000, 0.001)
        const speedMbps = Math.round(((bytes * 8) / seconds / 1_000_000) * 10) / 10
        const screen = Math.max(480, Number(value?.screenHeight) || 1080)
        const speedLimit = speedMbps < 4 ? 480 : speedMbps < 8 ? 720 : speedMbps < 20 ? 1080 : 2160
        const screenLimit = screen < 600 ? 480 : screen < 900 ? 720 : screen < 1300 ? 1080 : screen < 1800 ? 1440 : 2160
        const recommendedResolution = Math.min(speedLimit, screenLimit)
        const recommendedSizeGb = speedMbps < 4 ? 1 : speedMbps < 8 ? 2 : speedMbps < 20 ? 5 : speedMbps < 40 ? 10 : 20
        return { speedMbps, testedBytes: bytes, recommendedResolution, recommendedSizeGb }
      } finally {
        clearTimeout(timeout)
      }
    }
  )
}
