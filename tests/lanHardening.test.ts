// LAN hardening that does not need a running daemon:
//   - the mDNS name decoder's work bounds (F12): backward-only compression
//     pointers, name and label length limits, packet and section caps;
//   - discovery's responder binding: an instance is bound to the address
//     that first announced it, and its port/address are never overwritten;
//   - the daemon's join-request limits, per source and overall.

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  createPairing,
  MAX_PENDING_PER_SOURCE,
  MAX_REQUESTS_PER_SOURCE_PER_MINUTE
} from '../daemon/pairing'
import {
  accumulateDiscovery,
  discoveryResults,
  type DiscoveryState
} from '../src/main/media-hub/lanCacheDiscovery'
import { LANCACHE_SERVICE_TYPE } from '../src/shared/lancache/protocol'
import {
  decodeMessage,
  type DnsRecord,
  encodeQuery,
  MAX_MDNS_PACKET_BYTES,
  readName,
  TYPE_A,
  TYPE_PTR,
  TYPE_SRV
} from '../src/shared/lancache/mdnsWire'

// --- mDNS name decoder (F12) -----------------------------------------------
{
  // Our own query still decodes.
  const query = decodeMessage(encodeQuery('_r3-cache._tcp.local', 12))
  assert.equal(query?.questions[0]?.name, '_r3-cache._tcp.local')

  // A pointer to itself is refused rather than followed.
  assert.throws(() => readName(Buffer.from([0xc0, 0x00]), 0), /backwards/)

  // A forward pointer is refused too.
  assert.throws(() => readName(Buffer.from([0xc0, 0x02, 0x01, 0x61, 0x00]), 0), /backwards/)

  // A label run that points back into itself (the amplification shape).
  const run = Buffer.concat([
    Buffer.from([0x3f]),
    Buffer.alloc(63, 0x61),
    Buffer.from([0xc0, 0x00])
  ])
  assert.throws(() => readName(run, 0), /backwards/)

  // Over-long names and illegal label lengths.
  const long = Buffer.concat([
    ...Array.from({ length: 5 }, () =>
      Buffer.concat([Buffer.from([0x3f]), Buffer.alloc(63, 0x62)])
    ),
    Buffer.from([0x00])
  ])
  assert.throws(() => readName(long, 0), /too long/)
  assert.throws(() => readName(Buffer.from([0x40, 0x61, 0x00]), 0), /label length/)

  // Header-level caps: oversized datagrams and absurd section counts.
  assert.equal(decodeMessage(Buffer.alloc(MAX_MDNS_PACKET_BYTES + 1)), null)
  const manyQuestions = Buffer.alloc(12)
  manyQuestions.writeUInt16BE(65535, 4)
  assert.equal(decodeMessage(manyQuestions), null)
  console.log('ok  mDNS decoder bounds')
}

// --- discovery binds an instance to its responder -----------------------------
{
  const instance = `living-room.${LANCACHE_SERVICE_TYPE}`
  const ptr: DnsRecord = {
    name: LANCACHE_SERVICE_TYPE,
    type: TYPE_PTR,
    ttl: 120,
    data: { kind: 'ptr', target: instance }
  }
  const srv = (port: number, target = 'box.local'): DnsRecord => ({
    name: instance,
    type: TYPE_SRV,
    ttl: 120,
    data: { kind: 'srv', priority: 0, weight: 0, port, target }
  })
  function aRecord(address: string, host = 'box.local'): DnsRecord {
    return { name: host, type: TYPE_A, ttl: 120, data: { kind: 'a', address } }
  }

  // Split across packets from the same responder: resolved, as https.
  {
    const state: DiscoveryState = new Map()
    accumulateDiscovery(state, [ptr], '192.168.1.20')
    accumulateDiscovery(state, [srv(8945), aRecord('192.168.1.20')], '192.168.1.20')
    assert.deepEqual(discoveryResults(state), [
      { name: 'living-room', host: '192.168.1.20', port: 8945, url: 'https://192.168.1.20:8945' }
    ])
  }

  // Another host cannot fill in, or redirect, somebody else's instance.
  {
    const state: DiscoveryState = new Map()
    accumulateDiscovery(state, [ptr], '192.168.1.20')
    accumulateDiscovery(state, [srv(9999), aRecord('192.168.1.66')], '192.168.1.66')
    assert.deepEqual(discoveryResults(state), [], 'records from a third party are ignored')
    accumulateDiscovery(state, [srv(8945), aRecord('192.168.1.20')], '192.168.1.20')
    accumulateDiscovery(state, [ptr, srv(9999), aRecord('192.168.1.66')], '192.168.1.66')
    accumulateDiscovery(state, [srv(1111), aRecord('10.0.0.1')], '192.168.1.20')
    assert.deepEqual(
      discoveryResults(state).map((entry) => entry.url),
      ['https://192.168.1.20:8945'],
      'and once resolved, nothing overwrites it — not even the same responder'
    )
  }

  // A name the network cannot resolve falls back to the responder's address.
  {
    const state: DiscoveryState = new Map()
    accumulateDiscovery(state, [ptr, srv(8945, 'unresolvable.local')], '192.168.1.21')
    assert.equal(discoveryResults(state)[0]?.host, '192.168.1.21')
  }

  // Answers for other services are not ours.
  {
    const state: DiscoveryState = new Map()
    accumulateDiscovery(
      state,
      [{ ...ptr, name: '_http._tcp.local', data: { kind: 'ptr', target: 'x._http._tcp.local' } }],
      '192.168.1.22'
    )
    assert.equal(state.size, 0)
  }
  console.log('ok  discovery responder binding')
}

// --- join-request limits ------------------------------------------------------------
async function pairingLimits(): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-lan-hardening-'))
  try {
    const pairing = createPairing(root)
    await pairing.load()
    // Unclaimed servers let the first device straight in; that is the
    // daemon's business (daemon.test.ts). Here only the counting matters.
    let accepted = 0
    for (let i = 0; i < MAX_REQUESTS_PER_SOURCE_PER_MINUTE + 3; i++) {
      if (await pairing.requestPairing(`noisy ${i}`, { source: '192.168.1.50' })) accepted++
    }
    assert.ok(accepted <= MAX_REQUESTS_PER_SOURCE_PER_MINUTE, 'one address cannot keep asking')
    assert.ok(accepted <= MAX_PENDING_PER_SOURCE, 'nor keep more than a few requests waiting')
    assert.ok(
      await pairing.requestPairing('quiet', { source: '192.168.1.51' }),
      'while another address still gets its turn'
    )
  } finally {
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
  console.log('ok  join-request limits per source')
}

pairingLimits().catch((error) => {
  console.error(error)
  process.exit(1)
})
