// Unit tests for the r3-cache daemon core: the three-layer expiry rule,
// tombstones, pairing, auth boundaries, and Range serving — everything the
// live deployment then only has to confirm, not discover.
// Run with: npx tsx daemon/tests/daemon.test.ts

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createActivityTracker } from '../activity'
import { createAdmin } from '../admin'
import { createCredentials } from '../credentials'
import { createJobStore } from '../jobs'
import { createPairing, deviceIdForToken, isApproved, type Pairing } from '../pairing'
import { createDaemonServer } from '../server'
import { createItemStore, isEntitled, planEvictions, type StoredItem } from '../storage'

const DAY = 24 * 60 * 60 * 1000

/** Joins and approves in one step — what every test that used to call
 *  tryPair(currentCode()) actually wanted: a device this daemon will
 *  answer. Approval is exercised properly by approvalTests and
 *  deviceRouteTests; everywhere else it is setup, not the subject. */
async function joinApproved(pairing: Pairing, deviceName: string): Promise<string> {
  const token = await pairing.requestPairing(deviceName)
  assert.ok(token, `pairing request for ${deviceName} was accepted`)
  await pairing.setStatus(deviceIdForToken(token), 'approved')
  return token
}

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

// --- planEvictions: per-device allocation ----------------------------------
//
// Eviction stops being one global LRU here, which makes this the riskiest
// change to existing behaviour in the whole feature: it deletes real files,
// and per-device accounting changes WHICH ones. So the first thing asserted
// is that it changes nothing at all until somebody sets a number.

{
  const now = 5 * DAY
  const items = [
    item({
      infoHash: 'a'.repeat(40),
      presentBytes: 400,
      ownerDeviceId: 'alice',
      fetchedAt: now,
      lastAccessAt: 1 * DAY
    }),
    item({
      infoHash: 'b'.repeat(40),
      presentBytes: 400,
      ownerDeviceId: 'alice',
      fetchedAt: now,
      lastAccessAt: 2 * DAY
    })
  ]

  // No quota map: byte-for-byte the old behaviour. This is what every
  // running cache does, and it has to keep doing it after this lands.
  assert.equal(planEvictions(items, policy, now).size, 0, 'no quotas means no quota evictions')
  assert.equal(
    planEvictions(items, { ...policy, quotas: new Map() }, now).size,
    0,
    'and an empty map is not a quota of zero'
  )

  // A device absent from the map is unquotaed, not quotaed at nothing.
  assert.equal(
    planEvictions(items, { ...policy, quotas: new Map([['bob', 10]]) }, now).size,
    0,
    "another device's quota does not reach alice's items"
  )
}

{
  // Over quota: the device loses ITS OWN oldest-accessed items, and stops
  // as soon as it fits.
  const now = 5 * DAY
  const plan = planEvictions(
    [
      item({
        infoHash: 'a'.repeat(40),
        presentBytes: 300,
        ownerDeviceId: 'alice',
        fetchedAt: now,
        lastAccessAt: 1 * DAY
      }),
      item({
        infoHash: 'b'.repeat(40),
        presentBytes: 300,
        ownerDeviceId: 'alice',
        fetchedAt: now,
        lastAccessAt: 2 * DAY
      }),
      item({
        infoHash: 'c'.repeat(40),
        presentBytes: 300,
        ownerDeviceId: 'alice',
        fetchedAt: now,
        lastAccessAt: 3 * DAY
      }),
      // Bob is well under his own allocation and must not be touched, even
      // though his item is the least recently accessed on the whole disk.
      item({
        infoHash: 'd'.repeat(40),
        presentBytes: 100,
        ownerDeviceId: 'bob',
        fetchedAt: now,
        lastAccessAt: 0
      })
    ],
    {
      ...policy,
      // 900 held against 700 allowed: one 300 file takes her to 600, so
      // exactly one goes.
      quotas: new Map([
        ['alice', 700],
        ['bob', 500]
      ])
    },
    now
  )
  assert.equal(plan.get('a'.repeat(40)), 'quota', "alice's oldest goes first")
  assert.equal(plan.has('b'.repeat(40)), false, 'and eviction stops once she fits')
  assert.equal(plan.has('c'.repeat(40)), false)
  assert.equal(
    plan.has('d'.repeat(40)),
    false,
    "bob keeps the oldest file on the disk — it is not his overspend"
  )
}

{
  // A shared item is charged ONCE, to the device that fetched it.
  //
  // Charge every entitled device and sharing becomes the way to make an
  // item cost everybody; charge nobody and sharing becomes the way to make
  // it cost no-one. Either way the accounting is gamed by the same move.
  const now = 5 * DAY
  const shared = item({
    infoHash: 'a'.repeat(40),
    presentBytes: 900,
    ownerDeviceId: 'alice',
    entitled: ['alice', 'bob', 'carol'],
    visibility: 'shared',
    fetchedAt: now,
    lastAccessAt: 4 * DAY
  })
  const bobs = item({
    infoHash: 'b'.repeat(40),
    presentBytes: 100,
    ownerDeviceId: 'bob',
    fetchedAt: now,
    lastAccessAt: 1 * DAY
  })
  const quotas = new Map([
    ['alice', 500],
    ['bob', 500]
  ])
  const plan = planEvictions([shared, bobs], { ...policy, quotas }, now)
  assert.equal(plan.get('a'.repeat(40)), 'quota', 'the fetcher pays for what she fetched')
  assert.equal(
    plan.has('b'.repeat(40)),
    false,
    'and being entitled to it costs bob nothing — he is at 100 of 500, not 1000'
  )
}

