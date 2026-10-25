// Finding and joining the cache server with nobody typing an address
// (lanCache.ts's runLanCacheAutoConnect, keepLanCacheAddressCurrent and
// checkJoinRequests; lanCacheDiscovery.ts's subnet probe), driven against a
// REAL daemon server booted in this process from daemon/server.ts. What is
// pinned:
//   - open join: a device that finds the server is let straight in;
//   - private mode: the request waits, the administrator's app is told once,
//     Allow lets the device in and Deny keeps it out;
//   - Leave switches the launch search off, so it does not undo itself;
//   - a server that moved is followed, a typed address that still answers is
//     never replaced, and the token is offered only to a server of the same
//     name and kept only by one that recognises it;
//   - the subnet probe's arithmetic, and that it reports daemons only.
//
// One process plays both devices in turn: the requesting app and the
// administrator's app differ only in which connection is stored, so the test
// swaps it. lanCache.ts imports 'electron', hence the headless stand-in, as in
// lanCacheLookup.test.ts.
// Run with: npx tsx tests/lanCacheAutoJoin.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { createActivityTracker } from '../daemon/activity'
import { createAdmin } from '../daemon/admin'
import { createCredentials } from '../daemon/credentials'
import { createJobStore } from '../daemon/jobs'
import { createPairing } from '../daemon/pairing'
import { createDaemonServer } from '../daemon/server'
import { createItemStore } from '../daemon/storage'

process.env.R3_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-lan-autojoin-'))
process.env.R3_ELECTRON_SHIM = '1'
const shim = pathToFileURL(
  path.join(__dirname, '..', 'src', 'headless', 'electronShim', 'index.ts')
)
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron') return { url: shim.href, shortCircuit: true }
    return next(specifier, context)
  }
})

let pass = 0
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

interface Daemon {
  url: string
  port: number
  close: () => Promise<void>
}

async function bootDaemon(serverName: string): Promise<Daemon> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-autojoin-daemon-'))
  const pairing = createPairing(root)
  await pairing.load()
  const admin = createAdmin(root)
  await admin.load()
  const server = createDaemonServer({
    storage: createItemStore(root, {
      idleTtlMs: 60_000,
      hardMaxMs: 600_000,
      budgetBytes: 10 ** 9,
      tombstoneMs: 60_000
    }),
    jobs: createJobStore(root),
    pairing,
    admin,
    credentials: createCredentials(root),
    activity: createActivityTracker(root),
    updaterStatus: () => ({
      channel: 'preview',
      enabled: true,
      checkedAt: 0,
      latestSeen: '',
      staged: '',
      stagedAt: 0,
      lastError: ''
    }),
    serverName,
    version: '0.0.0',
    diskBudgetBytes: 10 ** 9
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  }
}

/** A port nothing listens on: bind one, note it, close it. */
async function deadUrl(): Promise<string> {
  const server = http.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `http://127.0.0.1:${port}`
}

