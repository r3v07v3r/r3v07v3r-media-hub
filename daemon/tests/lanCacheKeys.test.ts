// Per-person TorBox keys, one job per file, and closing a reopened claim
// window from the app.
//
// 1. POST /api/jobs refuses a device with no saved key (403
//    torbox-key-required), after the dedupe so a cached or in-flight file
//    stays shareable, and its request is never fetched with somebody
//    else's key.
// 2. jobs.enqueue joins a queued/fetching job for the same file under
//    another contentKey instead of starting a second download.
// 3. POST /api/admin/close-claim lets the administrator end a reopening;
//    without it the window stays open.
// Run with: npx tsx daemon/tests/lanCacheKeys.test.ts

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createActivityTracker } from '../activity'
import { createAdmin, type Admin } from '../admin'
import { createCredentials, type Credentials } from '../credentials'
import { createFetcher } from '../fetcher'
import { createJobStore, sameFile, type JobStore } from '../jobs'
import { createPairing, deviceIdForToken, type Pairing } from '../pairing'
import { createDaemonServer } from '../server'
import { createItemStore, type ItemStore } from '../storage'

async function joinApproved(pairing: Pairing, deviceName: string): Promise<string> {
  const token = await pairing.requestPairing(deviceName)
  assert.ok(token, `pairing request for ${deviceName} was accepted`)
  await pairing.setStatus(deviceIdForToken(token), 'approved')
  return token
}

interface Harness {
  root: string
  base: string
  pairing: Pairing
  admin: Admin
  jobs: JobStore
  storage: ItemStore
  credentials: Credentials
  lines: string[]
  close(): Promise<void>
}