{
  // lastAccessAt is the newest touch by ANYONE entitled, because touch()
  // advances it for whoever streamed the file. So an item the household is
  // still watching is not evicted because the device that originally
  // fetched it lost interest.
  const now = 5 * DAY
  const plan = planEvictions(
    [
      // Alice fetched this and never went back — but somebody entitled
      // played it yesterday, which is what lastAccessAt records.
      item({
        infoHash: 'a'.repeat(40),
        presentBytes: 300,
        ownerDeviceId: 'alice',
        entitled: ['alice', 'bob'],
        fetchedAt: 0,
        lastAccessAt: 4 * DAY
      }),
      item({
        infoHash: 'b'.repeat(40),
        presentBytes: 300,
        ownerDeviceId: 'alice',
        fetchedAt: 0,
        lastAccessAt: 1 * DAY
      })
    ],
    { ...policy, quotas: new Map([['alice', 300]]) },
    now
  )
  assert.equal(
    plan.get('b'.repeat(40)),
    'quota',
    'the genuinely untouched item goes, not the one somebody is still watching'
  )
  assert.equal(plan.has('a'.repeat(40)), false)
}

{
  // Ownerless items — the pre-multi-user files — are charged to nobody.
  // There is no device to bill them to, and picking one would evict a
  // stranger's files. They remain reachable through the whole-disk pass.
  const now = 5 * DAY
  const orphan = item({
    infoHash: 'a'.repeat(40),
    presentBytes: 900,
    fetchedAt: now,
    lastAccessAt: 1 * DAY
  })
  const quotas = new Map([['alice', 10]])
  assert.equal(
    planEvictions([orphan], { ...policy, quotas }, now).size,
    0,
    'an unowned item is charged to nobody'
  )
  assert.equal(
    planEvictions(
      [orphan, item({ infoHash: 'b'.repeat(40), presentBytes: 900, fetchedAt: now, lastAccessAt: 2 * DAY })],
      { ...policy, quotas },
      now
    ).get('a'.repeat(40)),
    'budget',
    'but the whole-disk budget still reaches it'
  )
}

{
  // The whole disk still bounds everything, on top of quotas — and the
  // budget pass must not re-charge what the quota pass already took, or it
  // evicts far more than it needed to.
  const now = 5 * DAY
  const plan = planEvictions(
    [
      item({
        infoHash: 'a'.repeat(40),
        presentBytes: 700,
        ownerDeviceId: 'alice',
        fetchedAt: now,
        lastAccessAt: 1 * DAY
      }),
      item({
        infoHash: 'b'.repeat(40),
        presentBytes: 700,
        ownerDeviceId: 'alice',
        fetchedAt: now,
        lastAccessAt: 2 * DAY
      }),
      item({
        infoHash: 'c'.repeat(40),
        presentBytes: 200,
        ownerDeviceId: 'bob',
        fetchedAt: now,
        lastAccessAt: 3 * DAY
      })
    ],
    { ...policy, quotas: new Map([['alice', 700]]) },
    now
  )
  // Alice is 700 over her allocation, so her oldest goes. What is left is
  // 900 against a 1000 budget, so the budget pass has nothing to do.
  assert.equal(plan.get('a'.repeat(40)), 'quota')
  assert.equal(plan.size, 1, 'the budget pass counts what the quota pass already removed')
}

{
  // Quota does not override the two passes above it: an item past the hard
  // max is gone for that reason regardless of whose allocation it sits in.
  const now = 31 * DAY
  const plan = planEvictions(
    [
      item({
        infoHash: 'a'.repeat(40),
        presentBytes: 900,
        ownerDeviceId: 'alice',
        fetchedAt: 0,
        lastAccessAt: now - 1
      })
    ],
    { ...policy, quotas: new Map([['alice', 10]]) },
    now
  )
  assert.equal(plan.get('a'.repeat(40)), 'hard-max', 'age still beats allocation')
}

