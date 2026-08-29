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
import type { JobRecord } from '../jobs'
import { shouldRetryAfterFailure } from '../fetcher'
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
    'bob keeps the oldest file on the disk — it is not his overspend'
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
      [
        orphan,
        item({ infoHash: 'b'.repeat(40), presentBytes: 900, fetchedAt: now, lastAccessAt: 2 * DAY })
      ],
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

      // The queue's reason survives the wire, and only the two real values
      // do. It is rendered as a label on the caching page, so an arbitrary
      // string reaching the record would be a caller writing UI text.
      const queueWith = async (key: string, reason: unknown): Promise<string | undefined> => {
        await fetch(`${base}/api/jobs`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ contentKey: key, infoHash: 'e'.repeat(40), title: 'T', reason })
        })
        return jobs.list().find((job) => job.contentKey === key)?.reason
      }
      assert.equal(await queueWith('r-1', 'watching'), 'watching')
      assert.equal(await queueWith('r-2', 'prefetch'), 'prefetch')
      for (const rubbish of ['WATCHING', 'seeding', '', 1, true, null, {}]) {
        assert.equal(
          await queueWith(`r-junk-${JSON.stringify(rubbish)}`, rubbish),
          undefined,
          `an unknown reason is dropped, not stored: ${JSON.stringify(rubbish)}`
        )
      }

      // A prefetch somebody has since started watching is upgraded, and the
      // reverse is not: a watch is not demoted by a later watchlist add.
      await queueWith('r-2', 'watching')
      assert.equal(jobs.list().find((job) => job.contentKey === 'r-2')?.reason, 'watching')
      await queueWith('r-2', 'prefetch')
      assert.equal(
        jobs.list().find((job) => job.contentKey === 'r-2')?.reason,
        'watching',
        'a queued watch stays a watch'
      )

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

  const act = async (token: string, id: string, body: Record<string, unknown>): Promise<Response> =>
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
      (await fetch(`${base}/api/pair/status`, { headers: { Authorization: 'Bearer nope' } }))
        .status,
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
  assert.ok(await store.get('c'.repeat(40)), "bob's older file stays — it is not his overspend")

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

  jobs.enqueue({
    contentKey: 'k-mine',
    infoHash: 'c'.repeat(40),
    title: 'Owner Fetch',
    ownerDeviceId: ownerId
  })
  jobs.enqueue({
    contentKey: 'k-theirs',
    infoHash: 'd'.repeat(40),
    title: 'Guest Fetch',
    ownerDeviceId: guestId
  })

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

    // Scoped queue, with ONE exception, and it is deliberate.
    //
    // The rule everywhere else in this feature is that admin is not a master
    // key: the administrator decides who may join and how much room they
    // get, and is not thereby entitled to their library. The queue is the
    // one place that is relaxed, because somebody running the box has to be
    // able to answer "why is this thing saturated" and "who is filling the
    // disk", and a list of anonymous rows answers neither. It is the work
    // the hardware is doing, attributed to the device that asked for it —
    // not a record of what anyone has watched. Every other read stays shut:
    // the catalogue, the streams and the items are all still owner-only.
    assert.deepEqual(
      (ownerStatus.jobs as Array<{ title: string; ownerName?: string }>).map(
        (job) => `${job.title}/${job.ownerName}`
      ),
      ['Owner Fetch/the owner', 'Guest Fetch/a guest'],
      'the administrator sees the whole queue, each row attributed to a device'
    )
    assert.equal(
      ownerStatus.othersJobCount,
      0,
      'and nothing is withheld from them, so nothing is reported as withheld'
    )
    // A member is unchanged: their own work in full, everyone else's as a
    // number, and no titles.
    assert.deepEqual(
      (guestStatus.jobs as Array<{ title: string }>).map((job) => job.title),
      ['Guest Fetch']
    )
    assert.equal(guestStatus.othersJobCount, 1, 'and enough to explain why the server is busy')
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
    assert.equal((await store.get(hash))!.visibility, 'private', 'and the refusal actually refused')

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
      await share(ownerToken, hash, {
        visibility: 'private',
        entitled: ['../etc', 'ZZZ', strangerId]
      })
    ).json()) as { entitled: string[] }
    assert.deepEqual(
      cleaned.entitled.filter((id) => !/^[a-f0-9]{16}$/.test(id)),
      []
    )

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