async function harness(prefix: string): Promise<Harness> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix))
  const pairing = createPairing(root)
  await pairing.load()
  const admin = createAdmin(root)
  await admin.load()
  const jobs = createJobStore(root)
  const storage = createItemStore(root, {
    idleTtlMs: 60_000,
    hardMaxMs: 600_000,
    budgetBytes: 10 ** 9,
    tombstoneMs: 60_000
  })
  const credentials = createCredentials(root)
  const lines: string[] = []
  const server = createDaemonServer({
    storage,
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
    diskBudgetBytes: 10 ** 9,
    log: (message) => lines.push(message)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return {
    root,
    base,
    pairing,
    admin,
    jobs,
    storage,
    credentials,
    lines,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  }
}

function postAs(base: string, token: string, route: string, body: unknown = {}): Promise<Response> {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

async function keyRequiredTest(): Promise<void> {
  const h = await harness('r3-keys-')
  try {
    await h.admin.claim(deviceIdForToken(await joinApproved(h.pairing, 'the admin')))
    const aliceToken = await joinApproved(h.pairing, 'alice')
    const bobToken = await joinApproved(h.pairing, 'bob')
    const aliceId = deviceIdForToken(aliceToken)
    const bobId = deviceIdForToken(bobToken)
    await postAs(h.base, aliceToken, '/api/credentials', { torboxToken: 'alice-torbox-token' })

    const fresh = 'f'.repeat(40)
    const refused = await postAs(h.base, bobToken, '/api/jobs', {
      contentKey: 'tt-bob',
      infoHash: fresh,
      title: 'Bob Film'
    })
    assert.equal(refused.status, 403, 'a device with no saved key cannot queue a download')
    const refusedBody = (await refused.json()) as { code?: string }
    assert.equal(refusedBody.code, 'torbox-key-required')
    assert.equal(h.jobs.list().length, 0, 'and nothing is queued for it')

    // Junk is still a 400 for a keyless caller, not a key prompt.
    const junk = await postAs(h.base, bobToken, '/api/jobs', { contentKey: '', infoHash: 'zz' })
    assert.equal(junk.status, 400)

    // Never fetched with somebody else's key: alice's key is the only one
    // on the server, and the fetch loop never resolves bob's hash.
    const resolvedWith: Array<{ token: string; infoHash: string }> = []
    const fetcher = createFetcher({
      jobs: h.jobs,
      storage: h.storage,
      credentials: h.credentials,
      dataDir: h.root,
      log: () => {},
      resolveDownloadImpl: async (token, infoHash) => {
        resolvedWith.push({ token, infoHash })
        return null
      }
    })
    fetcher.start()
    await new Promise((resolve) => setTimeout(resolve, 300))
    await fetcher.stop()
    assert.equal(
      resolvedWith.some((call) => call.infoHash === fresh),
      false,
      "a keyless caller's request is refused, never fetched with alice's key"
    )

    // A file already on disk stays shareable with a keyless caller.
    const held = 'a'.repeat(40)
    const dir = await h.storage.beginItem({
      contentKey: 'tt-held',
      title: 'Held',
      infoHash: held,
      fileName: 'f.mkv',
      sizeBytes: 4,
      fetchedAt: Date.now(),
      lastAccessAt: Date.now(),
      ownerDeviceId: aliceId,
      visibility: 'private',
      entitled: [aliceId]
    })
    await fsp.writeFile(path.join(dir, 'f.mkv'), 'ABCD')
    const shared = await postAs(h.base, bobToken, '/api/jobs', {
      contentKey: 'tt-held',
      infoHash: held,
      title: 'Held'
    })
    assert.equal(shared.status, 200)
    assert.deepEqual(await shared.json(), { state: 'ready' })
    assert.ok((await h.storage.get(held))?.entitled?.includes(bobId), 'and bob is granted it')

    // Somebody else's download already under way is answered with its
    // state. The job keeps its owner and nothing new is queued.
    const inFlight = 'c'.repeat(40)
    const queued = await postAs(h.base, aliceToken, '/api/jobs', {
      contentKey: 'tt-alice',
      infoHash: inFlight,
      title: 'Alice Film'
    })
    assert.equal(queued.status, 200, 'a device with a key queues as before')
    assert.deepEqual(await queued.json(), { state: 'queued' })
    const joined = await postAs(h.base, bobToken, '/api/jobs', {
      contentKey: 'kitsu:5',
      infoHash: inFlight,
      title: 'Alice Film'
    })
    assert.equal(joined.status, 200, 'the same file in flight stays shareable')
    assert.deepEqual(await joined.json(), { state: 'queued' })
    assert.equal(h.jobs.list().length, 1)
    assert.equal(h.jobs.list()[0].ownerDeviceId, aliceId)

    // A key saved later lets bob queue his own.
    await postAs(h.base, bobToken, '/api/credentials', { torboxToken: 'bob-torbox-token' })
    const now = await postAs(h.base, bobToken, '/api/jobs', {
      contentKey: 'tt-bob',
      infoHash: fresh,
      title: 'Bob Film'
    })
    assert.equal(now.status, 200)
    assert.equal(
      h.jobs.list().find((job) => job.contentKey === 'tt-bob')?.ownerDeviceId,
      bobId,
      'and the job is his'
    )
  } finally {
    await h.close()
  }
  console.log('ok  a keyless device is refused, never fetched with another key')
}

async function sameFileDedupeTest(): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-samefile-'))
  try {
    const jobs = createJobStore(root)
    const h = 'b'.repeat(40)

    jobs.enqueue({
      contentKey: 'tt1:1:1',
      infoHash: h,
      title: 'A',
      fileIdx: 3,
      ownerDeviceId: 'alice'
    })
    const b = jobs.enqueue({
      contentKey: 'kitsu:9:1',
      infoHash: h,
      title: 'A',
      fileIdx: 3,
      ownerDeviceId: 'bob'
    })
    assert.equal(jobs.list().length, 1, 'the same file under another key is not a second job')
    assert.equal(b?.contentKey, 'tt1:1:1', 'it joins the job already queued')
    assert.equal(b?.ownerDeviceId, 'alice', 'and the first owner keeps it')

    jobs.enqueue({
      contentKey: 'tt1:1:2',
      infoHash: h,
      title: 'A',
      fileIdx: 4,
      ownerDeviceId: 'bob'
    })
    assert.equal(jobs.list().length, 2, 'another file in the same pack stays a job of its own')

    // Fetching still joins.
    jobs.update('tt1:1:1', { state: 'fetching' })
    const c = jobs.enqueue({
      contentKey: 'tmdb:7:1:1',
      infoHash: h,
      title: 'A',
      fileIdx: 3,
      ownerDeviceId: 'carol'
    })
    assert.equal(c?.contentKey, 'tt1:1:1', 'a download under way is joined too')
    assert.equal(jobs.list().length, 2)

    // A failed or expired job for that file is not joined: a new request
    // gets a fresh job.
    jobs.update('tt1:1:1', { state: 'failed' })
    const d = jobs.enqueue({
      contentKey: 'kitsu:9:1',
      infoHash: h,
      title: 'A',
      fileIdx: 3,
      ownerDeviceId: 'bob'
    })
    assert.equal(d?.contentKey, 'kitsu:9:1', 'a failed job is not joined')
    assert.equal(d?.state, 'queued')
    jobs.update('tt1:1:2', { state: 'expired' })
    const e = jobs.enqueue({
      contentKey: 'tt-other:1:2',
      infoHash: h,
      title: 'A',
      fileIdx: 4,
      ownerDeviceId: 'bob'
    })
    assert.equal(e?.contentKey, 'tt-other:1:2', 'nor is an expired one')

    // With no file index, the episode named by the key decides.
    const x = { infoHash: h, contentKey: 'tt2', fileIdx: undefined }
    assert.equal(sameFile(x, { ...x, contentKey: 'kitsu:44' }), true, 'two film keys, one hash')
    assert.equal(
      sameFile({ ...x, contentKey: 'tt2:1:1' }, { ...x, contentKey: 'kitsu:4:1:1' }),
      true
    )
    assert.equal(sameFile({ ...x, contentKey: 'tt2:1:1' }, { ...x, contentKey: 'tt2:1:2' }), false)
    assert.equal(sameFile(x, { ...x, contentKey: 'tt2:1:1' }), false, 'a film is not an episode')
    assert.equal(sameFile(x, { ...x, fileIdx: 0 }), false, 'one side naming an index must match it')
    assert.equal(sameFile(x, { ...x, infoHash: 'c'.repeat(40) }), false)
  } finally {
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
  console.log('ok  the same file under two keys is one job')
}

async function closeClaimTest(): Promise<void> {
  const h = await harness('r3-close-claim-')
  try {
    const adminToken = await joinApproved(h.pairing, 'old admin')
    const memberToken = await joinApproved(h.pairing, 'member')
    await h.admin.claim(deviceIdForToken(adminToken))

    const pingUnclaimed = async (): Promise<boolean> =>
      ((await (await fetch(`${h.base}/api/ping`)).json()) as { unclaimed?: boolean }).unclaimed ===
      true
    const pair = async (deviceName: string): Promise<string> =>
      (
        (await (
          await fetch(`${h.base}/api/pair`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ deviceName })
          })
        ).json()) as { status: string }
      ).status

    // Not reopened: harmless.
    const idle = await postAs(h.base, adminToken, '/api/admin/close-claim')
    assert.equal(idle.status, 200, 'closing a window that is not open is harmless')
    assert.deepEqual(await idle.json(), { unclaimed: false })

    // What --claim-admin does at the console.
    await h.admin.reopen()

    const notAdmin = await postAs(h.base, memberToken, '/api/admin/close-claim')
    assert.equal(notAdmin.status, 403, 'only the administrator may close it')
    assert.equal(h.admin.isUnclaimed(), true)

    // Without the call the window stays open, even after the administrator
    // claims back from the app.
    const claimedBack = await postAs(h.base, adminToken, '/api/admin/claim')
    assert.equal(claimedBack.status, 200)
    assert.equal(h.admin.isUnclaimed(), true, 'claiming back does not close it')
    assert.equal(await pingUnclaimed(), true)
    assert.equal(await pair('let in'), 'approved', 'devices are still let in without asking')

    h.lines.length = 0
    const closed = await postAs(h.base, adminToken, '/api/admin/close-claim')
    assert.equal(closed.status, 200)
    assert.deepEqual(await closed.json(), { unclaimed: false })
    assert.equal(h.admin.isUnclaimed(), false)
    assert.equal(h.admin.isAdmin(deviceIdForToken(adminToken)), true, 'the administrator keeps it')
    assert.equal(await pingUnclaimed(), false, 'ping stops offering the claim')
    assert.equal(await pair('after close'), 'pending', 'joining waits for approval again')
    assert.ok(
      h.lines.some((line) => /claiming closed by the administrator "old admin"/.test(line)),
      'and the close is logged'
    )

    const reloaded = createAdmin(h.root)
    await reloaded.load()
    assert.equal(reloaded.isUnclaimed(), false, 'the close is persisted')
  } finally {
    await h.close()
  }
  console.log('ok  the administrator can close a reopened claim window')
}