console.log('ok  per-device allocation')

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
    const token = await joinApproved(pairing, 'test device')
    assert.equal(pairing.isAuthorized(token), true)
    assert.equal(pairing.isAuthorized('f'.repeat(64)), false)
    // The request is unauthenticated now that there is no code to present,
    // so it is throttled — otherwise anyone on the LAN could fill an
    // administrator's approval list and this daemon's auth.json.
    // RATE, on its own. Each accepted request is approved immediately so
    // the queue never fills — otherwise the cap would stop the loop first
    // and this would pass with no rate limit at all.
    let accepted = 0
    for (let i = 0; i < 20; i++) {
      const requested = await pairing.requestPairing(`flood-${i}`)
      if (!requested) continue
      accepted++
      await pairing.setStatus(deviceIdForToken(requested), 'approved')
    }
    assert.ok(accepted > 0, 'a real device can still get in')
    assert.ok(accepted <= 10, `joining is rate-limited (accepted ${accepted} in a minute)`)
    assert.equal(
      await pairing.requestPairing('one more'),
      null,
      'and the refusal is a refusal, not a slower yes'
    )

    // THE QUEUE CAP, on its own, on a daemon whose minute is unspent. It is
    // the limit that actually protects the administrator: the rate limit
    // only slows a flood, this is what stops it accumulating.
    const fresh = createPairing(await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-cap-')))
    await fresh.load()
    for (let i = 0; i < 20; i++) await fresh.requestPairing(`waiting-${i}`)
    assert.equal(
      fresh.listDevices().filter((device) => !isApproved(device)).length,
      8,
      'the pending queue is capped'
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
      ownerDeviceId: deviceIdForToken(token),
      visibility: 'private',
      entitled: [deviceIdForToken(token)]
    })
    await fsp.writeFile(path.join(dirC, 'served.mkv'), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')

    const jobs = createJobStore(root)
    const credentials = createCredentials(root)
    const activity = createActivityTracker(root)
    const admin = createAdmin(root)
    await admin.load()
    const server = createDaemonServer({
      storage: store,
      jobs,
      pairing,
      admin,
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
  const token = await joinApproved(pairing, 'prober')
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
  const admin = createAdmin(root)
  await admin.load()
  const server = createDaemonServer({
    storage: store,
    jobs,
    pairing,
    admin,
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

// ---------------------------------------------------------------------
// Claiming the server.
//
// The button is the easy part; the BOUND is what needed care. Pure
// first-come leaves an unclaimed headless daemon open to whoever finds it,
// and this one is advertised over mDNS and runs at boot on a box nobody
// looks at — so "the first person to connect" a week after install is not
// necessarily the installer.
// ---------------------------------------------------------------------

async function claimTests(): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-claim-'))
  const admin = createAdmin(root)
  await admin.load()

  assert.equal(admin.isUnclaimed(), true, 'a fresh server is unclaimed')
  assert.equal(admin.adminDeviceId(), '', 'and has no administrator')

  // An unclaimed server must not call every stranger its administrator.
  assert.equal(admin.isAdmin('anybody'), false, 'unclaimed does not mean everyone is admin')
  assert.equal(admin.isAdmin(''), false, 'and an unknown token is nobody')

  assert.equal(await admin.claim('device-one'), true, 'the first claim succeeds')
  assert.equal(admin.isAdmin('device-one'), true)
  assert.equal(admin.isUnclaimed(), false, 'and the server is no longer claimable')

  assert.equal(await admin.claim('device-two'), false, 'a second device cannot take it')
  assert.equal(admin.isAdmin('device-two'), false)
  assert.equal(admin.adminDeviceId(), 'device-one', 'the original admin is untouched')

  // A retried request from the holder must not fail confusingly.
  assert.equal(await admin.claim('device-one'), true, 're-claiming by the holder is a no-op')

  // Persisted, not just in memory — the whole point is surviving a restart.
  const reloaded = createAdmin(root)
  await reloaded.load()
  assert.equal(reloaded.isAdmin('device-one'), true, 'the claim survives a restart')
  assert.equal(reloaded.isUnclaimed(), false)

  // openJoin is an admin PREFERENCE, not authorisation state, and it lives
  // in the same file. It has to survive a restart like the claim does, and
  // survive a takeover: claiming decides who administers the box, not what
  // they have configured on it, and a persisted setting that silently flips
  // during a recovery is exactly the kind of change nobody thinks to check.
  assert.equal(reloaded.openJoin(), false, 'the network is not open by default')
  await reloaded.setOpenJoin(true)
  const afterRestart = createAdmin(root)
  await afterRestart.load()
  assert.equal(afterRestart.openJoin(), true, 'the switch survives a restart')
  // The default allocation is a PERCENTAGE of the budget, not a fixed
  // figure: the same number has to be sensible on a 500 GB laptop and a
  // 20 TB server. 0 means there is no default at all, which is the state
  // that keeps every existing install behaving exactly as it did.
  assert.equal(afterRestart.defaultQuotaPercent(), 0, 'there is no default allocation')
  await afterRestart.setDefaultQuotaPercent(25)
  assert.equal(afterRestart.defaultQuotaPercent(), 25)
  await afterRestart.setDefaultQuotaPercent(430)
  assert.equal(afterRestart.defaultQuotaPercent(), 100, 'a nonsense figure is clamped, not stored')
  await afterRestart.setDefaultQuotaPercent(-5)
  assert.equal(afterRestart.defaultQuotaPercent(), 0)
  await afterRestart.setDefaultQuotaPercent(30)
  const thirdBoot = createAdmin(root)
  await thirdBoot.load()
  assert.equal(thirdBoot.defaultQuotaPercent(), 30, 'and it survives a restart')
  // Set on the instance the takeover below runs against, so that assertion
  // is about state this object actually holds.
  await reloaded.setDefaultQuotaPercent(30)

  // --claim-admin: the console is the root of trust, and the way back from
  // a lost admin device.
  await reloaded.reopen()
  assert.equal(reloaded.isUnclaimed(), true, '--claim-admin reopens claiming')
  assert.equal(await reloaded.claim('device-two'), true, 'and the next device can take it')
  assert.equal(reloaded.isAdmin('device-two'), true)
  assert.equal(
    reloaded.isAdmin('device-one'),
    false,
    'the previous administrator is replaced, not added to'
  )

  assert.equal(
    reloaded.openJoin(),
    true,
    'and survives the takeover — claiming changes the administrator, not their settings'
  )
  assert.equal(reloaded.defaultQuotaPercent(), 30, 'so does the default allocation')

  // Reopening is spent by the claim it permits, not left standing.
  assert.equal(reloaded.isUnclaimed(), false, 'reopening does not stay open')
  assert.equal(await reloaded.claim('device-three'), false, 'so a third device is still refused')

  await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  console.log('ok  admin claim and its bound')
}

// ---------------------------------------------------------------------
// The claim over HTTP, including the flag an app needs before it has any
// credential.
// ---------------------------------------------------------------------

async function claimRouteTest(): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-claimhttp-'))
  const store = createItemStore(root, {
    idleTtlMs: 60_000,
    hardMaxMs: 600_000,
    budgetBytes: 10 ** 9,
    tombstoneMs: 60_000
  })
  const pairing = createPairing(root)
  await pairing.load()
  const tokenA = await joinApproved(pairing, 'first device')
  const tokenB = await joinApproved(pairing, 'second device')
  assert.ok(tokenA && tokenB, 'two devices paired')

  const admin = createAdmin(root)
  await admin.load()
  const server = createDaemonServer({
    storage: store,
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
    serverName: 'test',
    version: '0.0.0',
    diskBudgetBytes: 10 ** 9
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  try {
    // `unclaimed` rides on the UNAUTHENTICATED ping on purpose: an app that
    // has just found this daemon over mDNS must decide whether to offer the
    // claim button before it holds any credential.
    const ping = (await (await fetch(`${base}/api/ping`)).json()) as { unclaimed?: boolean }
    assert.equal(ping.unclaimed, true, 'an unclaimed server advertises it on ping')

    // Claiming still needs a paired token — the claimer must be a real
    // device with an identity — but obviously cannot require admin.
    assert.equal(
      (await fetch(`${base}/api/admin/claim`, { method: 'POST' })).status,
      401,
      'claiming requires pairing'
    )

    const claimed = await fetch(`${base}/api/admin/claim`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` }
    })
    assert.equal(claimed.status, 200, 'the first paired device may claim')

    const second = await fetch(`${base}/api/admin/claim`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}` }
    })
    assert.equal(second.status, 409, 'a second device is refused')
    const body = (await second.json()) as { recovery?: string }
    assert.match(
      String(body.recovery),
      /--claim-admin/,
      'and is told how to recover, since only the console can reopen it'
    )

    const after = (await (await fetch(`${base}/api/ping`)).json()) as { unclaimed?: boolean }
    assert.equal(after.unclaimed, false, 'ping stops advertising once claimed')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
  console.log('ok  claim route')
}

// ---------------------------------------------------------------------
// Approval — a token is no longer the same thing as permission.
//
// Before this, "holds a token" and "may use the server" were one state,
// because the only way to get a token was to read a code off the console.
// Splitting them is what lets the code go away in A5: asking to join is
// something anyone on the LAN may do, and being let in is something only
// the administrator can grant.
//
// The subtle case is the DEVICES THAT WERE ALREADY HERE. They have no
// status field at all, and reading a missing field restrictively — the
// right default everywhere else in this feature — would log every working
// device out of a daemon its owner already runs.
// ---------------------------------------------------------------------

async function approvalTests(): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-approve-'))
  const pairing = createPairing(root)
  await pairing.load()

  // A device from before approval existed. It cannot be made through the
  // API any more — there is no code to present and every new device is
  // stamped — so it is written the way a real upgraded install has it: a
  // token in auth.json with no status field at all.
  const legacy = 'a'.repeat(64)
  await fsp.writeFile(
    path.join(root, 'auth.json'),
    JSON.stringify({ devices: [{ token: legacy, deviceName: 'the old laptop', createdAt: 1 }] })
  )
  await pairing.load()
  assert.equal(
    pairing.listDevices().find((d) => d.token === legacy)?.status,
    undefined,
    'the stored device has no status at all'
  )
  assert.equal(
    pairing.isAuthorized(legacy),
    true,
    'and it keeps working — absence means approved, or the upgrade logs everyone out'
  )

  // A device that asked to join.
  const pendingToken = await pairing.requestPairing('the new tablet')
  assert.ok(pendingToken, 'the request was accepted')
  const pendingId = deviceIdForToken(pendingToken)
  assert.equal(
    pairing.isAuthorized(pendingToken),
    false,
    'a pending device holds a real token and is authorised for nothing'
  )
  assert.equal(
    pairing.deviceIdFor(pendingToken),
    pendingId,
    'but it still has an identity, or it could not ask about itself'
  )
  assert.equal(pairing.findByToken(pendingToken)?.deviceName, 'the new tablet')

  assert.equal(await pairing.setStatus(pendingId, 'approved'), true)
  assert.equal(pairing.isAuthorized(pendingToken), true, 'approval turns the token on')
  assert.ok(
    (pairing.findByToken(pendingToken)?.approvedAt ?? 0) > 0,
    'and records when, so the admin list can say'
  )

  assert.equal(
    await pairing.setStatus('0'.repeat(16), 'approved'),
    false,
    'approving a device that is not here fails rather than inventing one'
  )

  // Quota is stored per device; null clears back to the server default
  // rather than storing a zero, which would read as "allowed nothing".
  assert.equal(await pairing.setQuota(pendingId, 5_000), true)
  assert.equal(pairing.findByToken(pendingToken)?.quotaBytes, 5_000)
  assert.equal(await pairing.setQuota(pendingId, null), true)
  assert.equal(
    pairing.findByToken(pendingToken)?.quotaBytes,
    undefined,
    'clearing a quota removes it, rather than setting it to nothing'
  )

  // All of it has to survive a restart, including the distinction between
  // "no status because it is old" and "no status because it is pending".
  const second = await pairing.requestPairing('still waiting')
  assert.ok(second, 'and so was the second')
  const reloaded = createPairing(root)
  await reloaded.load()
  assert.equal(reloaded.isAuthorized(legacy), true, 'the legacy device survives a restart')
  assert.equal(reloaded.isAuthorized(pendingToken), true, 'so does an approval')
  assert.equal(reloaded.isAuthorized(second), false, 'and so does a pending state')

  assert.equal(await reloaded.removeDevice(deviceIdForToken(second)), true)
  assert.equal(reloaded.findByToken(second), null, 'a removed device is gone')
  assert.equal(
    await reloaded.removeDevice(deviceIdForToken(second)),
    false,
    'and removing it again reports that there was nothing to remove'
  )

  await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  console.log('ok  device approval')
}

// ---------------------------------------------------------------------
// The same rules over HTTP, plus the bootstrap that has to work once the
// pairing code is gone: on an unclaimed server there is nobody to approve
// anyone, so joining must not require an approver who cannot exist yet.
// ---------------------------------------------------------------------

async function deviceRouteTests(): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-devices-'))
  const store = createItemStore(root, {
    idleTtlMs: 60_000,
    hardMaxMs: 600_000,
    budgetBytes: 10 ** 9,
    tombstoneMs: 60_000
  })
  const pairing = createPairing(root)
  await pairing.load()
  const admin = createAdmin(root)
  await admin.load()
  const credentials = createCredentials(root)
  const jobs = createJobStore(root)
  const server = createDaemonServer({
    storage: store,
    jobs,
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
    serverName: 'test',
    version: '0.0.0',
    diskBudgetBytes: 10 ** 9
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  const pair = async (deviceName: string): Promise<{ token: string; status: string }> =>
    (await (
      await fetch(`${base}/api/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceName })
      })
    ).json()) as { token: string; status: string }

  const statusFor = async (token: string): Promise<number> =>
    (await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${token}` } })).status

  const act = async (
    token: string,
    id: string,
    body: Record<string, unknown>
  ): Promise<Response> =>
    fetch(`${base}/api/admin/devices/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
    })

  try {
    // --- bootstrap ------------------------------------------------------
    // Nobody administers this box yet. Waiting for approval here would
    // deadlock the first install, and it would not buy anything: any device
    // on the LAN can currently take admin outright via /api/admin/claim,
    // which is strictly more than being let in as a user.
    const owner = await pair('the owner')
    assert.equal(owner.status, 'approved', 'the first device joins an unclaimed server')

    const claimed = await fetch(`${base}/api/admin/claim`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}` }
    })
    assert.equal(claimed.status, 200)

    // --- and now the window is shut --------------------------------------
    const guest = await pair('a guest')
    assert.equal(guest.status, 'pending', 'once claimed, joining waits for the administrator')
    assert.equal(await statusFor(guest.token), 401, 'and a pending token opens nothing')

    // The one thing a pending device may do.
    const asked = await fetch(`${base}/api/pair/status`, {
      headers: { Authorization: `Bearer ${guest.token}` }
    })
    assert.equal(asked.status, 200)
    assert.equal(((await asked.json()) as { status: string }).status, 'pending')
    assert.equal(
      (await fetch(`${base}/api/pair/status`, { headers: { Authorization: 'Bearer nope' } })).status,
      401,
      'a token this server never issued is told nothing'
    )

    // --- the admin list ---------------------------------------------------
    assert.equal(
      (
        await fetch(`${base}/api/admin/devices`, {
          headers: { Authorization: `Bearer ${guest.token}` }
        })
      ).status,
      401,
      'a pending device cannot read the device list'
    )

    const listed = await fetch(`${base}/api/admin/devices`, {
      headers: { Authorization: `Bearer ${owner.token}` }
    })
    assert.equal(listed.status, 200)
    const listBody = await listed.text()
    assert.equal(
      listBody.includes(guest.token) || listBody.includes(owner.token),
      false,
      'the device list never carries a credential — ids only'
    )
    const devices = (JSON.parse(listBody) as { devices: Array<Record<string, unknown>> }).devices
    assert.equal(devices.length, 2)
    const guestRow = devices.find((d) => d.deviceName === 'a guest')!
    const ownerRow = devices.find((d) => d.deviceName === 'the owner')!
    assert.equal(guestRow.status, 'pending')
    assert.equal(ownerRow.isAdmin, true)
    assert.equal(ownerRow.isYou, true)
    assert.equal(guestRow.isAdmin, false)

    // --- approve ----------------------------------------------------------
    assert.equal(
      (await act(guest.token, String(guestRow.id), { action: 'approve' })).status,
      401,
      'a pending device cannot approve itself'
    )
    assert.equal(
      await statusFor(guest.token),
      401,
      'and the refusal actually refused — it is still shut out'
    )

    assert.equal((await act(owner.token, String(guestRow.id), { action: 'approve' })).status, 200)
    assert.equal(await statusFor(guest.token), 200, 'an approved device may use the server')
    assert.equal(
      (
        await fetch(`${base}/api/admin/devices`, {
          headers: { Authorization: `Bearer ${guest.token}` }
        })
      ).status,
      403,
      'but approval is not administration'
    )
    assert.equal(
      (await act(guest.token, String(guestRow.id), { action: 'quota', quotaBytes: 10 ** 12 }))
        .status,
      403,
      'and an approved device cannot write itself a quota'
    )

    // --- the footgun ------------------------------------------------------
    assert.equal(
      (await act(owner.token, String(ownerRow.id), { action: 'revoke' })).status,
      409,
      'the admin cannot revoke their own device out of the building'
    )
    assert.equal(await statusFor(owner.token), 200, 'and the refusal left them working')

    // --- quota, and revoke ------------------------------------------------
    assert.equal(
      (await act(owner.token, String(guestRow.id), { action: 'quota', quotaBytes: 1234 })).status,
      200
    )
    assert.equal(
      pairing.listDevices().find((d) => deviceIdForToken(d.token) === guestRow.id)?.quotaBytes,
      1234
    )
    assert.equal(
      (await act(owner.token, '0'.repeat(16), { action: 'approve' })).status,
      404,
      'acting on a device that is not here is a 404, not a silent success'
    )
    assert.equal((await act(owner.token, String(guestRow.id), { action: 'nonsense' })).status, 400)

    // The guest shared a TorBox token. Revoking has to take that back too:
    // the credential outlives the access it was given for otherwise, and the
    // device that shared it can no longer authenticate to clear it.
    await credentials.setTokenForDevice(String(guestRow.id), 'guest-torbox-token')
    assert.equal(credentials.linkedDeviceCount(), 1)

    // And the work being done on its behalf. Clearing the credential alone
    // does not stop a fetch that already copied the token, and leaves queued
    // jobs parked on 'waiting for TorBox access' forever.
    jobs.enqueue({
      contentKey: 'tt-guest-queued::',
      infoHash: '1'.repeat(40),
      title: 'Guest Queued',
      ownerDeviceId: String(guestRow.id)
    })
    jobs.enqueue({
      contentKey: 'tt-guest-fetching::',
      infoHash: '2'.repeat(40),
      title: 'Guest Fetching',
      ownerDeviceId: String(guestRow.id)
    })
    jobs.update('tt-guest-fetching::', { state: 'fetching' })
    jobs.enqueue({
      contentKey: 'tt-owner::',
      infoHash: '3'.repeat(40),
      title: 'Owner Job',
      ownerDeviceId: String(ownerRow.id)
    })

    assert.equal((await act(owner.token, String(guestRow.id), { action: 'revoke' })).status, 200)
    assert.equal(
      credentials.tokenForDevice(String(guestRow.id)),
      '',
      'revoking a device takes back the credential it shared'
    )
    assert.equal(credentials.linkedDeviceCount(), 0, 'and stops counting it as linked')
    assert.equal(
      jobs.list().some((job) => job.contentKey === 'tt-guest-queued::'),
      false,
      'a revoked device leaves no queued job behind to retry forever'
    )
    assert.equal(
      jobs.list().find((job) => job.contentKey === 'tt-guest-fetching::')?.state,
      'expired',
      'and an in-flight fetch is marked so the download loop aborts it'
    )
    assert.equal(
      jobs.list().find((job) => job.contentKey === 'tt-owner::')?.state,
      'queued',
      "and nobody else's work is touched"
    )
    assert.equal(await statusFor(guest.token), 401, 'a revoked device is out immediately')

    // --- "anyone on this network may join" --------------------------------
    const setOpen = await fetch(`${base}/api/admin/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ openJoin: true })
    })
    assert.equal(setOpen.status, 200)
    assert.equal(((await setOpen.json()) as { openJoin: boolean }).openJoin, true)

    // The admin sets a share; the daemon says what that comes to on THIS
    // disk, so the choice is made against a real figure rather than a ratio.
    const quotaSet = await fetch(`${base}/api/admin/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ defaultQuotaPercent: 20 })
    })
    assert.equal(
      ((await quotaSet.json()) as { defaultQuotaPercent: number }).defaultQuotaPercent,
      20
    )
    const withDefault = (await (
      await fetch(`${base}/api/admin/devices`, {
        headers: { Authorization: `Bearer ${owner.token}` }
      })
    ).json()) as { defaultQuotaBytes: number; diskBudgetBytes: number }
    assert.equal(withDefault.defaultQuotaBytes, Math.floor(withDefault.diskBudgetBytes / 5))

    const walkIn = await pair('a walk-in')
    assert.equal(walkIn.status, 'approved', 'with the switch on, joining does not wait')

    // Off again, and the door shuts on the next arrival — not retroactively
    // on the ones already let in.
    await fetch(`${base}/api/admin/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ openJoin: false })
    })
    assert.equal((await pair('too late')).status, 'pending')

    // A refused request must come back as a refusal, not as a 200 with no
    // token in it — the app stores what it is handed, and a null token
    // written to disk is a connection that can never work and never
    // explains itself. Whether the rate limit or the queue cap fires first
    // is not the point; that the route surfaces EITHER as a 429 is.
    let refused = 0
    for (let i = 0; i < 12; i++) {
      const response = await fetch(`${base}/api/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceName: `crowd-${i}` })
      })
      if (response.status === 429) refused++
      else {
        const body = (await response.json()) as { token?: string }
        assert.ok(body.token, 'an accepted request always carries a token')
      }
    }
    assert.ok(refused > 0, 'the daemon eventually says no, and says it with a 429')
    assert.equal(
      await statusFor(walkIn.token),
      200,
      'closing the switch does not evict whoever came through it'
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
  console.log('ok  device routes')
}

