// The household title tier, daemon side: the store's change-sequence
// contract (the entire sync protocol), the crawler's refresh discipline
// (coalesce, cooldown, stop-on-dry), and the HTTP surface's boundaries.
// Run with: npx tsx daemon/tests/titles.test.ts

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { CatalogItem, MediaKind } from '../../src/shared/media-hub/types'
import { createActivityTracker } from '../activity'
import { createAdmin } from '../admin'
import { createCredentials } from '../credentials'
import { createJobStore } from '../jobs'
import { createPairing, deviceIdForToken } from '../pairing'
import { createDaemonServer } from '../server'
import { createItemStore } from '../storage'
import { createTitleCrawler, REFRESH_COOLDOWN_MS } from '../titleCrawler'
import {
  createTitleStore,
  RANK_DRIFT_SLACK,
  readFully,
  writeFully,
  type TitleStore
} from '../titles'

let pass = 0
const failures: string[] = []
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass += 1
  } catch (error) {
    failures.push(`${name}: ${(error as Error).message}`)
  }
}

function item(id: string, over: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id,
    title: id,
    type: 'movie',
    poster: '',
    background: '',
    logo: '',
    year: '',
    status: '',
    description: '',
    rating: '',
    runtime: '',
    genres: [],
    videos: [],
    trailers: [],
    ...over
  }
}

async function tempStore(): Promise<{ store: TitleStore; root: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-titles-'))
  const store = createTitleStore(root)
  await store.load()
  return { store, root }
}

