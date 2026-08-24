// Unit tests for the startup snapshot store
// (src/renderer/src/lib/mediaHub/startupSnapshot.ts).
// Run with: npx tsx tests/startupSnapshot.test.ts   (or npm.cmd test)
//
// This module is what stands between a cold launch and a dashboard full
// of demo titles, and everything it reads back was written by a PREVIOUS
// version of this app. That makes the revival path the interesting part:
// MediaItem has gained required fields before, and an item that comes
// back missing `artTint` does not render slightly wrong — it throws on
// `item.artTint[0]` in FeaturedHero and takes the whole dashboard down on
// startup, which is a strictly worse failure than the one this replaced.
//
// The quota path matters for the same reason. localStorage is a hard
// ~5-10MB ceiling and the catalog is the largest thing going into it, so
// "the write failed" has to degrade to a smaller snapshot rather than to
// no snapshot at all.

import assert from 'node:assert/strict'
import type { MediaItem } from '../src/renderer/src/types'

let pass = 0
let failed = 0
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass++
      console.log(`  ok  ${name}`)
    })
    .catch((error) => {
      failed++
      console.error(`  FAIL  ${name}`)
      console.error(error)
    })
}

interface FakeStorage {
  store: Map<string, string>
  /** Bytes this fake refuses to exceed, mimicking a real quota rejection. */
  limit: number
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function fakeStorage(limit = Infinity): FakeStorage {
  return {
    store: new Map<string, string>(),
    limit,
    getItem(key) {
      return this.store.get(key) ?? null
    },
    setItem(key, value) {
      if (value.length > this.limit) {
        const error = new Error('QuotaExceededError')
        error.name = 'QuotaExceededError'
        throw error
      }
      this.store.set(key, value)
    },
    removeItem(key) {
      this.store.delete(key)
    }
  }
}

// The module memoises what it read on first access (a session-long fact
// by design — see startupCatalogFallback in hooks.ts), so each scenario
// needs its own module instance rather than a reset hook that only exists
// for tests. The distinct query suffix is what buys that; assertIsolated
// below checks the runner actually honours it, because a loader that
// collapsed these would leave every scenario asserting against the
// PREVIOUS one's memoised snapshot.
let moduleCounter = 0
async function loadModule(storage: FakeStorage) {
  ;(globalThis as { window?: unknown }).window = {
    localStorage: storage,
    // The module registers a pagehide flush; there is no page to hide
    // here, and the tests drive flushStartupSnapshot directly instead.
    addEventListener: () => undefined
  }
  moduleCounter++
  return import(`../src/renderer/src/lib/mediaHub/startupSnapshot.ts?case=${moduleCounter}`)
}

const STORAGE_KEY = 'r3.mediaHub.startupSnapshot.v1'

function mediaItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'movie-1',
    mediaType: 'movie',
    title: 'A Real Title',
    genres: ['Drama'],
    watched: false,
    completed: false,
    artTint: ['#18a9ff', '#050a14'],
    initials: 'AR',
    ...overrides
  } as MediaItem
}

/** Whatever the module has written into the fake store, parsed. */
function stored(storage: FakeStorage) {
  const raw = storage.getItem(STORAGE_KEY)
  assert.ok(raw, 'expected the snapshot to have been written')
  return JSON.parse(raw)
}

/**
 * Fails loudly, once, if the module cache is not per-suffix. Without this
 * the suite's diagnosis for that would be eight unrelated-looking
 * assertion failures instead of one sentence naming the cause.
 */
async function assertIsolated(): Promise<void> {
  const a = await loadModule(fakeStorage())
  const b = await loadModule(fakeStorage())
  assert.notEqual(
    a,
    b,
    'the test runner is reusing one module instance across query suffixes — every scenario below would read the previous one’s memoised snapshot'
  )
}