// ---------------------------------------------------------------------
// Allocation on real files, and the one thing quota eviction must NOT do.
//
// A tombstone means "nobody wanted this" and suppresses a refetch. Age and
// idleness are evidence of that; running out of room is not. An item taken
// for space is one somebody DID want, so tombstoning it would stop the
// cache refetching it the moment room appeared.
// ---------------------------------------------------------------------

async function quotaStoreTest(): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-quota-'))
  const store = createItemStore(root, {
    idleTtlMs: 60 * DAY,
    hardMaxMs: 365 * DAY,
    budgetBytes: 10 ** 9,
    tombstoneMs: 60 * DAY
  })

  const now = Date.now()
  const seed = async (hash: string, key: string, owner: string, age: number): Promise<void> => {
    const dir = await store.beginItem({
      contentKey: key,
      title: key,
      infoHash: hash,
      fileName: 'f.mkv',
      sizeBytes: 4,
      fetchedAt: now - age,
      lastAccessAt: now - age,
      ownerDeviceId: owner,
      visibility: 'private',
      entitled: [owner]
    })
    await fsp.writeFile(path.join(dir, 'f.mkv'), 'ABCD')
  }

  await seed('a'.repeat(40), 'k-a', 'alice', 3 * DAY)
  await seed('b'.repeat(40), 'k-b', 'alice', 1 * DAY)
  await seed('c'.repeat(40), 'k-c', 'bob', 5 * DAY)

  // No quotas: nothing happens. The default state of every install.
  assert.equal((await store.runEviction(now)).size, 0, 'no allocation, no eviction')
  assert.ok(await store.get('a'.repeat(40)))

  // Alice holds 8 bytes against 4 allowed; bob holds 4 against 8.
  const plan = await store.runEviction(
    now,
    null,
    new Map([
      ['alice', 4],
      ['bob', 8]
    ])
  )
  assert.equal(plan.get('a'.repeat(40)), 'quota', "alice's oldest is taken")
  assert.equal(plan.size, 1, 'and nothing else is')
  assert.equal(await store.get('a'.repeat(40)), null, 'the file is really gone')
  assert.ok(await store.get('b'.repeat(40)), 'her newer one stays')
  assert.ok(
    await store.get('c'.repeat(40)),
    "bob's older file stays — it is not his overspend"
  )

  const stones = await store.tombstones()
  assert.equal(
    'k-a' in stones,
    false,
    'a quota eviction leaves no tombstone: somebody wanted this, there was no room'
  )

  await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  console.log('ok  allocation on disk')
}