async function sameFileAdoptionTest(): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-samefile-adopt-'))
  try {
    const jobs = createJobStore(root)
    const h = '9'.repeat(40)
    jobs.enqueue({
      contentKey: 'tt5',
      infoHash: h,
      title: 'A',
      fileIdx: 1,
      ownerDeviceId: 'xavier'
    })
    // xavier's key was removed after queueing; yvonne has one.
    const canFetch = (id: string): boolean => id === 'yvonne'
    const joined = jobs.enqueue(
      { contentKey: 'kitsu:5', infoHash: h, title: 'A', fileIdx: 1, ownerDeviceId: 'yvonne' },
      { canFetch }
    )
    assert.equal(joined?.contentKey, 'tt5', 'the same file under another key still joins')
    assert.equal(
      joined?.ownerDeviceId,
      'yvonne',
      'and a stuck job goes to the joiner who can fetch'
    )
    jobs.enqueue(
      { contentKey: 'kitsu:5', infoHash: h, title: 'A', fileIdx: 1, ownerDeviceId: 'zoe' },
      { canFetch }
    )
    assert.equal(jobs.list()[0].ownerDeviceId, 'yvonne', 'an owner who can fetch keeps it')
  } finally {
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
  console.log('ok  a same-file join heals a job its owner cannot fetch')
}

