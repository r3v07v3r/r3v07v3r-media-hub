// The app's trust in its cache server (F4/F10/F23):
//   - addresses are normalised to https://host:port, and nothing else;
//   - the daemon's certificate persists across restarts (so the pin holds);
//   - every pinned call refuses a different certificate BEFORE sending
//     anything, and refuses plain http outright;
//   - the WebSocket agent is pinned the same way;
//   - a join learns the certificate and shows the same verification code the
//     daemon computed; an older daemon (no protocol 2) is refused;
//   - when a token is due for renewal.

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { createActivityTracker } from '../daemon/activity'
import { createAdmin } from '../daemon/admin'
import { createCredentials } from '../daemon/credentials'
import { createJobStore } from '../daemon/jobs'
import { createPairing } from '../daemon/pairing'
import { createDaemonServer } from '../daemon/server'
import { createItemStore } from '../daemon/storage'
import { createSelfSignedIdentity, loadOrCreateTlsIdentity } from '../daemon/tlsIdentity'
import {
  LAN_CACHE_RENEW_WITHIN_MS,
  LanCacheIdentityError,
  lanCacheTokenNeedsRenewal,
  normalizeLanCacheUrl,
  peekLanCacheFingerprint,
  pinnedAgent,
  pinnedFetch,
  requestLanCacheJoin,
  sameLanCacheHost
} from '../src/main/media-hub/lanCacheTrust'

const DAY = 24 * 60 * 60 * 1000