// ---------------------------------------------------------------------
// What the app is told, and what it is deliberately not told.
//
// /api/status is the "what is this server doing" view every paired device
// polls. It grew the figures a control centre needs — the caller's own
// usage against its own allocation, and whether the caller administers
// the box — and lost something at the same time: the queue used to hand
// every paired device the TITLES of everything the household was
// fetching, which is the read-side hole entitlement closed on the
// catalog, just on the queue instead of the disk.
// ---------------------------------------------------------------------

async function statusScopeTest(): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-status-'))
  const store = createItemStore(root, {
    idleTtlMs: 60_000,
    hardMaxMs: 600_000,
    budgetBytes: 10 ** 9,
    tombstoneMs: 60_000
  })
  const pairing = createPairing(root)
  await pairing.load()
  const admin = createAdmin(root)
  await admin.load()
  const jobs = createJobStore(root)

  const ownerToken = (await joinApproved(pairing, 'the owner'))!
  const guestToken = (await joinApproved(pairing, 'a guest'))!
  const ownerId = deviceIdForToken(ownerToken)
  const guestId = deviceIdForToken(guestToken)
  await admin.claim(ownerId)

  const seed = async (hash: string, key: string, owner: string, bytes: string): Promise<void> => {
    const dir = await store.beginItem({
      contentKey: key,
      title: key,
      infoHash: hash,
      fileName: 'f.mkv',
      sizeBytes: bytes.length,
      fetchedAt: Date.now(),
      lastAccessAt: Date.now(),
      ownerDeviceId: owner,
      visibility: 'private',
      entitled: [owner]
    })
    await fsp.writeFile(path.join(dir, 'f.mkv'), bytes)
  }
  await seed('a'.repeat(40), 'k-a', ownerId, 'ABCDEFGH')
  await seed('b'.repeat(40), 'k-b', guestId, 'XY')

  jobs.enqueue({ contentKey: 'k-mine', infoHash: 'c'.repeat(40), title: 'Owner Fetch', ownerDeviceId: ownerId })
  jobs.enqueue({ contentKey: 'k-theirs', infoHash: 'd'.repeat(40), title: 'Guest Fetch', ownerDeviceId: guestId })

  const server = createDaemonServer({
    storage: store,
    jobs,
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
    serverName: 'test',
    version: '0.0.0',
    diskBudgetBytes: 1000
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  const statusAs = async (token: string): Promise<Record<string, unknown>> =>
    (await (
      await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${token}` } })
    ).json()) as Record<string, unknown>

  try {
    const ownerStatus = await statusAs(ownerToken)
    const guestStatus = await statusAs(guestToken)

    assert.equal(ownerStatus.isAdmin, true, 'the claiming device is told it administers the box')
    assert.equal(guestStatus.isAdmin, false, 'and nobody else is')
    assert.equal(ownerStatus.unclaimed, false)

    // Charged to the fetcher, once — the same rule the eviction planner
    // applies, or the figure shown is not the figure enforced.
    assert.equal(ownerStatus.usedByMeBytes, 8)
    assert.equal(guestStatus.usedByMeBytes, 2)
    assert.equal(ownerStatus.itemCount, 2, 'the whole-server totals stay whole-server')
    assert.equal(ownerStatus.usedBytes, 10)

    // Scoped queue: your own work in full, everyone else's as a number.
    assert.deepEqual(
      (ownerStatus.jobs as Array<{ title: string }>).map((job) => job.title),
      ['Owner Fetch']
    )
    assert.equal(ownerStatus.othersJobCount, 1, 'and enough to explain why the server is busy')
    assert.equal(
      JSON.stringify(ownerStatus).includes('Guest Fetch'),
      false,
      "the administrator is not shown another device's titles either"
    )
    assert.equal(
      JSON.stringify(guestStatus).includes('Owner Fetch'),
      false,
      'and the leak is closed in both directions'
    )

    // Allocation: none set, so the whole-disk budget is the only bound.
    assert.equal(ownerStatus.quotaBytes, null, 'no allocation is set on a fresh server')
    await admin.setDefaultQuotaPercent(20)
    assert.equal((await statusAs(guestToken)).quotaBytes, 200, 'a default reaches every device')
    await pairing.setQuota(guestId, 350)
    assert.equal(
      (await statusAs(guestToken)).quotaBytes,
      350,
      "and the device's own allocation wins over the default"
    )
    assert.equal((await statusAs(ownerToken)).quotaBytes, 200, 'without disturbing anyone else')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
  console.log('ok  status is scoped to the caller')
}

// ---------------------------------------------------------------------
// Sharing — the owner deciding who else may reach what they fetched.
// ---------------------------------------------------------------------

async function sharingRouteTest(): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-sharing-'))
  const store = createItemStore(root, {
    idleTtlMs: 60_000,
    hardMaxMs: 600_000,
    budgetBytes: 10 ** 9,
    tombstoneMs: 60_000
  })
  const pairing = createPairing(root)
  await pairing.load()
  const admin = createAdmin(root)
  await admin.load()

  const adminToken = (await joinApproved(pairing, 'admin device'))!
  const ownerToken = (await joinApproved(pairing, 'owner device'))!
  const strangerToken = (await joinApproved(pairing, 'stranger'))!
  const ownerId = deviceIdForToken(ownerToken)
  const strangerId = deviceIdForToken(strangerToken)
  await admin.claim(deviceIdForToken(adminToken))

  const hash = 'a'.repeat(40)
  const dir = await store.beginItem({
    contentKey: 'k-a',
    title: 'Something Private',
    infoHash: hash,
    fileName: 'f.mkv',
    sizeBytes: 4,
    fetchedAt: Date.now(),
    lastAccessAt: Date.now(),
    ownerDeviceId: ownerId,
    visibility: 'private',
    entitled: [ownerId]
  })
  await fsp.writeFile(path.join(dir, 'f.mkv'), 'ABCD')

  const server = createDaemonServer({
    storage: store,
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
    serverName: 'test',
    version: '0.0.0',
    diskBudgetBytes: 10 ** 9
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  const share = async (token: string, target: string, body: unknown): Promise<Response> =>
    fetch(`${base}/api/items/${target}/sharing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
    })

  try {
    // A device with no claim on the item cannot tell it apart from one that
    // is not here — the same property the stream route carries, for the
    // same reason: infohashes are public and a differing answer enumerates
    // the disk.
    const forbidden = await share(strangerToken, hash, { visibility: 'shared' })
    const missing = await share(strangerToken, 'f'.repeat(40), { visibility: 'shared' })
    assert.equal(forbidden.status, missing.status)
    assert.equal(await forbidden.text(), await missing.text())
    assert.equal(
      (await store.get(hash))!.visibility,
      'private',
      'and the refusal actually refused'
    )

    // The owner opens it up.
    const opened = await share(ownerToken, hash, { visibility: 'shared' })
    assert.equal(opened.status, 200)
    assert.equal((await store.get(hash))!.visibility, 'shared')
    assert.equal(
      (await fetch(`${base}/stream/${hash}?token=${strangerToken}`)).status,
      200,
      'and the stranger can now stream it'
    )

    // Back to private, entitling one named device.
    const scoped = await share(ownerToken, hash, {
      visibility: 'private',
      entitled: [strangerId]
    })
    assert.equal(scoped.status, 200)
    const after = (await scoped.json()) as { entitled: string[] }
    assert.ok(
      after.entitled.includes(ownerId),
      'the owner stays entitled — dropping yourself leaves a file you pay for and cannot reach'
    )
    assert.ok(after.entitled.includes(strangerId))

    // Omitting `entitled` means 'leave it alone', not 'clear it'. A request
    // that only flips visibility must not silently revoke everyone who was
    // already let in.
    const visibilityOnly = (await (
      await share(ownerToken, hash, { visibility: 'private' })
    ).json()) as { entitled: string[] }
    assert.ok(
      visibilityOnly.entitled.includes(strangerId),
      'an omitted entitled list is preserved, not emptied'
    )

    // Garbage in the entitled list is dropped rather than stored.
    const cleaned = (await (
      await share(ownerToken, hash, { visibility: 'private', entitled: ['../etc', 'ZZZ', strangerId] })
    ).json()) as { entitled: string[] }
    assert.deepEqual(cleaned.entitled.filter((id) => !/^[a-f0-9]{16}$/.test(id)), [])

    // The admin may change sharing — they can already delete the file — but
    // this route changes access, it does not grant it. Admin cannot add
    // themselves through it, because the entitled list they send is the one
    // that is stored, and it is the OWNER who is preserved, not the caller.
    const byAdmin = await share(adminToken, hash, { visibility: 'private', entitled: [] })
    assert.equal(byAdmin.status, 200)
    const adminResult = (await byAdmin.json()) as { entitled: string[] }
    assert.deepEqual(adminResult.entitled, [ownerId], 'only the owner is preserved')
    assert.equal(
      (await fetch(`${base}/stream/${hash}?token=${adminToken}`)).status,
      404,
      'so the administrator still cannot stream it'
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
  console.log('ok  sharing')
}

void main()
  .then(() => {
    console.log('ok  r3-cache daemon core')
  })
  .then(entitlementTests)
  .then(indistinguishabilityTest)
  .then(claimTests)
  .then(claimRouteTest)
  .then(approvalTests)
  .then(deviceRouteTests)
  .then(quotaStoreTest)
  .then(statusScopeTest)
  .then(sharingRouteTest)