async function main(): Promise<void> {
  const store = await import('../src/main/media-hub/settingsStore')
  const lan = await import('../src/main/media-hub/lanCache')
  const discovery = await import('../src/main/media-hub/lanCacheDiscovery')

  const daemon = await bootDaemon('r3-host.lan')
  const found =
    (url = daemon.url, name = 'r3-host-lan') =>
    async () => [{ name, host: '127.0.0.1', port: Number(new URL(url).port), url }]

  // The owner: the first device on an unclaimed server is let in, then
  // claims it. Done over the wire, as the owner's own app would.
  const ownerToken = (
    (await (
      await fetch(`${daemon.url}/api/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceName: 'the owner' })
      })
    ).json()) as { token: string }
  ).token
  const claim = await fetch(`${daemon.url}/api/admin/claim`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}` }
  })
  assert.equal(claim.status, 200, 'the owner claims the server')
  const asOwner = (): void =>
    store.setLanCacheConnection({ url: daemon.url, name: 'r3-host.lan', token: ownerToken })
  const setOpenJoin = async (openJoin: boolean): Promise<void> => {
    const res = await fetch(`${daemon.url}/api/admin/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ openJoin })
    })
    assert.equal(res.status, 200)
  }

  try {
    await check('open join: a device that finds the server is let straight in', async () => {
      await setOpenJoin(true)
      store.clearLanCacheConnection()
      const outcome = await lan.runLanCacheAutoConnect(found())
      assert.equal(outcome, 'joined')
      const connection = store.getLanCacheConnection()
      assert.equal(connection?.url, daemon.url)
      assert.equal(connection?.name, 'r3-host.lan')
      assert.equal(connection?.pending, undefined, 'not waiting for anybody')
      assert.equal(lan.isLanCacheConnected(), true)
    })

    await check('private mode: the request waits and the administrator is told once', async () => {
      await setOpenJoin(false)
      store.clearLanCacheConnection()
      assert.equal(await lan.runLanCacheAutoConnect(found()), 'asked')
      const requester = store.getLanCacheConnection()
      assert.equal(requester?.pending, true, 'stored as pending')
      assert.equal(lan.isLanCacheConnected(), false, 'a pending device uses nothing')

      asOwner()
      lan.resetJoinRequestState()
      const raised = await lan.checkJoinRequests()
      assert.equal(raised.length, 1, 'the administrator sees the request')
      assert.equal(raised[0].deviceName, os.hostname(), 'named as the device that asked')
      assert.equal(raised[0].status, 'pending')
      assert.deepEqual(await lan.checkJoinRequests(), [], 'raised once, not every poll')

      // Allow, as the toast's button does (it goes through the same admin
      // route the Caching section uses).
      const allow = await fetch(`${daemon.url}/api/admin/devices/${raised[0].id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({ action: 'approve' })
      })
      assert.equal(allow.status, 200)

      store.setLanCacheConnection(requester!)
      assert.equal(await lan.promoteIfApproved(), 'approved')
      assert.equal(store.getLanCacheConnection()?.pending, undefined, 'and it remembers')
      assert.equal(lan.isLanCacheConnected(), true)
      const status = await fetch(`${daemon.url}/api/status`, {
        headers: { Authorization: `Bearer ${requester!.token}` }
      })
      assert.equal(status.status, 200, 'the approved token now works')

      // An approved device that is not the administrator is never told.
      lan.resetJoinRequestState()
      assert.deepEqual(await lan.checkJoinRequests(), [], 'only the administrator is told')
    })

    await check('private mode: Deny keeps the device out', async () => {
      store.clearLanCacheConnection()
      assert.equal(await lan.runLanCacheAutoConnect(found()), 'asked')
      const requester = store.getLanCacheConnection()!
      asOwner()
      const raised = await lan.checkJoinRequests()
      assert.equal(raised.length, 1)
      const deny = await fetch(`${daemon.url}/api/admin/devices/${raised[0].id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({ action: 'deny' })
      })
      assert.equal(deny.status, 200)
      store.setLanCacheConnection(requester)
      await assert.rejects(lan.promoteIfApproved(), 'a denied token is unknown to the server')
      assert.equal(lan.isLanCacheConnected(), false, 'still uses nothing')
    })

    await check('Leave switches the launch search off until joining by hand', async () => {
      store.clearLanCacheConnection()
      store.setLanCacheAutoJoin(false)
      let searched = false
      const outcome = await lan.runLanCacheAutoConnect(async () => {
        searched = true
        return []
      })
      assert.equal(outcome, 'off')
      assert.equal(searched, false, 'does not even look')
      store.setLanCacheAutoJoin(true)
      assert.equal(store.isLanCacheAutoJoinOn(), true)
    })

    await check('a server that moved is followed, and keeps its token', async () => {
      asOwner()
      const moved = { ...store.getLanCacheConnection()!, url: await deadUrl() }
      store.setLanCacheConnection(moved)
      assert.equal(await lan.runLanCacheAutoConnect(found()), 'moved')
      const after = store.getLanCacheConnection()
      assert.equal(after?.url, daemon.url, 're-pointed at where it answers now')
      assert.equal(after?.token, ownerToken, 'same device, same token')
    })

    await check('a typed address that still answers is never replaced', async () => {
      asOwner()
      let searched = false
      const outcome = await lan.keepLanCacheAddressCurrent(async () => {
        searched = true
        return []
      })
      assert.equal(outcome, 'current')
      assert.equal(searched, false, 'no search while the stored address answers')
    })

    await check('a different server of the same name does not take the connection', async () => {
      const stranger = await bootDaemon('r3-host.lan')
      try {
        asOwner()
        const stored = { ...store.getLanCacheConnection()!, url: await deadUrl() }
        store.setLanCacheConnection(stored)
        assert.equal(await lan.keepLanCacheAddressCurrent(found(stranger.url)), 'lost')
        assert.equal(store.getLanCacheConnection()?.url, stored.url, 'left where it was')
      } finally {
        await stranger.close()
      }
    })

    await check('a server with another name is not offered the token at all', async () => {
      asOwner()
      const stored = { ...store.getLanCacheConnection()!, url: await deadUrl() }
      store.setLanCacheConnection(stored)
      // The real server, but announcing a different name: never asked.
      assert.equal(
        await lan.keepLanCacheAddressCurrent(found(daemon.url, 'someone-elses-cache')),
        'lost'
      )
    })

    await check('subnet probe: hosts come from this machine’s own private subnets', () => {
      const hosts = discovery.subnetProbeHosts({
        eth0: [{ address: '10.0.7.23', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
        // A /16 is narrowed to the /24 this machine sits in.
        wifi: [
          { address: '172.20.5.9', netmask: '255.255.0.0', family: 'IPv4', internal: false },
          { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false }
        ],
        lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
        // A public address is not a household network.
        wan: [{ address: '81.2.69.160', netmask: '255.255.255.0', family: 'IPv4', internal: false }]
      })
      assert.equal(hosts.length, 254 + 254, 'two /24s, minus network and broadcast')
      assert.ok(hosts.includes('10.0.7.1') && hosts.includes('10.0.7.254'))
      assert.ok(hosts.includes('10.0.7.23'), 'itself too: the daemon may run on this PC')
      assert.ok(!hosts.includes('10.0.7.0') && !hosts.includes('10.0.7.255'))
      assert.ok(hosts.includes('172.20.5.1') && !hosts.includes('172.20.6.1'))
      assert.ok(!hosts.some((host) => host.startsWith('81.') || host.startsWith('127.')))
    })

    await check('subnet probe: reports r3-cache daemons and nothing else', async () => {
      const impostor = http.createServer((_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ product: 'something-else', serverName: 'x' }))
      })
      await new Promise<void>((resolve) => impostor.listen(0, '127.0.0.1', resolve))
      const impostorPort = (impostor.address() as AddressInfo).port
      try {
        const hit = await discovery.probeSubnetForLanCaches(['127.0.0.1'], daemon.port)
        assert.equal(hit.length, 1)
        assert.equal(hit[0].name, 'r3-host.lan')
        assert.equal(hit[0].url, daemon.url)
        assert.deepEqual(
          await discovery.probeSubnetForLanCaches(['127.0.0.1'], impostorPort),
          [],
          'an HTTP server that is not r3-cache is not a cache server'
        )
        assert.deepEqual(
          await discovery.probeSubnetForLanCaches([new URL(await deadUrl()).hostname], 1),
          [],
          'nobody home is nothing found'
        )
      } finally {
        await new Promise<void>((resolve) => impostor.close(() => resolve()))
      }
    })
  } finally {
    await daemon.close()
  }

  console.log(`\n${pass} checks passed`)
}

void main()
