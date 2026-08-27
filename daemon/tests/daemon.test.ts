// Unit tests for the r3-cache daemon core: the three-layer expiry rule,
// tombstones, pairing, auth boundaries, and Range serving — everything the
// live deployment then only has to confirm, not discover.
// Run with: npx tsx daemon/tests/daemon.test.ts

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createCredentials } from '../credentials'
import { createJobStore } from '../jobs'
import { createPairing } from '../pairing'
import { createDaemonServer } from '../server'
import { createItemStore, planEvictions, type StoredItem } from '../storage'

const DAY = 24 * 60 * 60 * 1000

function item(overrides: Partial<StoredItem>): StoredItem {
  return {
    contentKey: 'tt1::',
    title: 'T',
    infoHash: 'a'.repeat(40),
    fileName: 'f.mkv',
    sizeBytes: 100,
    presentBytes: 100,
    complete: true,
    fetchedAt: 0,
    lastAccessAt: 0,
    ...overrides
  }
}

// --- planEvictions: the "never fills up indefinitely" rule ------------------

const policy = { idleTtlMs: 14 * DAY, hardMaxMs: 30 * DAY, budgetBytes: 1000 }

{
  // Hard max beats everything — the user's explicit requirement: even an
  // item watched five minutes ago dies at the absolute age limit.
  const now = 31 * DAY
  const plan = planEvictions(
    [item({ infoHash: 'a'.repeat(40), fetchedAt: 0, lastAccessAt: now - 1 })],
    policy,
    now
  )
  assert.equal(plan.get('a'.repeat(40)), 'hard-max', 'recent access does not save an aged item')
}

{
  // Idle TTL: untouched for 14 days goes; recently played stays.
  const now = 20 * DAY
  const plan = planEvictions(
    [
      item({ infoHash: 'a'.repeat(40), fetchedAt: 4 * DAY, lastAccessAt: 5 * DAY }),
      item({ infoHash: 'b'.repeat(40), fetchedAt: 10 * DAY, lastAccessAt: 19 * DAY })
    ],
    policy,
    now
  )
  assert.equal(plan.get('a'.repeat(40)), 'idle')
  assert.equal(plan.has('b'.repeat(40)), false, 'a recently played item survives')
}

{
  // Budget: young, busy items still cannot exceed the cap — least recently
  // accessed goes first, and eviction stops as soon as it fits.
  const now = 5 * DAY
  const plan = planEvictions(
    [
      item({ infoHash: 'a'.repeat(40), presentBytes: 600, fetchedAt: now, lastAccessAt: 1 * DAY }),
      item({ infoHash: 'b'.repeat(40), presentBytes: 600, fetchedAt: now, lastAccessAt: 2 * DAY }),
      item({ infoHash: 'c'.repeat(40), presentBytes: 600, fetchedAt: now, lastAccessAt: 3 * DAY })
    ],
    policy,
    now
  )
  assert.equal(plan.get('a'.repeat(40)), 'budget', 'oldest access evicted first')
  assert.equal(plan.get('b'.repeat(40)), 'budget', 'evicts until under budget')
  assert.equal(plan.has('c'.repeat(40)), false, 'stops once it fits')
}

{
  // Under budget and fresh: nothing to do.
  const plan = planEvictions(
    [item({ presentBytes: 500, fetchedAt: 0, lastAccessAt: 0 })],
    policy,
    DAY
  )
  assert.equal(plan.size, 0)
}

console.log('ok  eviction planner')

