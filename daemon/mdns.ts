// The daemon's mDNS announcer — what makes "just run it" true.
//
// Answers queries for _r3cache._tcp.local with PTR/SRV/TXT/A, and sends a
// low-rate unsolicited announcement so an app already listening notices a
// daemon that just started. Best-effort throughout: multicast is blocked
// on some networks, which is exactly why the app also has a manual URL
// field — this module failing entirely must not take the daemon down.

import dgram from 'node:dgram'
import os from 'node:os'

import {
  MDNS_ADDRESS,
  MDNS_PORT,
  TYPE_A,
  TYPE_PTR,
  TYPE_SRV,
  TYPE_TXT,
  decodeMessage,
  encodeResponse,
  type DnsRecord
} from '../src/shared/lancache/mdnsWire'
import { LANCACHE_SERVICE_TYPE } from '../src/shared/lancache/protocol'

const ANNOUNCE_INTERVAL_MS = 60_000
const RECORD_TTL_SECONDS = 120

function localIPv4Addresses(): string[] {
  const addresses: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address)
    }
  }
  return addresses
}

/** DNS labels cannot contain dots; a hostname like "r3-host.lan" would
 *  otherwise split into nested labels and confuse resolvers. */
function safeLabel(name: string): string {
  return name.replace(/[^a-zA-Z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'r3-cache'
}

export interface MdnsAnnouncer {
  start(): void
  stop(): void
}

export function createMdnsAnnouncer(options: {
  serverName: string
  port: number
  version: string
  log: (message: string) => void
}): MdnsAnnouncer {
  const instance = safeLabel(options.serverName)
  const serviceName = `${instance}.${LANCACHE_SERVICE_TYPE}`
  const hostName = `${instance}.local`
  let socket: dgram.Socket | null = null
  let timer: NodeJS.Timeout | null = null

  function records(): { answers: DnsRecord[]; additionals: DnsRecord[] } {
    const addresses = localIPv4Addresses()
    return {
      answers: [
        {
          name: LANCACHE_SERVICE_TYPE,
          type: TYPE_PTR,
          ttl: RECORD_TTL_SECONDS,
          data: { kind: 'ptr', target: serviceName }
        }
      ],
      additionals: [
        {
          name: serviceName,
          type: TYPE_SRV,
          ttl: RECORD_TTL_SECONDS,
          data: { kind: 'srv', priority: 0, weight: 0, port: options.port, target: hostName }
        },
        {
          name: serviceName,
          type: TYPE_TXT,
          ttl: RECORD_TTL_SECONDS,
          data: { kind: 'txt', entries: [`version=${options.version}`, 'product=r3-cache'] }
        },
        ...addresses.map((address): DnsRecord => ({
          name: hostName,
          type: TYPE_A,
          ttl: RECORD_TTL_SECONDS,
          data: { kind: 'a', address }
        }))
      ]
    }
  }

  function announce(target?: { address: string; port: number }): void {
    if (!socket) return
    const { answers, additionals } = records()
    const packet = encodeResponse(answers, additionals)
    if (target) socket.send(packet, target.port, target.address, () => {})
    else socket.send(packet, MDNS_PORT, MDNS_ADDRESS, () => {})
  }

  return {
    start() {
      try {
        socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
        socket.on('error', (error) => {
          options.log(`mdns unavailable (${error.message}) — manual URL entry still works`)
          socket?.close()
          socket = null
        })
        socket.on('message', (message, rinfo) => {
          const decoded = decodeMessage(message)
          if (!decoded || decoded.isResponse) return
          const asked = decoded.questions.some(
            (question) =>
              question.name.toLowerCase() === LANCACHE_SERVICE_TYPE &&
              (question.type === TYPE_PTR || question.type === 255)
          )
          if (!asked) return
          // RFC 6762 §6.7: a query from a port other than 5353 is a
          // one-shot ("legacy") querier that is not listening on the
          // multicast group — it must be answered UNICAST to its source,
          // or it never hears the reply at all. Found live: the app's
          // browser binds an ephemeral port and discovery silently found
          // nothing while multicast-only replies went to a group it had
          // not joined.
          announce(rinfo.port !== MDNS_PORT ? rinfo : undefined)
        })
        socket.bind(MDNS_PORT, () => {
          try {
            socket?.addMembership(MDNS_ADDRESS)
            socket?.setMulticastTTL(255)
          } catch {
            // Interface without multicast — queries may still arrive.
          }
          announce()
        })
        timer = setInterval(announce, ANNOUNCE_INTERVAL_MS)
        timer.unref?.()
      } catch (error) {
        options.log(`mdns unavailable (${(error as Error).message})`)
      }
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
      socket?.close()
      socket = null
    }
  }
}
