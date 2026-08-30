// The cache server's permission boundary, against a daemon that is
// actually running.
//
//   npx tsx daemon/tests/permissions.e2e.ts
//
// NOT in `npm test`, on purpose: this boots a real daemon, binds a real
// port and writes a real data directory. The unit suite must stay
// something you can run anywhere, twice, in parallel.
//
// WHY IT EXISTS. daemon.test.ts already covers entitlement at the unit
// level, and unit tests are exactly where this class of bug hides: every
// piece can be correct while the assembled server still hands somebody
// else's library to whoever asks. What is proved here is the assembled
// thing — claim, approve, scope, refuse — through HTTP, from an empty
// directory, the way it will meet the first device that pairs with it.
//
// WHAT IT FAKES, and it is one thing: there is no TorBox credential in a
// test, so nothing can be fetched. The three items are written into the
// store by hand. That is honest rather than convenient — what the
// boundary reads is the meta.json each item carries, and meta.json has
// the same shape whether a fetch produced it or this did. The download is
// the only step skipped, and the download is not what decides who may
// read.
//
// WHAT IT DOES NOT COVER, so nobody reads a green run as more than it is:
// dedupe (a second device asking for a hash already held gains
// entitlement rather than a second copy) needs a real fetch, and quota
// eviction needs real files at real sizes. Both are covered by the unit
// suite and neither is exercised here.

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Not the default 8945: a developer's own daemon is very likely already
 *  on that port, and a test that silently talks to it would be both
 *  wrong and destructive. */
const PORT = Number(process.env.R3_E2E_PORT || 8946)
const BASE = `http://127.0.0.1:${PORT}`

let passed = 0
const failures: string[] = []

function check(name: string, expected: unknown, actual: unknown): void {
  if (JSON.stringify(expected) === JSON.stringify(actual)) {
    passed += 1
    console.log(`  ok    ${name}`)
    return
  }
  failures.push(name)
  console.log(`  FAIL  ${name}`)
  console.log(`          expected: ${JSON.stringify(expected)}`)
  console.log(`          actual:   ${JSON.stringify(actual)}`)
}

async function status(url: string, init?: RequestInit): Promise<number> {
  const response = await fetch(url, init)
  await response.arrayBuffer()
  return response.status
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  return (await response.json()) as T
}

function bearer(token: string): RequestInit {
  return { headers: { Authorization: `Bearer ${token}` } }
}

function post(token: string, body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }
}

// --- the daemon under test -------------------------------------------------

let daemon: ChildProcess | null = null
let dataDir = ''