// ---------------------------------------------------------------------
// The budget as a limit rather than a target.
//
// Eviction reclaims space AFTER it has been taken, so on its own the cache
// sits over its cap between passes — observed on the live server at 24.8 GB
// of a 22.6 GB budget. Room is made before a fetch starts instead.
// ---------------------------------------------------------------------

async function budgetRoomTest(): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-room-'))
  const store = createItemStore(root, {
    idleTtlMs: 60 * DAY,
    hardMaxMs: 365 * DAY,
    budgetBytes: 1000,
    tombstoneMs: 60 * DAY
  })

  const now = Date.now()
  const seed = async (hash: string, key: string, bytes: number, age: number): Promise<void> => {
    const dir = await store.beginItem({
      contentKey: key,
      title: key,
      infoHash: hash,
      fileName: 'f.mkv',
      sizeBytes: bytes,
      fetchedAt: now - age,
      lastAccessAt: now - age
    })
    await fsp.writeFile(path.join(dir, 'f.mkv'), 'x'.repeat(bytes))
  }

  await seed('a'.repeat(40), 'k-a', 400, 3 * DAY)
  await seed('b'.repeat(40), 'k-b', 400, 1 * DAY)
  assert.equal(await store.usedBytes(), 800)

  // Fits without touching anything.
  assert.equal(await store.makeRoomFor(200), true)
  assert.equal(await store.usedBytes(), 800, 'nothing is evicted when it already fits')

  // Does not fit: the oldest-accessed item goes, and only that one.
  assert.equal(await store.makeRoomFor(500), true)
  assert.equal(await store.get('a'.repeat(40)), null, 'the least recently used item is taken')
  assert.ok(await store.get('b'.repeat(40)), 'and the newer one is kept')
  assert.ok((await store.usedBytes()) + 500 <= 1000, 'room really was made')

  // Bigger than the whole budget: refused, and refused WITHOUT emptying the
  // cache on the way to failing.
  const before = await store.usedBytes()
  assert.equal(await store.makeRoomFor(5000), false)
  assert.equal(await store.usedBytes(), before, 'a hopeless request evicts nothing')

  // Pressure, not disinterest — so no tombstones, or the feeder would stop
  // asking for exactly what it just displaced.
  assert.deepEqual(await store.tombstones(), {}, 'making room leaves no tombstone')

  // --- resuming a partial ---------------------------------------------
  //
  // A retried fetch is already partly on disk, and those bytes are already
  // counted. Charging the full size again evicts for space that was never
  // free — and since a partial is the least-recently-accessed thing in the
  // cache almost by definition (nobody has watched it, it is not finished),
  // plain LRU deletes the very partial the room was being made for. On a
  // slow link that restarts a multi-gigabyte download on every attempt.
  const resumeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-resume-'))
  const resumeStore = createItemStore(resumeRoot, {
    idleTtlMs: 60 * DAY,
    hardMaxMs: 365 * DAY,
    budgetBytes: 1000,
    tombstoneMs: 60 * DAY
  })
  const partialHash = 'c'.repeat(40)
  const neighbourHash = 'd'.repeat(40)
  // The partial: 600 of an eventual 700, and the OLDEST thing here.
  const partialDir = await resumeStore.beginItem({
    contentKey: 'k-partial',
    title: 'k-partial',
    infoHash: partialHash,
    fileName: 'f.mkv',
    sizeBytes: 700,
    fetchedAt: now - 5 * DAY,
    lastAccessAt: now - 5 * DAY
  })
  await fsp.writeFile(path.join(partialDir, 'f.mkv'), 'x'.repeat(600))
  const neighbourDir = await resumeStore.beginItem({
    contentKey: 'k-neighbour',
    title: 'k-neighbour',
    infoHash: neighbourHash,
    fileName: 'f.mkv',
    sizeBytes: 300,
    fetchedAt: now,
    lastAccessAt: now
  })
  await fsp.writeFile(path.join(neighbourDir, 'f.mkv'), 'x'.repeat(300))
  assert.equal(await resumeStore.usedBytes(), 900)

  // 700 total, 600 already held: only 100 is new, and 900 + 100 fits 1000.
  // Nothing needs to go.
  assert.equal(await resumeStore.makeRoomFor(700, partialHash), true)
  assert.ok(
    await resumeStore.get(partialHash),
    'the partial being resumed is not evicted to make room for itself'
  )
  assert.ok(
    await resumeStore.get(neighbourHash),
    'and nothing else is taken for bytes already held'
  )
  assert.equal(await resumeStore.usedBytes(), 900)

  // And when room genuinely IS needed, it comes from somewhere else. 900
  // total against 600 held is 300 new, which does not fit alongside the
  // neighbour — so something has to go, and the oldest thing here is the
  // partial itself. This is the case plain LRU gets wrong.
  assert.equal(await resumeStore.makeRoomFor(900, partialHash), true)
  assert.ok(
    await resumeStore.get(partialHash),
    'the partial survives an eviction pass it triggered, though it is the oldest'
  )
  assert.equal(
    await resumeStore.get(neighbourHash),
    null,
    'the room comes from the next-oldest item instead'
  )

  // Without the hash it is a fresh 700 on top of 900 — which really does
  // need room, and the partial is then fair game like anything else.
  assert.equal(await resumeStore.makeRoomFor(700), true)
  assert.equal(await resumeStore.get(partialHash), null, 'an unrelated fetch still evicts by age')

  // A resume of something bigger than the whole budget is still refused:
  // the ceiling is the file's full size, not what is left of it.
  assert.equal(
    await resumeStore.makeRoomFor(5000, partialHash),
    false,
    'a resume does not get past the budget ceiling'
  )

  await fsp.rm(resumeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })

  await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  // --- a cancel is not a network failure -------------------------------
  //
  // jobs.cancel marks a fetching job 'expired'; the read loop notices,
  // keeps the partial and breaks, and the short file then raises the
  // incomplete-download error. That arrives in the fetcher's catch looking
  // exactly like a dropped connection, where the record used to be put
  // straight back to 'queued' — so Cancel reported success and the
  // download resumed after the backoff, still spending the owner's TorBox
  // quota. Only a record still in the state this pass was working on is
  // retried.
  assert.equal(shouldRetryAfterFailure({ state: 'fetching' } as JobRecord), true)
  assert.equal(
    shouldRetryAfterFailure({ state: 'expired' } as JobRecord),
    false,
    'a cancelled fetch stays cancelled'
  )
  assert.equal(
    shouldRetryAfterFailure(undefined),
    false,
    'and a job removed outright is not resurrected'
  )
  assert.equal(shouldRetryAfterFailure({ state: 'ready' } as JobRecord), false)

  // --- what is being watched is not evicted ----------------------------
  //
  // The stream route opens a NEW file handle per Range request, so deleting
  // an item with a reader on it does not merely inconvenience it: on Unix
  // the request in flight finishes against the unlinked file and the next
  // seek gets a 404 in the middle of the film, and on Windows the delete
  // fails against the open handle and the pass churns against it. Both
  // eviction paths therefore skip it.
  const watchRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-watch-'))
  const streaming = new Set<string>()
  const watchStore = createItemStore(
    watchRoot,
    { idleTtlMs: 60 * DAY, hardMaxMs: 365 * DAY, budgetBytes: 1000, tombstoneMs: 60 * DAY },
    { isStreaming: (infoHash) => streaming.has(infoHash) }
  )
  const watchedHash = 'e'.repeat(40)
  const idleHash = 'f'.repeat(40)
  const seedInto = async (hash: string, key: string, bytes: number, age: number): Promise<void> => {
    const dir = await watchStore.beginItem({
      contentKey: key,
      title: key,
      infoHash: hash,
      fileName: 'f.mkv',
      sizeBytes: bytes,
      fetchedAt: now - age,
      lastAccessAt: now - age
    })
    await fsp.writeFile(path.join(dir, 'f.mkv'), 'x'.repeat(bytes))
  }
  // The one being watched is also the oldest, so LRU would take it first.
  await seedInto(watchedHash, 'k-watched', 500, 9 * DAY)
  await seedInto(idleHash, 'k-idle', 400, 1 * DAY)
  streaming.add(watchedHash)

  assert.equal(await watchStore.makeRoomFor(400), true)
  assert.ok(
    await watchStore.get(watchedHash),
    'making room does not delete the film somebody is watching'
  )
  assert.equal(await watchStore.get(idleHash), null, 'it takes the next-oldest instead')

  // The hourly pass has the same duty. Aged past the hard maximum, the one
  // with a reader on it still stays.
  await seedInto('a1'.repeat(20), 'k-old', 100, 400 * DAY)
  streaming.add('a1'.repeat(20))
  const plan = await watchStore.runEviction(now)
  assert.equal(
    plan.has('a1'.repeat(20)),
    false,
    'and the hourly pass leaves an open stream alone too'
  )
  assert.ok(await watchStore.get('a1'.repeat(20)), 'the file is still there')
  // Released, it goes on the next pass — deferred, not exempt.
  streaming.delete('a1'.repeat(20))
  assert.equal(
    (await watchStore.runEviction(now)).has('a1'.repeat(20)),
    true,
    'once nobody is watching it, it is evicted as normal'
  )

  await fsp.rm(watchRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })

  console.log('ok  budget room')
}

