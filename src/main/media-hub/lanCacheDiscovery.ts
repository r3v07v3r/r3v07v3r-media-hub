// One-shot mDNS browse for r3-cache daemons — the "Cache server found on
// your network" half of zero-config pairing.
//
// On demand only (the Settings pane's Discover button / pane open), not a
// resident listener: a media app has no business holding port 5353 open
// around the clock, and pairing is a once-per-device event. Best-effort by
// contract — multicast is filtered on some networks, and the manual URL
// field is the first-class alternative, not a fallback of last resort.

import dgram from 'node:dgram'

import {
  MDNS_ADDRESS,
  MDNS_PORT,
  TYPE_A,
  TYPE_PTR,
  TYPE_SRV,
  decodeMessage,
  encodeQuery,
  type DnsRecord
} from '../../shared/lancache/mdnsWire'
import { LANCACHE_SERVICE_TYPE } from '../../shared/lancache/protocol'

export interface DiscoveredLanCache {
  name: string
  host: string
  port: number
  url: string
}

const BROWSE_WINDOW_MS = 2_500

/**
 * Sends one PTR query and collects responses for a short window.
 *
 * Records can arrive split across packets (PTR in one, SRV/A in another),
 * so partial state is accumulated per instance and only entries that end
 * the window with both a port and an address are reported.
 */
export function discoverLanCaches(timeoutMs = BROWSE_WINDOW_MS): Promise<DiscoveredLanCache[]> {
  return new Promise((resolve) => {
    const found = new Map<string, { name: string; port?: number; target?: string }>()
    const addresses = new Map<string, string>()
    let socket: dgram.Socket

    const finish = (): void => {
      try {
        socket.close()
      } catch {
        // Already closed.
      }
      const results: DiscoveredLanCache[] = []
      for (const entry of found.values()) {
        const host = entry.target ? addresses.get(entry.target.toLowerCase()) : undefined
        if (!host || !entry.port) continue
        results.push({
          name: entry.name,
          host,
          port: entry.port,
          url: `http://${host}:${entry.port}`
        })
      }
      resolve(results)
    }

    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    } catch {
      resolve([])
      return
    }
    socket.on('error', finish)
    socket.on('message', (message, rinfo) => {
      const decoded = decodeMessage(message)
      if (!decoded?.isResponse) return
      const records: DnsRecord[] = [...decoded.answers, ...decoded.additionals]
      for (const record of records) {
        if (record.type === TYPE_PTR && record.data.kind === 'ptr') {
          if (record.name.toLowerCase() !== LANCACHE_SERVICE_TYPE) continue
          const instance = record.data.target
          if (!found.has(instance)) {
            found.set(instance, {
              name: instance.replace(`.${LANCACHE_SERVICE_TYPE}`, '')
            })
          }
        }
        if (record.type === TYPE_SRV && record.data.kind === 'srv') {
          const entry = found.get(record.name)
          if (entry) {
            entry.port = record.data.port
            entry.target = record.data.target
          }
        }
        if (record.type === TYPE_A && record.data.kind === 'a') {
          addresses.set(record.name.toLowerCase(), record.data.address)
        }
      }
      // The responder's own source address is the definitive fallback when
      // its A record names a host this network cannot spell.
      for (const entry of found.values()) {
        if (entry.target && !addresses.has(entry.target.toLowerCase())) {
          addresses.set(entry.target.toLowerCase(), rinfo.address)
        }
      }
    })

    socket.bind(0, () => {
      try {
        const query = encodeQuery(LANCACHE_SERVICE_TYPE, TYPE_PTR)
        socket.send(query, MDNS_PORT, MDNS_ADDRESS, () => {})
      } catch {
        finish()
        return
      }
      setTimeout(finish, timeoutMs).unref?.()
    })
  })
}
