// Unit tests for the r3-cache daemon core: the three-layer expiry rule,
// tombstones, pairing, auth boundaries, and Range serving — everything the
// live deployment then only has to confirm, not discover.
// Run with: npx tsx daemon/tests/daemon.test.ts

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createActivityTracker } from '../activity'
import { createCredentials } from '../credentials'
import { createJobStore } from '../jobs'
import { createPairing, deviceIdForToken } from '../pairing'
import { createDaemonServer } from '../server'
import { createItemStore, isEntitled, planEvictions, type StoredItem } from '../storage'

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
      lastAccessAt: Date.now(),
      // Owned by the device this test pairs as. Without an owner the item is
      // private to nobody and correctly invisible, which is the new rule.
      ownerDeviceId: deviceIdForToken(token!),
      visibility: 'private',
      entitled: [deviceIdForToken(token!)]
    })
    await fsp.writeFile(path.join(dirC, 'served.mkv'), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')

    const jobs = createJobStore(root)
    const credentials = createCredentials(root)
    const activity = createActivityTracker(root)
    const server = createDaemonServer({
      storage: store,
      jobs,
      pairing,
      credentials,
      activity,
      updaterStatus: () => ({
        channel: 'preview',
        enabled: true,
        checkedAt: 0,
        latestSeen: '',
        staged: '',
        stagedAt: 0,
        lastError: ''
      }),
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

      // The unfiltered listing used to return every cached item, with
      // titles, to any paired device. It is gone: asking without keys is a
      // well-formed empty answer rather than an inventory of the household.
      const unfiltered = await fetch(`${base}/api/catalog`, { headers: auth })
      assert.equal(unfiltered.status, 200)
      assert.deepEqual(
        (await unfiltered.json()) as unknown,
        { items: [], inFlight: [], tombstoned: [] },
        'the unfiltered branch no longer enumerates the cache'
      )

      const catalog = await fetch(`${base}/api/catalog?keys=tt3%3A%3A`, { headers: auth })
      assert.equal(catalog.status, 200)
      const body = (await catalog.json()) as { items: Array<{ contentKey: string }> }
      assert.ok(
        body.items.some((entry) => entry.contentKey === 'tt3::'),
        'an entitled device sees its own item when it asks by key'
      )

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

// ---------------------------------------------------------------------
// Entitlement — item visibility, and the read-side hole it closes.
//
// Ownership was already enforced for SPENDING (a fetch bills its own
// owner's TorBox token) and ignored for SEEING: any paired device could
// list every cached item with titles, and stream any of them. These check
// the rules that close that, and the one property that carries the whole
// feature — that "not for you" is indistinguishable from "not here".
// ---------------------------------------------------------------------

async function entitlementTests(): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-entitle-'))
  const store = createItemStore(root, {
    idleTtlMs: 60_000,
    hardMaxMs: 600_000,
    budgetBytes: 10 ** 9,
    tombstoneMs: 60_000
  })

  const alice = 'device-alice'
  const bob = 'device-bob'

  async function seed(
    infoHash: string,
    contentKey: string,
    extra: Record<string, unknown> = {}
  ): Promise<void> {
    const dir = await store.beginItem({
      contentKey,
      title: contentKey,
      infoHash,
      fileName: 'f.mkv',
      sizeBytes: 4,
      fetchedAt: Date.now(),
      lastAccessAt: Date.now(),
      ...extra
    })
    await fsp.writeFile(path.join(dir, 'f.mkv'), 'ABCD')
  }

  const hashA = 'a'.repeat(40)
  const hashShared = 'b'.repeat(40)
  const hashLegacy = 'c'.repeat(40)

  await seed(hashA, 'k-a', {
    ownerDeviceId: alice,
    visibility: 'private',
    entitled: [alice]
  })
  await seed(hashShared, 'k-shared', {
    ownerDeviceId: alice,
    visibility: 'shared',
    entitled: [alice]
  })
  // No owner, no visibility — an item from before entitlement existed.
  await seed(hashLegacy, 'k-legacy')

  // --- the predicate itself -------------------------------------------
  {
    const a = (await store.get(hashA))!
    assert.equal(isEntitled(a, alice), true, 'the owner may see their own item')
    assert.equal(isEntitled(a, bob), false, 'another device may not')
    assert.equal(isEntitled(a, ''), false, 'an unknown device may not')

    const shared = (await store.get(hashShared))!
    assert.equal(isEntitled(shared, bob), true, 'shared is visible to any device')

    const legacy = (await store.get(hashLegacy))!
    assert.equal(
      isEntitled(legacy, bob),
      false,
      'absence reads as private — a missing field must not open an item up'
    )
  }

  // --- migration -------------------------------------------------------
  {
    const changed = await store.migrateEntitlement()
    assert.equal(changed, 1, 'only the item without a visibility is migrated')

    const legacy = (await store.get(hashLegacy))!
    assert.equal(
      legacy.visibility,
      'shared',
      'an item with no identifiable owner becomes shared — stranding it where nobody can reach it is worse'
    )

    // Re-running is a no-op; migration must not re-stamp on every boot.
    assert.equal(await store.migrateEntitlement(), 0, 'migration is idempotent')
  }

  // A known-owner item written before the fields existed becomes private to
  // that owner, not shared. Seeded separately so it is unmigrated.
  {
    const hashOwned = 'd'.repeat(40)
    await seed(hashOwned, 'k-owned', { ownerDeviceId: alice })
    assert.equal(await store.migrateEntitlement(), 1)
    const owned = (await store.get(hashOwned))!
    assert.equal(owned.visibility, 'private')
    assert.deepEqual(owned.entitled, [alice])
    assert.equal(isEntitled(owned, bob), false)
  }

  // --- dedupe ----------------------------------------------------------
  {
    const before = (await fsp.readdir(path.join(root, 'items'))).length
    await store.grantEntitlement(hashA, bob)
    const after = (await fsp.readdir(path.join(root, 'items'))).length
    assert.equal(after, before, 'granting entitlement writes no second copy')

    const a = (await store.get(hashA))!
    assert.equal(isEntitled(a, bob), true, 'the second asker can now stream the existing file')
    assert.equal(isEntitled(a, alice), true, 'and the original owner still can')

    await store.grantEntitlement(hashA, bob)
    assert.equal(
      (await store.get(hashA))!.entitled!.filter((id) => id === bob).length,
      1,
      'granting twice does not duplicate the entry'
    )
  }

  await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  console.log('ok  entitlement rules')
}

// ---------------------------------------------------------------------
// The security-critical one: an unentitled hash must be INDISTINGUISHABLE
// from one that is not here.
//
// Torrent infohashes for popular titles are public, so a daemon that
// answers the two cases differently is fully enumerable — walk a few
// thousand known hashes and learn exactly what the household watches,
// without being entitled to any of it.
//
// Asserted by comparing the responses to each other, not by checking both
// are non-200. Two branches that both happen to 404 today will drift the
// first time somebody adds a helpful message to one of them.
// ---------------------------------------------------------------------

async function indistinguishabilityTest(): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-indist-'))
  const store = createItemStore(root, {
    idleTtlMs: 60_000,
    hardMaxMs: 600_000,
    budgetBytes: 10 ** 9,
    tombstoneMs: 60_000
  })
  const pairing = createPairing(root)
  await pairing.load()
  const token = await pairing.tryPair(pairing.currentCode(), 'prober')
  assert.ok(token, 'paired')

  // Owned by somebody else entirely — the prober is paired, and still must
  // not be able to tell this apart from an empty disk.
  const secret = 'e'.repeat(40)
  const dir = await store.beginItem({
    contentKey: 'k-secret',
    title: 'Something Private',
    infoHash: secret,
    fileName: 'p.mkv',
    sizeBytes: 4,
    fetchedAt: Date.now(),
    lastAccessAt: Date.now(),
    ownerDeviceId: 'someone-else',
    visibility: 'private',
    entitled: ['someone-else']
  })
  await fsp.writeFile(path.join(dir, 'p.mkv'), 'ABCD')

  const jobs = createJobStore(root)
  const credentials = createCredentials(root)
  const activity = createActivityTracker(root)
  const server = createDaemonServer({
    storage: store,
    jobs,
    pairing,
    credentials,
    activity,
    updaterStatus: () => ({
      channel: 'preview',
      enabled: true,
      checkedAt: 0,
      latestSeen: '',
      staged: '',
      stagedAt: 0,
      lastError: ''
    }),
    serverName: 'test',
    version: '0.0.0',
    diskBudgetBytes: 10 ** 9
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const base = `http://127.0.0.1:${port}`

  try {
    const absent = 'f'.repeat(40)
    const forbidden = await fetch(`${base}/stream/${secret}?token=${token}`)
    const missing = await fetch(`${base}/stream/${absent}?token=${token}`)

    assert.equal(
      forbidden.status,
      missing.status,
      'an item you may not have answers with the same status as one that is not here'
    )
    assert.equal(
      await forbidden.text(),
      await missing.text(),
      'and the same body — any difference is an oracle'
    )
    // Headers that vary would leak just as loudly as a body would.
    for (const header of ['content-type', 'content-length', 'accept-ranges', 'content-range']) {
      assert.equal(
        forbidden.headers.get(header),
        missing.headers.get(header),
        `and the same ${header} header`
      )
    }

    // The listing must not leak it either — same predicate, same answer.
    const listed = await fetch(`${base}/api/catalog?keys=k-secret`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    assert.deepEqual(
      ((await listed.json()) as { items: unknown[] }).items,
      [],
      'a paired but unentitled device sees nothing when it asks by key'
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
  console.log('ok  "not for you" is indistinguishable from "not here"')
}

void main()
  .then(() => {
    console.log('ok  r3-cache daemon core')
  })
  .then(entitlementTests)
  .then(indistinguishabilityTest)
