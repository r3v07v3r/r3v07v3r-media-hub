// Local-network info for the Settings page's Network card — extracted out
// of watchParty.ts (which already needed the same LAN IP for direct-mode
// hosting) rather than duplicated, since both call sites want the same
// "first non-internal IPv4 interface" answer.

import os from 'node:os'
import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import type { NetworkInfoResult } from '../../shared/media-hub/types'
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
}