// ---------------------------------------------------------------------
// Your own items, and only your own.
//
// This is the listing entitlement allows, and the one the sharing controls
// need to exist at all. The unfiltered catalog was deleted for handing every
// paired device the whole disk with titles; this must not quietly bring it
// back by a different name.
// ---------------------------------------------------------------------

async function myItemsTest(): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-mine-'))
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
  const mineToken = await joinApproved(pairing, 'my device')
  const otherToken = await joinApproved(pairing, 'their device')
  const mineId = deviceIdForToken(mineToken)
  const otherId = deviceIdForToken(otherToken)

  const seed = async (hash: string, key: string, owner: string | undefined): Promise<void> => {
    const dir = await store.beginItem({
      contentKey: key,
      title: key,
      infoHash: hash,
      fileName: 'f.mkv',
      sizeBytes: 4,
      fetchedAt: Date.now(),
      lastAccessAt: Date.now(),
      ...(owner ? { ownerDeviceId: owner, visibility: 'private', entitled: [owner] } : {})
    })
    await fsp.writeFile(path.join(dir, 'f.mkv'), 'ABCD')
  }
  await seed('a'.repeat(40), 'k-mine-1', mineId)
  await seed('b'.repeat(40), 'k-mine-2', mineId)
  await seed('c'.repeat(40), 'k-theirs', otherId)
  await seed('d'.repeat(40), 'k-orphan', undefined)

  const jobs = createJobStore(root)
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
    diskBudgetBytes: 10 ** 9
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  const mineFor = async (token: string): Promise<Array<Record<string, unknown>>> =>
    (
      (await (
        await fetch(`${base}/api/items/mine`, { headers: { Authorization: `Bearer ${token}` } })
      ).json()) as { items: Array<Record<string, unknown>> }
    ).items

  try {
    const mine = await mineFor(mineToken)
    assert.deepEqual(
      mine.map((i) => i.contentKey).sort(),
      ['k-mine-1', 'k-mine-2'],
      'only the items this device paid for'
    )
    const theirs = await mineFor(otherToken)
    assert.deepEqual(
      theirs.map((i) => i.contentKey),
      ['k-theirs']
    )

    // The two ways this could quietly become the deleted catalog again.
    const body = JSON.stringify(mine)
    assert.equal(body.includes('k-theirs'), false, "another device's title never appears")
    assert.equal(
      body.includes('k-orphan'),
      false,
      'and neither does an item with no identifiable owner'
    )

    // Sharing state comes back so the control can render, but the entitled
    // list is a COUNT — naming ids would describe households the caller is
    // not part of.
    assert.equal(mine[0].visibility, 'private')
    assert.equal(mine[0].sharedWith, 0)

    // REMOVAL. Yours goes; somebody else's is indistinguishable from absent.
    const removeAs = async (token: string, hash: string): Promise<number> =>
      (
        await fetch(`${base}/api/items/${hash}/remove`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` }
        })
      ).status
    assert.equal(
      await removeAs(otherToken, 'a'.repeat(40)),
      404,
      'another device cannot delete an item it does not own'
    )
    assert.ok(await store.get('a'.repeat(40)), 'and the refusal actually refused')
    assert.equal(
      await removeAs(otherToken, 'f'.repeat(40)),
      404,
      'with the same answer as a hash that is not here'
    )
    assert.equal(await removeAs(mineToken, 'b'.repeat(40)), 200, 'the owner may delete their own')
    assert.equal(await store.get('b'.repeat(40)), null, 'and the file is gone')
    assert.equal(
      'k-mine-2' in (await store.tombstones()),
      false,
      'a deliberate delete leaves no tombstone — it is not lost interest'
    )

    // CANCELLING A QUEUED FETCH, scoped the same way. The queue is per
    // device everywhere else, so a route that cancelled by contentKey alone
    // would let anyone stop a housemate's download without being able to
    // see it — and the admin gets no exception, because revoking a device
    // is the administrative lever over its work, not reaching in item by
    // item.
    jobs.enqueue({
      contentKey: 'tt-mine::1:2',
      infoHash: '1'.repeat(40),
      title: 'Mine',
      ownerDeviceId: mineId
    })
    jobs.enqueue({
      contentKey: 'tt-theirs::1:2',
      infoHash: '2'.repeat(40),
      title: 'Theirs',
      ownerDeviceId: otherId
    })
    const cancelAs = async (token: string, contentKey: string): Promise<number> =>
      (
        await fetch(`${base}/api/jobs/cancel`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ contentKey })
        })
      ).status
    assert.equal(
      await cancelAs(mineToken, 'tt-theirs::1:2'),
      404,
      "one device cannot cancel another's fetch"
    )
    assert.ok(
      jobs.list().some((job) => job.contentKey === 'tt-theirs::1:2'),
      'and the refusal actually refused'
    )
    assert.equal(await cancelAs(mineToken, 'tt-mine::1:2'), 200, 'the owner may cancel their own')
    assert.equal(
      jobs.list().some((job) => job.contentKey === 'tt-mine::1:2'),
      false,
      'and it leaves the queue'
    )

    // NOTHING TO CANCEL IS NOT A SUCCESS. A ready record stays listed for
    // an hour and a stopped one for a day; jobs.cancel touches neither, and
    // the route used to report 200 regardless, so the button did nothing
    // and said it had worked.
    jobs.enqueue({
      contentKey: 'k-finished',
      infoHash: '9'.repeat(40),
      title: 'Finished',
      ownerDeviceId: mineId
    })
    jobs.update('k-finished', { state: 'ready' })
    assert.equal(
      await cancelAs(mineToken, 'k-finished'),
      409,
      'a fetch that has already finished cannot be cancelled, and says so'
    )
    assert.equal(
      jobs.list().find((job) => job.contentKey === 'k-finished')?.state,
      'ready',
      'and the record is untouched'
    )

    // THE ADMINISTRATOR MAY STOP WORK, matching the remove route and
    // following from the queue being visible to them at all: they are shown
    // it to answer "why is this box saturated", and a view with no way to
    // act on it does not answer that. It stays narrow — stopping a fetch is
    // not reading what anyone has watched.
    jobs.enqueue({
      contentKey: 'tt-theirs::3:4',
      infoHash: '7'.repeat(40),
      title: 'Theirs Again',
      ownerDeviceId: otherId
    })
    await admin.claim(mineId)
    assert.equal(
      await cancelAs(mineToken, 'tt-theirs::3:4'),
      200,
      "the administrator may cancel another device's fetch"
    )
    assert.equal(
      jobs.list().some((job) => job.contentKey === 'tt-theirs::3:4'),
      false,
      'and it really leaves the queue'
    )

    // REMOVING A PARTIAL STOPS ITS FETCH FIRST. An incomplete item is
    // listed and removable while its job is still downloading into the very
    // directory about to be deleted: on Unix the write continues into an
    // unlinked file and the job is re-queued when its final stat fails, and
    // on Windows the recursive delete fails against the open handle. Either
    // way the title comes back.
    await seed('8'.repeat(40), 'k-partial', mineId)
    jobs.enqueue({
      contentKey: 'k-partial',
      infoHash: '8'.repeat(40),
      title: 'Still Fetching',
      ownerDeviceId: mineId
    })
    assert.equal(
      (
        await fetch(`${base}/api/items/${'8'.repeat(40)}/remove`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${mineToken}` }
        })
      ).status,
      200
    )
    assert.equal(
      jobs.list().some((job) => job.contentKey === 'k-partial'),
      false,
      'the fetch is cancelled with the bytes, not left running against a deleted directory'
    )

    // WHAT MADE THE QUEUE LOOK FULL OF DUPLICATES. A job's title is the
    // SERIES title, so two episodes of one show were two identical rows.
    // The season and episode come from the contentKey, parsed from the end
    // because a catalogId can contain colons of its own.
    jobs.enqueue({
      contentKey: 'tt99::2:7',
      infoHash: '3'.repeat(40),
      title: 'Same Show',
      ownerDeviceId: mineId
    })
    jobs.enqueue({
      contentKey: 'tt99::2:8',
      infoHash: '4'.repeat(40),
      title: 'Same Show',
      ownerDeviceId: mineId
    })
    const queue = (
      (await (
        await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${mineToken}` } })
      ).json()) as { jobs: Array<{ title: string; season?: number; episode?: number }> }
    ).jobs.filter((job) => job.title === 'Same Show')
    assert.equal(queue.length, 2)
    assert.deepEqual(
      queue.map((job) => `${job.season}x${job.episode}`).sort(),
      ['2x7', '2x8'],
      'two rows with the same title are told apart by their episode'
    )

    // A FILM HAS NO EPISODE, and must not be given one. Its key is
    // `id::` — both segments empty — and Number('') is 0, so converting
    // before checking labelled every movie in the queue S00E00.
    jobs.enqueue({
      contentKey: 'tt-film::',
      infoHash: '5'.repeat(40),
      title: 'A Film',
      ownerDeviceId: mineId
    })
    // Anime is often numbered straight through with no season, so this is
    // a real key. It gets the episode alone rather than an invented S00.
    jobs.enqueue({
      contentKey: 'tt-anime::7',
      infoHash: '6'.repeat(40),
      title: 'An Anime',
      ownerDeviceId: mineId
    })
    const labelled = (
      (await (
        await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${mineToken}` } })
      ).json()) as { jobs: Array<{ title: string; season?: number; episode?: number }> }
    ).jobs
    const film = labelled.find((job) => job.title === 'A Film')
    assert.equal(film?.season, undefined, 'a film is not season zero')
    assert.equal(film?.episode, undefined, 'nor episode zero')
    const anime = labelled.find((job) => job.title === 'An Anime')
    assert.equal(anime?.season, undefined, 'an unseasoned key does not invent a season')
    assert.equal(anime?.episode, 7, 'but its episode is still shown')
    assert.equal(body.includes(otherId), false, 'no other device id is disclosed')

    await fetch(`${base}/api/items/${'a'.repeat(40)}/sharing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${mineToken}` },
      body: JSON.stringify({ visibility: 'shared' })
    })
    const after = await mineFor(mineToken)
    assert.equal(
      after.find((i) => i.contentKey === 'k-mine-1')?.visibility,
      'shared',
      'and the listing reflects a change made through the sharing route'
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
  console.log('ok  own items listing')
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
  .then(budgetRoomTest)
  .then(statusScopeTest)
  .then(sharingRouteTest)
  .then(myItemsTest)
