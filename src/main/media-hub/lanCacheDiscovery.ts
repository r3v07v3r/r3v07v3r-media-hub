// Finding r3-cache daemons on this network: the "Cache server found on
// your network" half of zero-config pairing.
//
// Two ways, in order. mDNS first: the daemon already announces
// _r3cache._tcp.local, the answer carries the real port, and it costs one
// packet. Multicast is filtered on some networks (guest Wi-Fi, some mesh
// systems, Docker bridges), so when mDNS finds nothing the app asks every
// address on its own subnet for /api/ping on the default port, the same
// unauthenticated identity check pairing already starts with. A UDP
// broadcast probe was the other candidate and was not taken: it would need a
// second listener in the daemon for what mDNS already answers, and networks
// that drop multicast tend to drop broadcast with it, while plain unicast
// HTTP gets through both.
//
// Nothing here knows an address. The subnet comes from this machine's own
// interfaces, so a household on 10.0.0.0/24 is searched exactly as one on
// 192.168.88.0/24 is.
//
// Never a resident listener: a media app has no business holding port 5353
// open around the clock. Each search is a short window, run at launch, when
// the stored address stops answering, and from the Caching section.

import dgram from 'node:dgram'
import http from 'node:http'
import os from 'node:os'

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
import {
  LANCACHE_DEFAULT_PORT,
  LANCACHE_SERVICE_TYPE,
  type LanCachePingResponse
} from '../../shared/lancache/protocol'

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

// ---------------------------------------------------------------------------
// The fallback: ask the subnet.

/** How long one address may take to answer. A daemon on the same LAN
 *  answers in a few milliseconds; an empty address either refuses at once
 *  or, behind a firewall that drops, never answers at all, and it is the
 *  second kind this bounds. */
const PROBE_TIMEOUT_MS = 800
/** Requests in flight at once. 254 addresses at 64 a time and 800 ms each
 *  is about three seconds for the worst case of a subnet that drops
 *  everything, the same order as the mDNS window. */
const PROBE_CONCURRENCY = 64
/** The most addresses one interface may contribute. A /24 is 254; anything
 *  wider (a /16 on an office LAN, a VPN's /8) is narrowed to the /24 this
 *  machine sits in rather than probed whole — 65,000 requests is a scan,
 *  not a search, and the cache server is almost always a neighbour. */
const MAX_HOSTS_PER_INTERFACE = 254

interface InterfaceAddress {
  address: string
  netmask: string
  family: string | number
  internal: boolean
}

function toInt(address: string): number | null {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return null
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

function toAddress(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.')
}

/**
 * Private-use and link-local ranges (RFC 1918, RFC 3927), the only kinds of
 * network this probes. These are address CLASSES, not a guess at anyone's
 * numbering: a household LAN is always on one of them, and an interface that
 * is not (a public address on a server, a carrier's range) is a network where
 * asking 254 strangers for /api/ping would be rude at best.
 */
function isPrivate(value: number): boolean {
  const a = value >>> 24
  const b = (value >>> 16) & 255
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  )
}

/**
 * Every address worth asking, from this machine's own interfaces: the hosts
 * of each private IPv4 subnet it is on, at most MAX_HOSTS_PER_INTERFACE per
 * interface. This machine's own address is included: the daemon may well
 * run on the same PC as the app. Pure, so the arithmetic is tested without a
 * network.
 */
export function subnetProbeHosts(
  interfaces: Record<string, InterfaceAddress[] | undefined>
): string[] {
  const hosts = new Set<string>()
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) {
      // Node reported the family as a number (4) for a few releases.
      const family = entry.family === 4 ? 'IPv4' : entry.family
      if (family !== 'IPv4' || entry.internal) continue
      const address = toInt(entry.address)
      const mask = toInt(entry.netmask)
      if (address === null || mask === null || !isPrivate(address)) continue
      // Anything wider than a /24 is narrowed to the /24 around this machine.
      const effectiveMask = (mask | 0xffffff00) >>> 0
      const network = (address & effectiveMask) >>> 0
      const broadcast = (network | (~effectiveMask >>> 0)) >>> 0
      let added = 0
      for (let host = network + 1; host < broadcast && added < MAX_HOSTS_PER_INTERFACE; host++) {
        hosts.add(toAddress(host))
        added++
      }
    }
  }
  return [...hosts]
}

/** One /api/ping. Plain node:http rather than httpClient on purpose: a probe
 *  of 254 addresses is not API traffic, and routing it through the
 *  scheduler's 'lancache' lane would queue the play-time lookup behind it. */
function ping(host: string, port: number): Promise<LanCachePingResponse | null> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/api/ping', timeout: PROBE_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        resolve(null)
        return
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body += chunk
        // A ping is a few dozen bytes; anything long is not one.
        if (body.length > 4096) req.destroy()
      })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body) as LanCachePingResponse
          resolve(parsed?.product === 'r3-cache' ? parsed : null)
        } catch {
          resolve(null)
        }
      })
      res.on('error', () => resolve(null))
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
  })
}

/** Asks every subnet address for /api/ping on the default port. */
export async function probeSubnetForLanCaches(
  hosts: string[] = subnetProbeHosts(os.networkInterfaces()),
  port = LANCACHE_DEFAULT_PORT
): Promise<DiscoveredLanCache[]> {
  const found: DiscoveredLanCache[] = []
  let next = 0
  async function worker(): Promise<void> {
    while (next < hosts.length) {
      const host = hosts[next++]
      const answer = await ping(host, port)
      if (answer) {
        found.push({ name: answer.serverName || host, host, port, url: `http://${host}:${port}` })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, hosts.length) }, worker))
  return found
}

/**
 * Every cache server this device can find: mDNS, then the subnet probe.
 *
 * 'if-empty' (the default) probes only when mDNS found nothing, which is the
 * case the probe exists for. 'never' is the cheap periodic search.
 */
export async function findLanCaches(
  options: { probe?: 'if-empty' | 'never' } = {}
): Promise<DiscoveredLanCache[]> {
  const announced = await discoverLanCaches()
  if (announced.length || options.probe === 'never') return announced
  return probeSubnetForLanCaches()
}