async function main(): Promise<void> {
  await assertIsolated()

  console.log('startupSnapshot — round trip')

  await check('remembers a catalog and reads it back on the next launch', async () => {
    const storage = fakeStorage()
    const first = await loadModule(storage)
    first.rememberCatalog([mediaItem({ id: 'm1', title: 'First' })])
    first.flushStartupSnapshot()

    const next = await loadModule(storage)
    const catalog = next.rememberedCatalog()
    assert.equal(catalog.length, 1)
    assert.equal(catalog[0].title, 'First')
  })

  await check('remembers the home feed, including the Continue Watching row', async () => {
    const storage = fakeStorage()
    const first = await loadModule(storage)
    first.rememberHomeFeed({
      featured: [mediaItem({ id: 'f1', title: 'Featured' })],
      recommendations: [
        {
          media: mediaItem({ id: 'r1', title: 'Recommended' }),
          confidence: 0.8,
          reasons: ['Because you liked something real'],
          generatedAt: '2026-01-01T00:00:00.000Z'
        }
      ],
      continueWatching: [
        {
          media: mediaItem({ id: 'c1', title: 'In Progress' }),
          lastPlayedAt: '2026-01-01T00:00:00.000Z',
          playbackPositionSeconds: 600,
          durationSeconds: 5400
        }
      ],
      preferredGenres: ['Drama']
    })
    first.flushStartupSnapshot()

    const feed = (await loadModule(storage)).rememberedHomeFeed()
    assert.equal(feed.featured[0].title, 'Featured')
    assert.equal(feed.recommendations[0].media.title, 'Recommended')
    assert.equal(feed.continueWatching[0].media.title, 'In Progress')
    assert.equal(feed.continueWatching[0].playbackPositionSeconds, 600)
    assert.deepEqual(feed.preferredGenres, ['Drama'])
  })

  console.log('\nstartupSnapshot — reviving what a previous version wrote')

  await check('derives artTint/initials for an item stored without them', async () => {
    const storage = fakeStorage()
    // Exactly the shape an older build would have left behind: valid
    // identity, none of the fields added since.
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        savedAt: Date.now(),
        catalog: [{ id: 'm1', title: 'Blade Runner 2049', mediaType: 'movie' }],
        featured: [],
        recommendations: [],
        continueWatching: [],
        preferredGenres: []
      })
    )
    const [item] = (await loadModule(storage)).rememberedCatalog()
    assert.equal(item.title, 'Blade Runner 2049')
    assert.ok(Array.isArray(item.artTint) && item.artTint.length >= 2)
    assert.equal(typeof item.artTint[0], 'string')
    assert.equal(typeof item.initials, 'string')
    assert.ok(item.initials.length > 0)
    assert.deepEqual(item.genres, [])
    assert.equal(item.watched, false)
  })

  await check('drops entries with no usable identity instead of rendering them', async () => {
    const storage = fakeStorage()
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        savedAt: Date.now(),
        catalog: [
          { id: 'm1', title: 'Keep me' },
          { id: '', title: 'No id' },
          { id: 'm3' },
          null,
          'not an object'
        ],
        featured: [],
        recommendations: [],
        continueWatching: [],
        preferredGenres: []
      })
    )
    const catalog = (await loadModule(storage)).rememberedCatalog()
    assert.equal(catalog.length, 1)
    assert.equal(catalog[0].title, 'Keep me')
  })

  await check('drops a wrapped entry whose media is unusable', async () => {
    const storage = fakeStorage()
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        savedAt: Date.now(),
        catalog: [],
        featured: [],
        recommendations: [
          { media: { id: 'r1', title: 'Real' }, confidence: 1, reasons: [], generatedAt: 'x' },
          { media: null, confidence: 1, reasons: [], generatedAt: 'x' },
          { confidence: 1, reasons: [], generatedAt: 'x' }
        ],
        continueWatching: [],
        preferredGenres: []
      })
    )
    const feed = (await loadModule(storage)).rememberedHomeFeed()
    assert.equal(feed.recommendations.length, 1)
    assert.equal(feed.recommendations[0].media.title, 'Real')
  })

  await check('reads corrupt JSON as "nothing remembered" rather than throwing', async () => {
    const storage = fakeStorage()
    storage.setItem(STORAGE_KEY, '{not json at all')
    const mod = await loadModule(storage)
    assert.deepEqual(mod.rememberedCatalog(), [])
    assert.deepEqual(mod.rememberedHomeFeed().featured, [])
  })

  await check('survives storage that throws on every access', async () => {
    const storage = fakeStorage()
    storage.getItem = () => {
      throw new Error('storage is partitioned off')
    }
    const mod = await loadModule(storage)
    assert.deepEqual(mod.rememberedCatalog(), [])
  })

  console.log('\nstartupSnapshot — staleness')

  await check('ignores and clears a snapshot older than the retention window', async () => {
    const storage = fakeStorage()
    const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        savedAt: thirtyOneDaysAgo,
        catalog: [{ id: 'm1', title: 'Ancient', artTint: ['#000', '#111'], initials: 'AN' }],
        featured: [],
        recommendations: [],
        continueWatching: [],
        preferredGenres: []
      })
    )
    const mod = await loadModule(storage)
    assert.deepEqual(mod.rememberedCatalog(), [])
    assert.equal(storage.getItem(STORAGE_KEY), null, 'the stale entry should be cleared, not kept')
  })

  await check('treats a savedAt from the future as stale, not fresh', async () => {
    const storage = fakeStorage()
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        savedAt: Date.now() + 31 * 24 * 60 * 60 * 1000,
        catalog: [{ id: 'm1', title: 'Tomorrow', artTint: ['#000', '#111'], initials: 'TO' }],
        featured: [],
        recommendations: [],
        continueWatching: [],
        preferredGenres: []
      })
    )
    assert.deepEqual((await loadModule(storage)).rememberedCatalog(), [])
  })

  await check('keeps a snapshot from inside the retention window', async () => {
    const storage = fakeStorage()
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        savedAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
        catalog: [{ id: 'm1', title: 'Recent', artTint: ['#000', '#111'], initials: 'RE' }],
        featured: [],
        recommendations: [],
        continueWatching: [],
        preferredGenres: []
      })
    )
    const catalog = (await loadModule(storage)).rememberedCatalog()
    assert.equal(catalog.length, 1)
    assert.equal(catalog[0].title, 'Recent')
  })

  console.log('\nstartupSnapshot — running out of storage')

  await check('sheds catalog descriptions rather than losing the whole snapshot', async () => {
    const longDescription = 'x'.repeat(4000)
    const withDescriptions = JSON.stringify({
      savedAt: Date.now(),
      catalog: [mediaItem({ id: 'm1', description: longDescription })],
      featured: [mediaItem({ id: 'f1' })],
      recommendations: [],
      continueWatching: [],
      preferredGenres: []
    })
    // A ceiling the full payload cannot fit under but the trimmed one can.
    const storage = fakeStorage(withDescriptions.length - 1000)
    const mod = await loadModule(storage)
    mod.rememberCatalog([mediaItem({ id: 'm1', description: longDescription })])
    mod.rememberHomeFeed({
      featured: [mediaItem({ id: 'f1' })],
      recommendations: [],
      continueWatching: [],
      preferredGenres: []
    })
    mod.flushStartupSnapshot()

    const written = stored(storage)
    assert.equal(written.catalog.length, 1, 'the catalog itself should have survived')
    assert.equal(written.catalog[0].description, undefined, 'the description should be gone')
    assert.equal(written.featured.length, 1, 'the home feed should be untouched')
  })

  await check('sheds the catalog entirely before giving up on the home feed', async () => {
    const homeFeedOnly = JSON.stringify({
      savedAt: Date.now(),
      catalog: [],
      featured: [mediaItem({ id: 'f1' })],
      recommendations: [],
      continueWatching: [],
      preferredGenres: []
    })
    const storage = fakeStorage(homeFeedOnly.length + 40)
    const mod = await loadModule(storage)
    mod.rememberCatalog(Array.from({ length: 40 }, (_, i) => mediaItem({ id: `m${i}` })))
    mod.rememberHomeFeed({
      featured: [mediaItem({ id: 'f1' })],
      recommendations: [],
      continueWatching: [],
      preferredGenres: []
    })
    mod.flushStartupSnapshot()

    const written = stored(storage)
    assert.deepEqual(written.catalog, [])
    assert.equal(written.featured.length, 1)
  })

  await check('leaves an existing snapshot alone when nothing at all fits', async () => {
    const storage = fakeStorage()
    storage.setItem(STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), catalog: [] }))
    const previous = storage.getItem(STORAGE_KEY)
    storage.limit = 1
    const mod = await loadModule(storage)
    mod.rememberCatalog([mediaItem({ id: 'm1' })])
    mod.flushStartupSnapshot()
    assert.equal(storage.getItem(STORAGE_KEY), previous)
  })

  console.log('\nstartupSnapshot — merging a partially-loaded catalog')

  // catalog:list publishes each kind as it lands. These pin the window in
  // between, where some kinds are live and others have not answered yet.
  const { mergeRememberedCatalog } = await loadModule(fakeStorage())
  const live = (id: string, kind: string) =>
    mediaItem({ id, title: `live ${id}`, mediaKind: kind as MediaItem['mediaKind'] })
  const kept = (id: string, kind: string) =>
    mediaItem({ id, title: `remembered ${id}`, mediaKind: kind as MediaItem['mediaKind'] })
  const remembered = [kept('m1', 'movie'), kept('s1', 'series'), kept('a1', 'anime')]
  const ids = (list: MediaItem[]) => list.map((m) => m.id)

  await check('carries kinds that have not answered yet', () => {
    // The real regression this guards: the Simkl feeds land in about a
    // second and the Kitsu crawl takes far longer, so publishing kinds as
    // they land used to blank the Anime page in between.
    const merged = mergeRememberedCatalog([live('m2', 'movie')], remembered, new Set(['movie']))
    assert.deepEqual(ids(merged), ['m2', 's1', 'a1'])
    assert.ok(!ids(merged).includes('m1'), 'an answered kind replaces its own rows outright')
  })

  await check('keeps carrying a kind whose fetch failed outright', () => {
    // Anime never resolves, so it never enters resolvedKinds. The
    // remembered anime has to survive — including into the next snapshot,
    // since the merged list is also what gets persisted.
    const merged = mergeRememberedCatalog(
      [live('m2', 'movie'), live('s2', 'series')],
      remembered,
      new Set(['movie', 'series'])
    )
    assert.deepEqual(ids(merged), ['m2', 's2', 'a1'])
  })

  await check('carries nothing once every kind has answered', () => {
    const liveAll = [live('m2', 'movie'), live('s2', 'series'), live('a2', 'anime')]
    const merged = mergeRememberedCatalog(
      liveAll,
      remembered,
      new Set(['movie', 'series', 'anime'])
    )
    assert.equal(merged, liveAll, 'the live array itself, not a copy, when nothing is carried')
  })

  await check('prefers the live copy of a title the snapshot also holds', () => {
    // Same id reached from an unresolved kind: the fresh row wins, so a
    // stale watched/My List badge cannot outlive the fetch that fixed it.
    const merged = mergeRememberedCatalog(
      [live('a1', 'movie')],
      [kept('a1', 'anime')],
      new Set(['movie'])
    )
    assert.equal(merged.length, 1)
    assert.equal(merged[0].title, 'live a1')
  })

  await check('carries items that belong to no kind at all', () => {
    // mockData's rows have no mediaKind (the bridgeless preview build).
    const merged = mergeRememberedCatalog(
      [live('m2', 'movie')],
      [mediaItem({ id: 'mock1', title: 'Mock', mediaKind: undefined })],
      new Set(['movie'])
    )
    assert.deepEqual(ids(merged), ['m2', 'mock1'])
  })

  await check('handles either side being empty', () => {
    assert.deepEqual(ids(mergeRememberedCatalog([live('m2', 'movie')], [], new Set())), ['m2'])
    assert.deepEqual(ids(mergeRememberedCatalog([], remembered, new Set())), ['m1', 's1', 'a1'])
  })

  console.log(`\n${pass} passed${failed ? `, ${failed} failed` : ''}`)
  if (failed) process.exitCode = 1
}

void main()