async function startDaemon(): Promise<void> {
  const entry = path.join(process.cwd(), 'daemon', 'main.ts')
  daemon = spawn(process.execPath, ['--import', 'tsx', entry], {
    // No mDNS: this daemon is unclaimed for the first few checks, and an
    // unclaimed one that announces itself is claimable by whoever is on
    // the network. A test must not put one there.
    env: { ...process.env, R3_CACHE_DIR: dataDir, R3_CACHE_NO_MDNS: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const log: string[] = []
  daemon.stdout?.on('data', (chunk: Buffer) => log.push(String(chunk)))
  daemon.stderr?.on('data', (chunk: Buffer) => log.push(String(chunk)))
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch(`${BASE}/api/ping`)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error(`daemon did not come up on ${PORT}:\n${log.join('')}`)
}

async function stopDaemon(): Promise<void> {
  if (!daemon) return
  const ended = new Promise((resolve) => daemon?.once('exit', resolve))
  daemon.kill()
  daemon = null
  await ended
  // The port is released on exit, but the next bind can still lose a race
  // with the OS on Windows; a beat here is cheaper than a flaky suite.
  await new Promise((resolve) => setTimeout(resolve, 300))
}

/**
 * Writes items straight into the store.
 *
 * Three, and each is a case rather than a fixture: one device's own, a
 * second device's own — the scoping has to cut both ways or it is just an
 * ownership filter that happens to hold — and one written before
 * entitlement existed, whose owner nobody can name.
 */
async function seedItems(deviceA: string, deviceB: string): Promise<void> {
  const now = Date.now()
  const plan = [
    { hash: 'a'.repeat(40), key: 'tt1000000:0:0', title: "A's film", owner: deviceA },
    { hash: 'b'.repeat(40), key: 'tt2000000:0:0', title: "B's film", owner: deviceB },
    { hash: 'c'.repeat(40), key: 'tt3000000:0:0', title: 'Older film', owner: null }
  ]
  for (const item of plan) {
    const dir = path.join(dataDir, 'items', item.hash)
    await fsp.mkdir(dir, { recursive: true })
    const payload = Buffer.from(`${item.title} payload `.repeat(64))
    await fsp.writeFile(path.join(dir, 'movie.mkv'), payload)
    await fsp.writeFile(
      path.join(dir, 'meta.json'),
      JSON.stringify({
        contentKey: item.key,
        title: item.title,
        infoHash: item.hash,
        fileName: 'movie.mkv',
        sizeBytes: payload.length,
        fetchedAt: now,
        lastAccessAt: now,
        // The pre-entitlement item carries NEITHER field, which is the
        // whole point of it: the boot migration has to decide what to do
        // with an item nobody can be shown to own.
        ...(item.owner
          ? { ownerDeviceId: item.owner, visibility: 'private', entitled: [item.owner] }
          : {})
      })
    )
  }
}

// --- part one: claiming, and letting a second device in --------------------

interface PairResponse {
  token: string
  status: string
}
interface DeviceRow {
  id: string
  deviceName: string
  status: string
  isAdmin: boolean
  isYou: boolean
}

async function run(): Promise<void> {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-cache-e2e-'))
  await fsp.writeFile(
    path.join(dataDir, 'r3-cache.json'),
    JSON.stringify({ port: PORT, autoUpdate: false, serverName: 'e2e-test' })
  )
  await startDaemon()

  console.log('\nclaiming')
  check(
    'unclaimed before anyone claims',
    true,
    (await json<{ unclaimed: boolean }>(`${BASE}/api/ping`)).unclaimed
  )

  const a = await json<PairResponse>(`${BASE}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceName: 'Living room' })
  })
  // The bootstrap, and it widens nothing: while nobody administers the
  // box, any device on the LAN can already take admin outright, which is
  // strictly more than being let in as a user.
  check('the first device is let in while unclaimed', 'approved', a.status)

  check(
    'an unpaired caller cannot claim',
    401,
    await status(`${BASE}/api/admin/claim`, { method: 'POST' })
  )
  check(
    'the paired device can claim',
    200,
    await status(`${BASE}/api/admin/claim`, post(a.token, {}))
  )
  // Documented as a no-op success so a retried request cannot fail
  // confusingly. The refusal that matters is a DIFFERENT device, below.
  check(
    'the admin re-claiming is a no-op success',
    200,
    await status(`${BASE}/api/admin/claim`, post(a.token, {}))
  )
  check(
    'unclaimed is false afterwards',
    false,
    (await json<{ unclaimed: boolean }>(`${BASE}/api/ping`)).unclaimed
  )

  console.log('\na second device has to be approved')
  const b = await json<PairResponse>(`${BASE}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceName: 'Bedroom TV' })
  })
  check('a later device waits', 'pending', b.status)
  check(
    'a pending device cannot read the catalog',
    401,
    await status(`${BASE}/api/catalog?keys=x`, bearer(b.token))
  )
  check(
    'a pending device cannot read status',
    401,
    await status(`${BASE}/api/status`, bearer(b.token))
  )
  check(
    'a pending device can ask whether it is in',
    'pending',
    (await json<{ status: string }>(`${BASE}/api/pair/status`, bearer(b.token))).status
  )

  const listing = await json<{ devices: DeviceRow[] }>(`${BASE}/api/admin/devices`, bearer(a.token))
  const rowA = listing.devices.find((device) => device.deviceName === 'Living room')
  const rowB = listing.devices.find((device) => device.deviceName === 'Bedroom TV')
  assert.ok(rowA && rowB, 'both devices should appear in the admin listing')
  // The name is what the person approving actually reads, and it was
  // collected at pairing long before anything surfaced it.
  check('the admin sees the waiting device under the name it gave', 'pending', rowB.status)

  check(
    'the admin approves it',
    200,
    await status(`${BASE}/api/admin/devices/${rowB.id}`, post(a.token, { action: 'approve' }))
  )
  check(
    'the approved device can now read status',
    200,
    await status(`${BASE}/api/status`, bearer(b.token))
  )

  console.log('\napproved is not admin')
  check(
    'an approved non-admin cannot list devices',
    403,
    await status(`${BASE}/api/admin/devices`, bearer(b.token))
  )
  check(
    'an approved non-admin cannot take the server',
    409,
    await status(`${BASE}/api/admin/claim`, post(b.token, {}))
  )
  check(
    'an approved non-admin cannot revoke anyone',
    403,
    await status(`${BASE}/api/admin/devices/${rowA.id}`, post(b.token, { action: 'revoke' }))
  )

  // --- part two: the boundary itself ---------------------------------------
  //
  // Seeded with the daemon down, then read back after a restart, so the
  // migration runs for real rather than being called directly.
  await stopDaemon()
  await seedItems(rowA.id, rowB.id)
  await startDaemon()

  console.log('\nthe catalog only shows you your own')
  const keys = 'tt1000000:0:0,tt2000000:0:0,tt3000000:0:0'
  const titlesFor = async (token: string): Promise<string[]> => {
    const result = await json<{ items: { title: string }[] }>(
      `${BASE}/api/catalog?keys=${keys}`,
      bearer(token)
    )
    return result.items.map((item) => item.title).sort()
  }
  check(
    "A sees its own and the shared one, not B's",
    ["A's film", 'Older film'],
    await titlesFor(a.token)
  )
  check(
    "B sees its own and the shared one, not A's",
    ["B's film", 'Older film'],
    await titlesFor(b.token)
  )

  console.log('\nthe migration')
  // Stranding an item nobody can be shown to own is worse than leaving it
  // readable: it was in the cache before anyone had a claim to it.
  check(
    'the item with no identifiable owner is readable by a device that never owned it',
    1,
    (await json<{ items: unknown[] }>(`${BASE}/api/catalog?keys=tt3000000:0:0`, bearer(b.token)))
      .items.length
  )

  console.log('\nstreaming')
  const stream = (hash: string, token: string): Promise<number> =>
    status(`${BASE}/stream/${hash}?token=${token}`)
  const mine = 'a'.repeat(40)
  const shared = 'c'.repeat(40)
  const absent = '0123456789'.repeat(4)
  check('A can play its own item', 200, await stream(mine, a.token))
  check('both can play the shared item', 200, await stream(shared, b.token))
  check('an unpaired token plays nothing', 403, await stream(mine, 'deadbeef'))

  // THE ONE THIS FILE IS REALLY FOR.
  //
  // Torrent infohashes for popular titles are public. A daemon that
  // answers "not for you" differently from "not here" is fully
  // enumerable: walk a few thousand known hashes and you learn exactly
  // what this household watches without ever being entitled to any of it.
  //
  // So the two responses are compared WHOLE — status, headers, body — not
  // merely both-non-200. Two branches that happen to agree today drift
  // the first time somebody adds a helpful message to one of them, and
  // the point of comparing everything is to fail on that day.
  const describe = async (hash: string): Promise<string> => {
    const response = await fetch(`${BASE}/stream/${hash}?token=${b.token}`)
    const body = Buffer.from(await response.arrayBuffer()).toString('base64')
    const headers = [...response.headers.entries()]
      .filter(([name]) => name !== 'date')
      .sort()
      .map(([name, value]) => `${name}: ${value}`)
    return [`${response.status} ${response.statusText}`, ...headers, `body:${body}`].join('\n')
  }
  const notMine = await describe(mine)
  const notThere = await describe(absent)
  check('a hash you may not have is indistinguishable from one that is not here', notThere, notMine)

  console.log('\nrevoking')
  check(
    'the admin revokes the second device',
    200,
    await status(`${BASE}/api/admin/devices/${rowB.id}`, post(a.token, { action: 'revoke' }))
  )
  check('the revoked device is refused', 401, await status(`${BASE}/api/status`, bearer(b.token)))
  check('and can no longer stream even the shared item', 403, await stream(shared, b.token))
}

run()
  .catch((error) => {
    failures.push(String(error))
    console.error(error)
  })
  .finally(async () => {
    await stopDaemon()
    if (dataDir) await fsp.rm(dataDir, { recursive: true, force: true })
    console.log('')
    if (failures.length) {
      console.log(`FAILED  ${failures.length} of ${passed + failures.length}`)
      process.exitCode = 1
      return
    }
    console.log(`ok  cache permissions end to end (${passed} checks)`)
  })