async function main(): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-cache-test-'))
  try {
    // --- item store on disk: tombstones follow TTL evictions, not budget --
    const store = createItemStore(root, { ...policy, tombstoneMs: 60 * DAY })
    const hashA = 'a'.repeat(40)
    const dirA = await store.beginItem({
      contentKey: 'tt1::',
      title: 'Old Film',
      infoHash: hashA,
      fileName: 'old.mkv',
      sizeBytes: 4,
      fetchedAt: Date.now() - 31 * DAY,
      lastAccessAt: Date.now() - 31 * DAY
    })
    await fsp.writeFile(path.join(dirA, 'old.mkv'), 'DATA')

    const plan = await store.runEviction()
    assert.equal(plan.get(hashA), 'hard-max')
    assert.equal(await store.get(hashA), null, 'evicted item is gone from disk')
    const stones = await store.tombstones()
    assert.ok('tt1::' in stones, 'a TTL eviction leaves a tombstone')

    await store.clearTombstone('tt1::')
    assert.equal('tt1::' in (await store.tombstones()), false, 'renewed interest lifts it')

    // Path traversal in a file name must be rejected outright.
    await assert.rejects(
      () =>
        store.beginItem({
          contentKey: 'tt2::',
          title: 'Evil',
          infoHash: 'b'.repeat(40),
          fileName: '../escape.mkv',
          sizeBytes: 1,
          fetchedAt: Date.now(),
          lastAccessAt: Date.now()
        }),
      /Invalid file name/
    )

    // --- external disk pressure: the cache yields -------------------------
    // Two fresh, recently-played items well under the configured budget —
    // but the DISK is nearly full because something else on the box ate
    // it. The effective budget tightens and the LRU item goes, keeping the
    // pressure margin for the machine's more important tenants.
    {
      const now = Date.now()
      const mk = async (hash: string, key: string, lastAccessAt: number): Promise<void> => {
        const dir = await store.beginItem({
          contentKey: key,
          title: key,
          infoHash: hash,
          fileName: 'f.mkv',
          sizeBytes: 4,
          fetchedAt: now,
          lastAccessAt
        })
        await fsp.writeFile(path.join(dir, 'f.mkv'), 'DATA')
      }
      await mk('1'.repeat(40), 'tt-p1::', now - 1000)
      await mk('2'.repeat(40), 'tt-p2::', now)

      // Plenty of free disk: nothing to do.
      const calm = await store.runEviction(now, 100 * 1024 ** 3)
      assert.equal(calm.size, 0, 'no pressure, no eviction')

      // Almost no free disk: itemBytes(8) + free(0) - margin < 8, so the
      // LRU item is shed even though the configured budget is not hit.
      const squeezed = await store.runEviction(now, 0)
      assert.equal(squeezed.get('1'.repeat(40)), 'budget', 'LRU item yields to disk pressure')
      assert.equal(squeezed.has('2'.repeat(40)), true, 'both go when free space is zero')
      assert.equal(
        'tt-p1::' in (await store.tombstones()),
        false,
        'pressure evictions do not tombstone — they reflect the disk, not disinterest'
      )
    }

    // --- pairing ----------------------------------------------------------
    const pairing = createPairing(root)
    await pairing.load()
    const code = pairing.currentCode()
    assert.equal(await pairing.tryPair('000000' === code ? '111111' : '000000', 'x'), null)
    const token = await pairing.tryPair(code, 'test device')
    assert.ok(token, 'the correct code pairs')
    assert.notEqual(pairing.currentCode(), code, 'a code is single-use')
    assert.equal(pairing.isAuthorized(token!), true)
    assert.equal(pairing.isAuthorized('f'.repeat(64)), false)
    // Throttle: the two attempts above + three more exhaust the minute.
    for (let i = 0; i < 3; i++) await pairing.tryPair('999999', 'x')
    assert.equal(
      await pairing.tryPair(pairing.currentCode(), 'x'),
      null,
      'attempts are rate-limited even with the right code'
    )

    // --- HTTP surface -----------------------------------------------------
    const hashC = 'c'.repeat(40)
    const dirC = await store.beginItem({
      contentKey: 'tt3::',
      title: 'Served Film',
      infoHash: hashC,
      fileName: 'served.mkv',
      sizeBytes: 26,
      fetchedAt: Date.now(),
      lastAccessAt: Date.now()
    })
    await fsp.writeFile(path.join(dirC, 'served.mkv'), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')

    const jobs = createJobStore(root)
    const credentials = createCredentials(root)
    const server = createDaemonServer({
      storage: store,
      jobs,
      pairing,
      credentials,
      serverName: 'test',
      version: '0.0.0',
      diskBudgetBytes: policy.budgetBytes
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const base = `http://127.0.0.1:${port}`
    const auth = { Authorization: `Bearer ${token}` }

    try {
      const ping = await fetch(`${base}/api/ping`)
      assert.equal(ping.status, 200, 'ping needs no auth')
      assert.equal(((await ping.json()) as { product: string }).product, 'r3-cache')

      assert.equal((await fetch(`${base}/api/catalog`)).status, 401, 'catalog requires pairing')
      assert.equal(
        (await fetch(`${base}/api/status`, { headers: { Authorization: 'Bearer nope' } })).status,
        401,
        'a made-up token is refused'
      )

      const catalog = await fetch(`${base}/api/catalog`, { headers: auth })
      assert.equal(catalog.status, 200)
      const body = (await catalog.json()) as { items: Array<{ contentKey: string }> }
      assert.ok(body.items.some((entry) => entry.contentKey === 'tt3::'))

      // Queueing requires real fields; junk is a 400, not a crash.
      const bad = await fetch(`${base}/api/jobs`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ contentKey: '', infoHash: 'zz', title: '' })
      })
      assert.equal(bad.status, 400)

      // --- /stream: token gating and Range contract -----------------------
      assert.equal((await fetch(`${base}/stream/${hashC}`)).status, 403, 'no token, no bytes')
      const full = await fetch(`${base}/stream/${hashC}?token=${token}`)
      assert.equal(full.status, 200)
      assert.equal(await full.text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')

      const ranged = await fetch(`${base}/stream/${hashC}?token=${token}`, {
        headers: { Range: 'bytes=2-5' }
      })
      assert.equal(ranged.status, 206, 'a Range request gets 206 — seeking depends on this')
      assert.equal(ranged.headers.get('content-range'), 'bytes 2-5/26')
      assert.equal(await ranged.text(), 'CDEF')

      const suffix = await fetch(`${base}/stream/${hashC}?token=${token}`, {
        headers: { Range: 'bytes=-4' }
      })
      assert.equal(suffix.status, 206)
      assert.equal(await suffix.text(), 'WXYZ', 'suffix ranges serve the file tail')

      const bogus = await fetch(`${base}/stream/${hashC}?token=${token}`, {
        headers: { Range: 'bytes=100-200' }
      })
      assert.equal(bogus.status, 416, 'an unsatisfiable range is refused, not clamped')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
}

void main().then(() => {
  console.log('ok  r3-cache daemon core')
})