async function main(): Promise<void> {
  // --- addresses ------------------------------------------------------------
  assert.equal(normalizeLanCacheUrl('192.168.1.20:8945'), 'https://192.168.1.20:8945')
  assert.equal(normalizeLanCacheUrl('http://box.lan:8945/'), 'https://box.lan:8945', 'upgraded')
  assert.equal(normalizeLanCacheUrl(' https://box.lan:8945 '), 'https://box.lan:8945')
  assert.throws(() => normalizeLanCacheUrl(''), /server URL/)
  assert.throws(() => normalizeLanCacheUrl('https://user:pw@box.lan:8945'), /just the server/)
  assert.throws(() => normalizeLanCacheUrl('https://box.lan:8945/api/x'), /just the server/)
  assert.throws(() => normalizeLanCacheUrl('ftp://box.lan'), /not a valid/)
  assert.equal(sameLanCacheHost('http://box.lan:8945/x', 'https://box.lan:8945'), true)
  assert.equal(sameLanCacheHost('https://box.lan:8946/x', 'https://box.lan:8945'), false)
  assert.equal(sameLanCacheHost('https://other.lan:8945/x', 'https://box.lan:8945'), false)
  console.log('ok  addresses')

  // --- the daemon's identity persists ------------------------------------------------
  const identityRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-trust-identity-'))
  try {
    const first = await loadOrCreateTlsIdentity(identityRoot)
    const second = await loadOrCreateTlsIdentity(identityRoot)
    assert.match(first.fingerprint, /^[a-f0-9]{64}$/)
    assert.equal(second.fingerprint, first.fingerprint, 'a restart keeps the same certificate')
    const otherRoot = await fsp.mkdtemp(identityRoot + '-b')
    const other = await loadOrCreateTlsIdentity(otherRoot)
    assert.notEqual(other.fingerprint, first.fingerprint, 'another install has its own')
    await fsp.rm(otherRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  } finally {
    await fsp.rm(identityRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
  console.log('ok  certificate persists')

  // --- a real daemon over TLS --------------------------------------------------------
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-trust-daemon-'))
  const tls = createSelfSignedIdentity()
  const pairing = createPairing(root, { fingerprint: tls.fingerprint })
  await pairing.load()
  const admin = createAdmin(root)
  await admin.load()
  const server = createDaemonServer({
    storage: createItemStore(root, {
      idleTtlMs: DAY,
      hardMaxMs: 30 * DAY,
      budgetBytes: 10 ** 9,
      tombstoneMs: DAY
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
    serverName: 'trust-test',
    version: '0.0.0',
    diskBudgetBytes: 10 ** 9,
    log: () => {},
    tls
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const base = `https://127.0.0.1:${port}`
  const wrong = createSelfSignedIdentity().fingerprint

  // An old daemon: answers ping without a protocol version.
  const oldTls = createSelfSignedIdentity()
  const oldDaemon = https.createServer({ key: oldTls.key, cert: oldTls.cert }, (req, res) => {
    let paired = false
    if (req.url === '/api/pair') paired = true
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify(
        paired
          ? { token: 'a'.repeat(64), status: 'approved' }
          : { product: 'r3-cache', serverName: 'old' }
      )
    )
  })
  await new Promise<void>((resolve) => oldDaemon.listen(0, '127.0.0.1', resolve))
  const oldBase = `https://127.0.0.1:${(oldDaemon.address() as AddressInfo).port}`

  try {
    assert.equal(
      await peekLanCacheFingerprint(base),
      tls.fingerprint,
      'the peek sees the certificate'
    )

    // Pinned: works with the right fingerprint, refuses any other before
    // the request is written, and never speaks plain http.
    assert.equal((await pinnedFetch(`${base}/api/ping`, {}, tls.fingerprint)).status, 200)
    await assert.rejects(
      pinnedFetch(`${base}/api/ping`, {}, wrong),
      (error: unknown) => error instanceof LanCacheIdentityError
    )
    await assert.rejects(
      pinnedFetch(`http://127.0.0.1:${port}/api/ping`, {}, tls.fingerprint),
      /without TLS/
    )
    await assert.rejects(pinnedFetch(`${base}/api/ping`, {}, ''), /no pinned identity/)
    console.log('ok  pinned fetch')

    // The agent (rooms hop WebSocket) is pinned the same way.
    const viaAgent = (fingerprint: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = https.get(
          `${base}/api/ping`,
          { agent: pinnedAgent(fingerprint), rejectUnauthorized: false },
          (res) => {
            res.resume()
            resolve(res.statusCode ?? 0)
          }
        )
        req.on('error', reject)
      })
    assert.equal(await viaAgent(tls.fingerprint), 200)
    await assert.rejects(
      viaAgent(wrong),
      (error: unknown) => error instanceof LanCacheIdentityError
    )
    assert.throws(() => pinnedAgent('not-a-fingerprint'), /no pinned identity/)
    console.log('ok  pinned agent')

    // A join pins what it saw and shows the daemon's own code.
    const join = await requestLanCacheJoin({ url: `127.0.0.1:${port}`, deviceName: 'laptop' })
    assert.ok(join)
    assert.equal(join.url, base)
    assert.equal(join.fingerprint, tls.fingerprint, 'the join pins the certificate')
    assert.equal(join.serverName, 'trust-test')
    assert.ok(join.tokenExpiresAt > Date.now() + 80 * DAY, 'the token comes with its expiry')
    const stored = pairing.listDevices().find((device) => device.deviceName === 'laptop')
    assert.match(join.verification, /^\d{6}$/)
    assert.equal(stored?.verification, join.verification, 'both sides show the same code')
    assert.equal(
      await requestLanCacheJoin({ url: base, deviceName: 'never', stillWanted: () => false }),
      null,
      'a join no longer wanted creates nothing'
    )
    assert.equal(
      pairing.listDevices().some((device) => device.deviceName === 'never'),
      false
    )

    await assert.rejects(
      requestLanCacheJoin({ url: oldBase, deviceName: 'laptop' }),
      /older r3-cache/,
      'a daemon without the pinned protocol is not joined'
    )
    console.log('ok  join pins and verifies')
  } finally {
    server.closeAllConnections()
    oldDaemon.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await new Promise<void>((resolve) => oldDaemon.close(() => resolve()))
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }

  // --- renewal timing ------------------------------------------------------------------
  const now = Date.now()
  assert.equal(lanCacheTokenNeedsRenewal(0, now), true, 'unknown expiry: renew')
  assert.equal(lanCacheTokenNeedsRenewal(now + 89 * DAY, now), false)
  assert.equal(lanCacheTokenNeedsRenewal(now + LAN_CACHE_RENEW_WITHIN_MS - 1, now), true)
  console.log('ok  renewal timing')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