async function main(): Promise<void> {
  // --- the store: seq is the sync protocol -------------------------------

  await check('changed rows get fresh seqs; unchanged rows keep theirs', async () => {
    const { store } = await tempStore()
    const changed = await store.upsert('movie', [
      { rank: 0, item: item('tt1') },
      { rank: 1, item: item('tt2') }
    ])
    assert.equal(changed, 2)
    const first = store.listSince('movie', 0, 10)
    assert.equal(first.rows.length, 2)

    // The identical crawl again: nothing changed, nothing re-issued —
    // the property that makes a 6-hourly re-crawl free for clients.
    const again = await store.upsert('movie', [
      { rank: 0, item: item('tt1') },
      { rank: 1, item: item('tt2') }
    ])
    assert.equal(again, 0, 'an unchanged catalog costs clients nothing')
    assert.equal(store.listSince('movie', first.nextSince, 10).rows.length, 0)

    // A real content change re-issues exactly that row.
    await store.upsert('movie', [{ rank: 0, item: item('tt1', { title: 'Renamed' }) }])
    const delta = store.listSince('movie', first.nextSince, 10)
    assert.equal(delta.rows.length, 1)
    assert.equal(delta.rows[0].item.title, 'Renamed')
    assert.equal(delta.total, 2, 'total is live rows, not history lines')
  })

  await check('rank wobble inside the slack is crawl noise, past it is news', async () => {
    const { store } = await tempStore()
    await store.upsert('movie', [{ rank: 100, item: item('tt1') }])
    const seen = store.listSince('movie', 0, 10).nextSince

    await store.upsert('movie', [{ rank: 100 + RANK_DRIFT_SLACK, item: item('tt1') }])
    assert.equal(
      store.listSince('movie', seen, 10).rows.length,
      0,
      'a wobble within the slack keeps the seq (and the stored rank)'
    )

    await store.upsert('movie', [{ rank: 100 + RANK_DRIFT_SLACK + 1, item: item('tt1') }])
    const moved = store.listSince('movie', seen, 10)
    assert.equal(moved.rows.length, 1, 'a genuine climb propagates')
    assert.equal(moved.rows[0].rank, 100 + RANK_DRIFT_SLACK + 1)
  })

  await check('watermark paging covers every row exactly once and terminates', async () => {
    const { store } = await tempStore()
    await store.upsert(
      'series',
      Array.from({ length: 23 }, (_, i) => ({ rank: i, item: item(`tt${i}`, { type: 'series' }) }))
    )
    const seenIds: string[] = []
    let since = 0
    for (let guard = 0; guard < 100; guard++) {
      const page = store.listSince('series', since, 5)
      seenIds.push(...page.rows.map((row) => row.item.id))
      since = page.nextSince
      if (!page.more) break
      assert.ok(page.rows.length > 0, 'more=true implies progress — or paging never terminates')
    }
    assert.equal(seenIds.length, 23)
    assert.equal(new Set(seenIds).size, 23, 'no row is sent twice')
  })

  await check('kinds are separate indexes sharing one sequence', async () => {
    const { store } = await tempStore()
    await store.upsert('movie', [{ rank: 0, item: item('tt1') }])
    await store.upsert('anime', [{ rank: 0, item: item('kitsu:1', { type: 'anime' }) }])
    assert.equal(store.listSince('movie', 0, 10).rows.length, 1)
    assert.equal(store.listSince('anime', 0, 10).rows.length, 1)
    assert.deepEqual(store.counts(), { movie: 1, series: 0, anime: 1 })
  })

  await check('the store survives a restart: rows, seqs and freshness reload', async () => {
    const { store, root } = await tempStore()
    await store.upsert('movie', [
      { rank: 0, item: item('tt1') },
      { rank: 1, item: item('tt2') }
    ])
    await store.upsert('movie', [{ rank: 0, item: item('tt1', { title: 'v2' }) }])
    await store.markRefreshed('movie', 1234)
    const before = store.listSince('movie', 0, 10)

    const reborn = createTitleStore(root)
    await reborn.load()
    const after = reborn.listSince('movie', 0, 10)
    assert.deepEqual(after, before, 'identical pages after reload')
    assert.equal(reborn.lastRefreshAt('movie'), 1234)

    // And the reloaded store continues the sequence rather than reusing it.
    await reborn.upsert('movie', [{ rank: 5, item: item('tt3') }])
    const next = reborn.listSince('movie', before.nextSince, 10)
    assert.equal(next.rows.length, 1)
    assert.equal(next.rows[0].item.id, 'tt3')
  })

  // --- rows live on disk: offsets must survive everything that moves them --

  await check('compaction rewrites the file and every row still reads back', async () => {
    const { store, root } = await tempStore()
    const ids = Array.from({ length: 40 }, (_, i) => `tt${i}`)
    // Enough re-issues of the same 40 rows to cross the compaction line
    // (more than twice the live rows plus COMPACT_SLACK_LINES).
    for (let round = 0; round < 30; round++) {
      await store.upsert(
        'movie',
        ids.map((id, rank) => ({ rank, item: item(id, { title: `${id} v${round}` }) }))
      )
    }
    const lines = (await fsp.readFile(path.join(root, 'titles.ndjson'), 'utf8'))
      .split('\n')
      .filter(Boolean)
    assert.ok(lines.length < 30 * 40, `compacted (${lines.length} lines)`)
    const page = store.listSince('movie', 0, 100)
    assert.equal(page.rows.length, 40)
    for (const row of page.rows) assert.equal(row.item.title, `${row.item.id} v29`)

    const reborn = createTitleStore(root)
    await reborn.load()
    assert.deepEqual(reborn.listSince('movie', 0, 100), page, 'and after a reload')
  })

  await check('a torn last line is dropped and the next append is not glued to it', async () => {
    const { store, root } = await tempStore()
    await store.upsert('movie', [{ rank: 0, item: item('tt1') }])
    await fsp.appendFile(path.join(root, 'titles.ndjson'), '{"seq":99,"kind":"mo')
    const reborn = createTitleStore(root)
    await reborn.load()
    assert.equal(reborn.counts().movie, 1, 'the fragment is not a row')
    await reborn.upsert('movie', [{ rank: 1, item: item('tt2') }])
    const again = createTitleStore(root)
    await again.load()
    assert.deepEqual(
      again
        .listSince('movie', 0, 10)
        .rows.map((row) => row.item.id)
        .sort(),
      ['tt1', 'tt2'],
      'the row appended after the fragment survives a reload'
    )
  })

  await check('two crawls appending at once do not overlap their rows', async () => {
    const { store, root } = await tempStore()
    await Promise.all([
      store.upsert(
        'movie',
        Array.from({ length: 50 }, (_, i) => ({ rank: i, item: item(`tt${i}`) }))
      ),
      store.upsert(
        'anime',
        Array.from({ length: 50 }, (_, i) => ({
          rank: i,
          item: item(`kitsu:${i}`, { type: 'anime', title: 'ア'.repeat(i) })
        }))
      )
    ])
    const movies = store.listSince('movie', 0, 100).rows
    const anime = store.listSince('anime', 0, 100).rows
    assert.equal(movies.length, 50)
    assert.equal(anime.length, 50)
    // Multi-byte titles: offsets are bytes, not characters.
    for (const row of anime) assert.equal(row.item.title, 'ア'.repeat(Number(row.rank)))
    const reborn = createTitleStore(root)
    await reborn.load()
    assert.deepEqual(reborn.listSince('anime', 0, 100).rows, anime)
  })

  // A full disk: the append writes part of its data, then fails. Both ways
  // out (cutting the file back, and when even that fails, learning where it
  // ends on the next write) must leave later rows readable.
  for (const truncateWorks of [true, false]) {
    await check(
      `a half-written append leaves later rows readable (truncate ${truncateWorks ? 'works' : 'fails'})`,
      async () => {
        const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-titles-'))
        let failNext = false
        const store = createTitleStore(root, {
          appendFile: async (file, data) => {
            if (failNext) {
              failNext = false
              await fsp.appendFile(file, data.slice(0, 17))
              throw Object.assign(new Error('no space left'), { code: 'ENOSPC' })
            }
            await fsp.appendFile(file, data)
          },
          truncate: async (file, size) => {
            if (!truncateWorks) throw new Error('truncate refused')
            await fsp.truncate(file, size)
          }
        })
        await store.load()
        await store.upsert('movie', [{ rank: 0, item: item('tt1') }])
        failNext = true
        assert.equal(await store.upsert('movie', [{ rank: 1, item: item('tt2') }]), 0)
        assert.equal(await store.upsert('movie', [{ rank: 2, item: item('tt3') }]), 1)
        assert.deepEqual(
          store.listSince('movie', 0, 10).rows.map((row) => row.item.id),
          ['tt1', 'tt3'],
          'rows after the failure read back'
        )
        const reborn = createTitleStore(root)
        await reborn.load()
        assert.deepEqual(
          reborn
            .listSince('movie', 0, 10)
            .rows.map((row) => row.item.id)
            .sort(),
          ['tt1', 'tt3'],
          'and after a reload'
        )
      }
    )
  }

  await check('short writes and reads are finished, not taken for whole ones', async () => {
    // A handle that moves at most 3 bytes per call and says so.
    const disk = Buffer.alloc(64)
    const stingy = {
      async write(buffer: Buffer, offset: number, length: number, position: number) {
        const n = Math.min(3, length)
        buffer.copy(disk, position, offset, offset + n)
        return { bytesWritten: n }
      },
      async read(buffer: Buffer, offset: number, length: number, position: number) {
        const n = Math.min(3, length)
        disk.copy(buffer, offset, position, position + n)
        return { bytesRead: n }
      }
    }
    const line = Buffer.from('{"seq":1,"id":"tt1"}\n')
    await writeFully(stingy, line, 5)
    const back = Buffer.alloc(line.length)
    await readFully(stingy, back, 5)
    assert.equal(back.toString(), line.toString())
    await assert.rejects(
      writeFully({ write: async () => ({ bytesWritten: 0 }) }, line, 0),
      'a write that makes no progress is an error, not a loop'
    )
  })

  await check('a load that failed is retried before anything is appended', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-titles-'))
    const file = path.join(root, 'titles.ndjson')
    // Unreadable at boot: a directory where the file should be stands in for
    // EIO, and is an error on every platform rather than "no file yet".
    await fsp.mkdir(file)
    const store = createTitleStore(root)
    await store.load()
    // I/O recovers, and the file turns out to hold an older row.
    await fsp.rmdir(file)
    const old = createTitleStore(root)
    await old.load()
    await old.upsert('movie', [{ rank: 0, item: item('tt-old') }])

    assert.equal(await store.upsert('movie', [{ rank: 1, item: item('tt-new') }]), 1)
    const rows = store.listSince('movie', 0, 10).rows
    assert.deepEqual(
      rows.map((row) => row.item.id),
      ['tt-old', 'tt-new'],
      'the new row is indexed where it landed, after the rows the file held'
    )
    const reborn = createTitleStore(root)
    await reborn.load()
    assert.deepEqual(reborn.listSince('movie', 0, 10).rows, rows)
  })

  await check('a page asked for during a retried load is refused, not served partial', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-titles-'))
    const file = path.join(root, 'titles.ndjson')
    await fsp.mkdir(file)
    const store = createTitleStore(root)
    await store.load()
    await fsp.rmdir(file)
    const seed = createTitleStore(root)
    await seed.load()
    await seed.upsert('series', [{ rank: 0, item: item('tt-show', { type: 'series' }) }])

    // A movie write retries the load; a series page is asked for meanwhile.
    const writing = store.upsert('movie', [{ rank: 0, item: item('tt-film') }])
    assert.throws(() => store.listSince('series', 0, 10), /still loading/)
    await writing
    assert.equal(store.counts().series, 1)
    assert.deepEqual(
      store.listSince('series', 0, 10).rows.map((row) => row.item.id),
      ['tt-show'],
      'the series page reflects the finished load'
    )
  })

  await check('a compaction that cannot open its temp file leaks no handle', async () => {
    const { store, root } = await tempStore()
    // The tmp path is taken by a directory, so every compaction fails to
    // open its target, and every changed upsert past the line retries.
    await fsp.mkdir(path.join(root, 'titles.ndjson.tmp'))
    const open = fsp.open
    let live = 0
    fsp.open = (async (...args: Parameters<typeof open>) => {
      const handle = await open(...args)
      live += 1
      const close = handle.close.bind(handle)
      handle.close = async () => {
        live -= 1
        return close()
      }
      return handle
    }) as typeof open
    try {
      const ids = Array.from({ length: 40 }, (_, i) => `tt${i}`)
      for (let round = 0; round < 40; round++) {
        await store.upsert(
          'movie',
          ids.map((id, rank) => ({ rank, item: item(id, { title: `${id} v${round}` }) }))
        )
      }
    } finally {
      fsp.open = open
    }
    assert.equal(live, 0, 'every handle opened was closed')
    assert.equal(store.listSince('movie', 0, 100).rows.length, 40, 'and the store still serves')
  })

  await check('no sync watermark can come from a half-read index', async () => {
    // A compacted file is in map order, not seq order: seq 10 can come
    // before seq 1. A page served between the two would say "caught up to
    // 10" and the client would never ask for seq 1.
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-titles-'))
    const lines = [
      { seq: 10, kind: 'movie', rank: 0, item: item('tt-late') },
      // Padding so the two rows land in different read chunks.
      ...Array.from({ length: 600 }, (_, i) => ({
        seq: 100 + i,
        kind: 'series',
        rank: i,
        item: item(`tt-pad${i}`, { type: 'series', description: 'x'.repeat(2000) })
      })),
      { seq: 1, kind: 'movie', rank: 1, item: item('tt-early') }
    ]
    await fsp.writeFile(
      path.join(root, 'titles.ndjson'),
      lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
    )
    const store = createTitleStore(root)
    const loading = store.load()
    assert.throws(() => store.listSince('movie', 0, 10), /still loading/)
    await loading
    const page = store.listSince('movie', 0, 10)
    assert.deepEqual(
      page.rows.map((row) => row.item.id),
      ['tt-early', 'tt-late']
    )
    assert.equal(page.nextSince, 10)
  })

  await check('a torn tail at boot on a full disk is still closed off later', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-titles-'))
    const first = createTitleStore(root)
    await first.load()
    await first.upsert('movie', [{ rank: 0, item: item('tt1') }])
    await fsp.appendFile(path.join(root, 'titles.ndjson'), '{"seq":7,"kind":"mo')

    let full = true
    const store = createTitleStore(root, {
      appendFile: async (file, data) => {
        if (full) throw Object.assign(new Error('no space left'), { code: 'ENOSPC' })
        await fsp.appendFile(file, data)
      }
    })
    await store.load()
    full = false
    assert.equal(await store.upsert('movie', [{ rank: 1, item: item('tt2') }]), 1)

    const reborn = createTitleStore(root)
    await reborn.load()
    assert.deepEqual(
      reborn
        .listSince('movie', 0, 10)
        .rows.map((row) => row.item.id)
        .sort(),
      ['tt1', 'tt2'],
      'the row written after the full disk is not glued to the fragment'
    )
  })

  // --- the crawler: refresh discipline -----------------------------------

  await check('refresh coalesces: one started, joiners join, cooldown throttles', async () => {
    const { store } = await tempStore()
    let clock = 1_000_000
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let fetches = 0
    const crawler = createTitleCrawler({
      store,
      log: () => {},
      now: () => clock,
      pageGapMs: 0,
      fetchPage: async (_kind, page) => {
        fetches += 1
        if (page === 0) {
          await gate
          return [item('tt1')]
        }
        return []
      }
    })

    const first = crawler.refresh('movie')
    assert.equal(first.state, 'started')
    const second = crawler.refresh('movie')
    assert.equal(second.state, 'joined', 'a concurrent ask joins the running crawl')
    assert.ok(crawler.isCrawling())

    release()
    for (let i = 0; i < 200 && crawler.isCrawling(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(!crawler.isCrawling(), 'the crawl finished')
    assert.ok(fetches >= 3, 'page 0 with rows, then the two empty pages that end the walk')

    const throttled = crawler.refresh('movie')
    assert.equal(throttled.state, 'throttled', 'inside the cooldown is a normal answer')
    assert.equal(throttled.nextAllowedAt, clock + REFRESH_COOLDOWN_MS)
    assert.equal(throttled.lastRefreshAt, clock)

    clock += REFRESH_COOLDOWN_MS + 1
    const later = crawler.refresh('movie')
    assert.equal(later.state, 'started', 'past the cooldown a fresh crawl starts')
    for (let i = 0; i < 200 && crawler.isCrawling(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  })

  await check('one empty page is tolerated, two consecutive end the walk', async () => {
    const { store } = await tempStore()
    const served: Record<number, CatalogItem[]> = {
      0: [item('tt1')],
      1: [], // transient failure mid-walk
      2: [item('tt2')]
      // 3, 4: empty — the end
    }
    let highest = -1
    const crawler = createTitleCrawler({
      store,
      log: () => {},
      pageGapMs: 0,
      fetchPage: async (_kind, page) => {
        highest = Math.max(highest, page)
        return served[page] ?? []
      }
    })
    crawler.refresh('movie')
    for (let i = 0; i < 200 && crawler.isCrawling(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(store.counts().movie, 2, 'the row past the gap was reached')
    assert.equal(highest, 4, 'the walk stopped at the second consecutive empty page')
  })

  // --- the HTTP surface --------------------------------------------------

  await check('routes: auth required, kinds validated, paging and refresh answer', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-titles-http-'))
    const pairing = createPairing(root)
    await pairing.load()
    const token = await pairing.requestPairing('test-device')
    assert.ok(token)
    await pairing.setStatus(deviceIdForToken(token), 'approved')

    const titles = createTitleStore(root)
    await titles.load()
    await titles.upsert(
      'movie',
      Array.from({ length: 7 }, (_, i) => ({ rank: i, item: item(`tt${i}`) }))
    )
    await titles.markRefreshed('movie', 42)
    const crawler = createTitleCrawler({
      store: titles,
      log: () => {},
      pageGapMs: 0,
      fetchPage: async () => []
    })

    const jobs = createJobStore(root)
    const credentials = createCredentials(root)
    const activity = createActivityTracker(root)
    const admin = createAdmin(root)
    await admin.load()
    const server = createDaemonServer({
      storage: createItemStore(root, {
        idleTtlMs: 1,
        hardMaxMs: 1,
        budgetBytes: 1,
        tombstoneMs: 1
      }),
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
      diskBudgetBytes: 10 ** 9,
      titles,
      titleCrawler: crawler
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const base = `http://127.0.0.1:${port}`
    const auth = { Authorization: `Bearer ${token}` }

    try {
      // The index is behind the same bearer gate as everything else.
      const unauth = await fetch(`${base}/api/titles?kind=movie`)
      assert.equal(unauth.status, 401)

      const badKind = await fetch(`${base}/api/titles?kind=games`, { headers: auth })
      assert.equal(badKind.status, 400)

      // Watermark paging over HTTP: 7 rows in pages of 3, then a clean end.
      const ids: string[] = []
      let since = 0
      for (let guard = 0; guard < 10; guard++) {
        const res = await fetch(`${base}/api/titles?kind=movie&since=${since}&limit=3`, {
          headers: auth
        })
        assert.equal(res.status, 200)
        const page = (await res.json()) as {
          rows: Array<{ item: { id: string } }>
          nextSince: number
          more: boolean
          total: number
        }
        ids.push(...page.rows.map((row) => row.item.id))
        assert.equal(page.total, 7)
        since = page.nextSince
        if (!page.more) break
      }
      assert.equal(new Set(ids).size, 7, 'every row arrived exactly once')

      // Status carries index freshness for the app to show — read BEFORE
      // the refresh below, whose crawl re-stamps lastRefreshAt.
      const status = await fetch(`${base}/api/status`, { headers: auth })
      const body = (await status.json()) as {
        titles?: { counts: Record<MediaKind, number>; lastRefreshAt: Record<MediaKind, number> }
      }
      assert.equal(body.titles?.counts.movie, 7)
      assert.equal(body.titles?.lastRefreshAt.movie, 42)

      // Refresh: a validated kind and a normal throttled/started answer.
      const badRefresh = await fetch(`${base}/api/titles/refresh`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'games' })
      })
      assert.equal(badRefresh.status, 400)

      const refresh = await fetch(`${base}/api/titles/refresh`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'movie' })
      })
      assert.equal(refresh.status, 200)
      const answer = (await refresh.json()) as { state: string }
      assert.ok(
        ['started', 'joined', 'throttled'].includes(answer.state),
        `refresh answers a wire state, got ${answer.state}`
      )
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  await check('a daemon built without the tier says so instead of pretending', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-titles-none-'))
    const pairing = createPairing(root)
    await pairing.load()
    const token = await pairing.requestPairing('test-device')
    assert.ok(token)
    await pairing.setStatus(deviceIdForToken(token), 'approved')
    const jobs = createJobStore(root)
    const credentials = createCredentials(root)
    const activity = createActivityTracker(root)
    const admin = createAdmin(root)
    await admin.load()
    const server = createDaemonServer({
      storage: createItemStore(root, {
        idleTtlMs: 1,
        hardMaxMs: 1,
        budgetBytes: 1,
        tombstoneMs: 1
      }),
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
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/titles?kind=movie`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      assert.equal(res.status, 404)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  for (const failure of failures) console.error(`FAIL ${failure}`)
  console.log(`\n${pass} passed`)
  if (failures.length) process.exit(1)
}

void main()
