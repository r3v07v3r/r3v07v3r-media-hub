// Each person's TorBox key on the LAN cache, and the claim window, from the
// app's side (lanCache.ts), driven against a REAL daemon server booted in
// this process from daemon/server.ts. What is pinned:
//   - a join the app makes by itself saves this device's key on the cache,
//     and the joining toast says so;
//   - a join by hand with the consent unticked saves nothing, and a later
//     key change is not pushed either;
//   - with consent, a changed key replaces the saved one and a removed key
//     is removed from the cache;
//   - a key change or removal made while the server is away is sent when
//     it next answers;
//   - a download refused for want of a key is reported once, not per title;
//   - the app's own claim closes a --claim-admin reopening, and the explicit
//     close works too.
// lanCache.ts imports 'electron', hence the headless stand-in, as in
// lanCacheAutoJoin.test.ts.
// Run with: npx tsx tests/lanCacheKeyPush.test.ts

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
import { createPairing, deviceIdForToken } from '../daemon/pairing'
import { createDaemonServer } from '../daemon/server'
import { createItemStore } from '../daemon/storage'

process.env.R3_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-lan-keypush-'))
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

async function main(): Promise<void> {
  const { initSecretStorage } = await import('../src/main/media-hub/secretStorage')
  await initSecretStorage(process.env.R3_USER_DATA as string)
  const store = await import('../src/main/media-hub/settingsStore')
  const lan = await import('../src/main/media-hub/lanCache')
  const bridge = await import('../src/main/media-hub/rendererBridge')
  const { BrowserWindow, ipcMain } = await import('../src/headless/electronShim')
  const { MEDIA_HUB_CHANNELS } = await import('../src/shared/media-hub/ipc-channels')

  // The renderer, as far as lanCache.ts can tell: every event it sends.
  const events: Array<{ kind: string; keySaved?: boolean }> = []
  bridge.setActiveWindow({
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => {
        if (channel === MEDIA_HUB_CHANNELS.lanCacheEvent) {
          events.push(payload as { kind: string; keySaved?: boolean })
        }
      }
    }
  } as never)

  const setAppKey = (value: string): void => {
    const settings = store.readSettings()
    if (value) {
      settings.torboxToken = store.encrypt(value)
      settings.onboardingVersion = 2
    } else {
      delete settings.torboxToken
    }
    store.writeSettings(settings)
  }

  // --- the daemon -----------------------------------------------------------
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-keypush-daemon-'))
  const pairing = createPairing(root)
  await pairing.load()
  const admin = createAdmin(root)
  await admin.load()
  const credentials = createCredentials(root)
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
    credentials,
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
    serverName: 'r3-host.lan',
    version: '0.0.0',
    diskBudgetBytes: 10 ** 9,
    log: () => {}
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const url = `http://127.0.0.1:${port}`
  const found = async (): Promise<
    Array<{ name: string; host: string; port: number; url: string }>
  > => [{ name: 'r3-host-lan', host: '127.0.0.1', port, url }]

  const ownerToken = (
    (await (
      await fetch(`${url}/api/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceName: 'the owner' })
      })
    ).json()) as { token: string }
  ).token
  await fetch(`${url}/api/admin/claim`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}` }
  })
  await admin.setOpenJoin(true)
  const savedKey = (): string => {
    const token = store.getLanCacheConnection()?.token ?? ''
    return credentials.tokenForDevice(deviceIdForToken(token))
  }

  try {
    await check('a join the app makes by itself saves the key, and says so', async () => {
      setAppKey('app-torbox-key-1')
      store.clearLanCacheConnection()
      events.length = 0
      assert.equal(await lan.runLanCacheAutoConnect(found), 'joined')
      assert.equal(savedKey(), 'app-torbox-key-1', 'the cache holds this device key')
      const joined = events.find((event) => event.kind === 'joined')
      assert.equal(joined?.keySaved, true, 'and the joining toast is told')
    })

    await check(
      'with consent, a changed key replaces it and a removed key is removed',
      async () => {
        setAppKey('app-torbox-key-2')
        assert.equal(await lan.syncTorBoxKeyToLanCache(), true)
        assert.equal(savedKey(), 'app-torbox-key-2')
        setAppKey('')
        assert.equal(await lan.syncTorBoxKeyToLanCache(), false)
        assert.equal(savedKey(), '', 'the cache no longer holds a key for this device')
      }
    )

    await check('a key change made while the server is away is sent when it answers', async () => {
      const live = store.getLanCacheConnection()!
      assert.equal(live.shareTorbox, true, 'the auto-join consent is remembered')
      // The server is away: the same connection at an address nobody answers.
      const probe = http.createServer()
      await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
      const deadPort = (probe.address() as AddressInfo).port
      await new Promise<void>((resolve) => probe.close(() => resolve()))
      store.setLanCacheConnection({ ...live, url: `http://127.0.0.1:${deadPort}` })

      setAppKey('app-torbox-key-away')
      assert.equal(await lan.syncTorBoxKeyToLanCache(), false)
      assert.equal(store.isLanCacheKeySyncPending(), true, 'the failed sync is remembered')

      // Back at its address: the next reachability check sends it.
      store.setLanCacheConnection(live)
      assert.equal(await lan.keepLanCacheAddressCurrent(found), 'current')
      assert.equal(savedKey(), 'app-torbox-key-away', 'the change landed')
      assert.equal(store.isLanCacheKeySyncPending(), false, 'and is no longer pending')

      // A removal while away is a change too: the cache ends up with no key.
      store.setLanCacheConnection({ ...live, url: `http://127.0.0.1:${deadPort}` })
      setAppKey('')
      await lan.syncTorBoxKeyToLanCache()
      assert.equal(store.isLanCacheKeySyncPending(), true)
      assert.equal(savedKey(), 'app-torbox-key-away', 'still there while the server is away')
      store.setLanCacheConnection(live)
      assert.equal(await lan.runLanCacheAutoConnect(found), 'current')
      assert.equal(savedKey(), '', 'removed once it answers')
      assert.equal(store.isLanCacheKeySyncPending(), false)
    })

    await check('a download refused for want of a key is reported once', async () => {
      events.length = 0
      const job = (key: string): Parameters<typeof lan.queueLanCacheJob>[0] =>
        ({ contentKey: key, infoHash: 'd'.repeat(40), title: key }) as never
      assert.equal(await lan.queueLanCacheJob(job('tt1')), false, 'the app falls back')
      assert.equal(await lan.queueLanCacheJob({ ...job('tt2'), infoHash: 'e'.repeat(40) }), false)
      assert.equal(
        events.filter((event) => event.kind === 'key-required').length,
        1,
        'one toast, not one per title'
      )
    })

    await check(
      'a join by hand without consent saves nothing, and later keys stay home',
      async () => {
        setAppKey('app-torbox-key-3')
        store.clearLanCacheConnection()
        const result = await lan.askToJoin(url, { shareTorboxToken: false })
        assert.equal(result.ok, true)
        assert.equal(result.keySaved, false)
        assert.equal(savedKey(), '')
        setAppKey('app-torbox-key-4')
        assert.equal(await lan.syncTorBoxKeyToLanCache(), false)
        assert.equal(savedKey(), '', 'a key change is not pushed without consent')
      }
    )

    await check(
      "the app's own claim closes a reopened window; the explicit close too",
      async () => {
        lan.registerLanCacheIpc(() => {})
        const window = new BrowserWindow()
        const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
        const invoke = (channel: string): Promise<unknown> =>
          ipcMain.dispatchInvoke(event, channel, [undefined])
        store.setLanCacheConnection({ url, name: 'r3-host.lan', token: ownerToken })

        await admin.reopen()
        assert.equal(admin.isUnclaimed(), true)
        const claimed = (await invoke(MEDIA_HUB_CHANNELS.lanCacheClaim)) as { ok: boolean }
        assert.equal(claimed.ok, true)
        assert.equal(admin.isUnclaimed(), false, 'pressing Administer it on the admin closes it')

        await admin.reopen()
        const closed = (await invoke(MEDIA_HUB_CHANNELS.lanCacheCloseClaim)) as { ok: boolean }
        assert.equal(closed.ok, true)
        assert.equal(admin.isUnclaimed(), false)
        assert.equal(admin.isAdmin(deviceIdForToken(ownerToken)), true)
      }
    )
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }

  console.log(`\n${pass} checks passed`)
  // registerLanCacheIpc's timers are unref'd; nothing else holds the process.
}

void main()