async function seasonPackHeldTest(): Promise<void> {
  const h = await harness('r3-pack-held-')
  try {
    await h.admin.claim(deviceIdForToken(await joinApproved(h.pairing, 'the admin')))
    const aliceToken = await joinApproved(h.pairing, 'alice')
    const bobToken = await joinApproved(h.pairing, 'bob')
    const aliceId = deviceIdForToken(aliceToken)
    const bobId = deviceIdForToken(bobToken)
    await postAs(h.base, bobToken, '/api/credentials', { torboxToken: 'bob-torbox-token' })

    // Episode 1 of a season pack is on disk, recorded with its file index.
    const pack = '7'.repeat(40)
    const dir = await h.storage.beginItem({
      contentKey: 'tt7:1:1',
      title: 'Show',
      infoHash: pack,
      fileName: 'e01.mkv',
      sizeBytes: 4,
      fileIdx: 1,
      fetchedAt: Date.now(),
      lastAccessAt: Date.now(),
      ownerDeviceId: aliceId,
      visibility: 'private',
      entitled: [aliceId]
    })
    await fsp.writeFile(path.join(dir, 'e01.mkv'), 'ABCD')
    const episodeOneIntact = async (why: string): Promise<void> => {
      const listed = await h.storage.list()
      assert.equal(listed.length, 1, `${why}: one item listed`)
      assert.equal(listed[0].contentKey, 'tt7:1:1', `${why}: still episode 1`)
      assert.equal((await h.storage.find('tt7:1:1'))?.complete, true, `${why}: lookup works`)
      assert.equal(await h.storage.usedBytes(), 4, `${why}: every byte on disk is counted`)
      const catalog = await fetch(`${h.base}/api/catalog?keys=tt7%3A1%3A1`, {
        headers: { Authorization: `Bearer ${aliceToken}` }
      })
      const body = (await catalog.json()) as { items: Array<{ contentKey: string }> }
      assert.ok(
        body.items.some((entry) => entry.contentKey === 'tt7:1:1'),
        `${why}: the owner still finds episode 1`
      )
    }

    // Episode 2 of the same pack is refused, not downloaded over episode 1
    // (storage keeps one file per torrent), and not answered with it.
    const e02 = await postAs(h.base, bobToken, '/api/jobs', {
      contentKey: 'tt7:1:2',
      infoHash: pack,
      title: 'Show',
      fileIdx: 2
    })
    assert.equal(e02.status, 409)
    assert.equal(((await e02.json()) as { code?: string }).code, 'other-file-held')
    assert.equal(h.jobs.list().length, 0, 'nothing is queued')
    assert.equal(
      (await h.storage.get(pack))?.entitled?.includes(bobId),
      false,
      'and bob is not granted the wrong file'
    )
    await episodeOneIntact('after the refused request')

    // A job for episode 2 queued before episode 1 landed is expired by the
    // fetch loop without touching TorBox or episode 1's record.
    h.jobs.enqueue({
      contentKey: 'tt7:1:2',
      infoHash: pack,
      title: 'Show',
      fileIdx: 2,
      ownerDeviceId: bobId
    })
    const resolved: string[] = []
    const fetcher = createFetcher({
      jobs: h.jobs,
      storage: h.storage,
      credentials: h.credentials,
      dataDir: h.root,
      log: () => {},
      resolveDownloadImpl: async (_token, infoHash) => {
        resolved.push(infoHash)
        return null
      }
    })
    fetcher.start()
    const deadline = Date.now() + 10_000
    while (
      h.jobs.list().find((job) => job.contentKey === 'tt7:1:2')?.state !== 'expired' &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await fetcher.stop()
    assert.equal(h.jobs.list().find((job) => job.contentKey === 'tt7:1:2')?.state, 'expired')
    assert.equal(resolved.includes(pack), false, 'nothing is fetched for it')
    await episodeOneIntact('after the fetch loop')

    // The same episode under its own index is answered from disk.
    const e01 = await postAs(h.base, bobToken, '/api/jobs', {
      contentKey: 'tt7:1:1',
      infoHash: pack,
      title: 'Show',
      fileIdx: 1
    })
    assert.deepEqual(await e01.json(), { state: 'ready' })
    assert.ok((await h.storage.get(pack))?.entitled?.includes(bobId))

    // An item written before the index was recorded falls back to the
    // episode in the key.
    const legacy = '6'.repeat(40)
    const legacyDir = await h.storage.beginItem({
      contentKey: 'tt8:1:1',
      title: 'Old',
      infoHash: legacy,
      fileName: 'e01.mkv',
      sizeBytes: 4,
      fetchedAt: Date.now(),
      lastAccessAt: Date.now()
    })
    await fsp.writeFile(path.join(legacyDir, 'e01.mkv'), 'ABCD')
    const legacyOther = await postAs(h.base, bobToken, '/api/jobs', {
      contentKey: 'tt8:1:2',
      infoHash: legacy,
      title: 'Old',
      fileIdx: 2
    })
    assert.equal(legacyOther.status, 409)
    const legacySame = await postAs(h.base, bobToken, '/api/jobs', {
      contentKey: 'tt8:1:1',
      infoHash: legacy,
      title: 'Old',
      fileIdx: 1
    })
    assert.deepEqual(await legacySame.json(), { state: 'ready' })

    // A partial of the SAME file is resumed, not refused.
    const partial = '5'.repeat(40)
    const partialDir = await h.storage.beginItem({
      contentKey: 'tt9',
      title: 'Partial',
      infoHash: partial,
      fileName: 'f.mkv',
      sizeBytes: 8,
      fileIdx: 0,
      fetchedAt: Date.now(),
      lastAccessAt: Date.now(),
      ownerDeviceId: bobId
    })
    await fsp.writeFile(path.join(partialDir, 'f.mkv'), 'ABCD')
    const again = await postAs(h.base, bobToken, '/api/jobs', {
      contentKey: 'tt9',
      infoHash: partial,
      title: 'Partial',
      fileIdx: 0
    })
    assert.deepEqual(await again.json(), { state: 'queued' })
    const resumer = createFetcher({
      jobs: h.jobs,
      storage: h.storage,
      credentials: h.credentials,
      dataDir: h.root,
      log: () => {},
      resolveDownloadImpl: async (_token, infoHash) => {
        resolved.push(infoHash)
        return null
      }
    })
    resumer.start()
    const resumeDeadline = Date.now() + 10_000
    while (!resolved.includes(partial) && Date.now() < resumeDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await resumer.stop()
    assert.ok(resolved.includes(partial), 'the partial goes back to TorBox to resume')
  } finally {
    await h.close()
  }
  console.log('ok  a second file of a held torrent is refused, never written over the first')
}

void keyRequiredTest()
  .then(sameFileDedupeTest)
  .then(sameFileAdoptionTest)
  .then(seasonPackHeldTest)
  .then(closeClaimTest)
  .then(() => {
    console.log('ok  r3-cache LAN cache keys')
  })
  .catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
