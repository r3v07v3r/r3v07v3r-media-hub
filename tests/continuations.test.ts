// What comes next after what was just watched (main/media-hub/
// continuations.ts), and how the ranking and the stored list treat it.
//
// The claims worth pinning: only the SINGLE next part of a series is
// suggested; the most recently watched part is the one that asks; a part
// already seen is still suggested when the series is being rewatched in
// order; a recent watch outranks an old one; and a continuation leaves
// the stored list the moment it is watched again.
//
// Run with: npx tsx tests/continuations.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  continuationsFor,
  recentWatches,
  type ContinuationSources
} from '../src/main/media-hub/continuations'
import {
  groupRecommendationRails,
  rankPersonalizedRecommendationsScored,
  recencyWeight
} from '../src/shared/media-hub/catalog-logic'
import {
  recommendationRailTitle,
  recommendationReasonLabel
} from '../src/shared/media-hub/recommendationReason'
import { createDatabase } from '../src/main/media-hub/database'
import { setDatabase } from '../src/main/media-hub/dbState'
import {
  liveExclusions,
  readStoredRecommendations,
  storeRecommendations,
  storeKey
} from '../src/main/media-hub/recommendations'
import type { CatalogItem, HistoryEntry } from '../src/shared/media-hub/types'
import type { ScoredRecommendation } from '../src/shared/media-hub/catalog-logic'

let pass = 0
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass++
      console.log(`  ok  ${name}`)
    })
    .catch((error) => {
      console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
      process.exitCode = 1
    })
}

function film(id: string, title: string, year: string): CatalogItem {
  return {
    id,
    title,
    year,
    type: 'movie',
    poster: '',
    background: '',
    logo: '',
    description: '',
    rating: '7',
    runtime: '',
    genres: ['Action'],
    videos: [],
    trailers: []
  }
}

function anime(id: string, title: string, groupedIds?: string[]): CatalogItem {
  return { ...film(id, title, '2020'), type: 'anime', groupedIds }
}

function watch(item: CatalogItem, watchedAt: string): HistoryEntry {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    year: item.year,
    season: null,
    episode: null,
    watchedAt
  }
}

const NOW = Date.parse('2026-09-14T00:00:00Z')
const daysAgo = (days: number): string => new Date(NOW - days * 86_400_000).toISOString()

const wick1 = film('tt2911666', 'John Wick', '2014')
const wick2 = film('tt4425200', 'John Wick: Chapter 2', '2017')
const wick3 = film('tt6146586', 'John Wick: Chapter 3 - Parabellum', '2019')
const wick4 = film('tt10366206', 'John Wick: Chapter 4', '2023')
const WICK = { name: 'John Wick Collection', parts: [wick1, wick2, wick3, wick4] }

const knight1 = anime('kitsu:100', 'Skeleton Knight')
const knight2 = anime('kitsu:200', 'Skeleton Knight Season 2')
const knight3 = anime('kitsu:300', 'Skeleton Knight: The Movie')

function sources(over: Partial<ContinuationSources> = {}): ContinuationSources {
  return {
    collection: async (id) =>
      WICK.parts.some((part) => part.id === id) ? WICK : { name: '', parts: [] },
    story: async (id) =>
      id === knight1.id
        ? { links: [{ relation: 'sequel', item: knight2 }], checked: true }
        : id === knight2.id
          ? { links: [{ relation: 'sequel', item: knight3 }], checked: true }
          : { links: [], checked: true },
    lookup: () => [],
    ...over
  }
}

const pool = new Map(
  [wick1, wick2, wick3, wick4, knight1, knight2, knight3].map((x) => [x.id, x])
)
const series = (id: string, title: string): CatalogItem => ({ ...film(id, title, '2020'), type: 'series' })

async function main(): Promise<void> {
  console.log('recentWatches')

  await check('the latest distinct titles inside the window, newest first', () => {
    const recent = recentWatches(
      [
        watch(wick2, daysAgo(1)),
        watch(wick2, daysAgo(2)),
        watch(wick1, daysAgo(3)),
        watch(wick3, daysAgo(40))
      ],
      NOW
    )
    assert.deepEqual(
      recent.map((r) => r.id),
      [wick2.id, wick1.id]
    )
  })

  await check('series never spend the cap: a week of shows leaves room for the film', () => {
    const shows = Array.from({ length: 20 }, (_, i) =>
      watch(series(`tt900${i}`, `Show ${i}`), daysAgo(1))
    )
    const recent = recentWatches([...shows, watch(wick2, daysAgo(8))], NOW)
    assert.deepEqual(
      recent.map((r) => r.id),
      [wick2.id]
    )
  })

  await check('a watch with no usable date counts as watched, not as never', () => {
    // Simkl omits the date on some films; "never watched" would wrongly
    // suggest the part again, and keep suggesting it.
    return continuationsFor(
      [watch(wick2, daysAgo(1)), { ...watch(wick3, daysAgo(30)), watchedAt: null }],
      pool,
      NOW,
      sources()
    ).then((found) => assert.equal(found.size, 0))
  })

  console.log('\ncontinuationsFor')

  await check('the next part of a collection, once, from its latest watched part', async () => {
    const found = await continuationsFor(
      [watch(wick2, daysAgo(1)), watch(wick1, daysAgo(2))],
      pool,
      NOW,
      sources()
    )
    assert.deepEqual([...found.keys()], [wick3.id], 'only the single next part, and only once')
    assert.equal(found.get(wick3.id)?.from, wick2.title)
  })

  await check(
    'a rewatch in order suggests the next part even though it was seen before',
    async () => {
      const found = await continuationsFor(
        [watch(wick2, daysAgo(1)), watch(wick1, daysAgo(2)), watch(wick3, daysAgo(30))],
        pool,
        NOW,
        sources()
      )
      assert.ok(found.has(wick3.id), 'Chapter 3 was watched before this run through, so it is next')
    }
  )

  await check('a part watched after the source means they already moved on', async () => {
    const found = await continuationsFor(
      [watch(wick3, daysAgo(1)), watch(wick2, daysAgo(2))],
      pool,
      NOW,
      sources()
    )
    assert.deepEqual([...found.keys()], [wick4.id], 'Chapter 3 asks now, not Chapter 2')
  })

  await check('the last part of a series has nothing after it', async () => {
    const found = await continuationsFor([watch(wick4, daysAgo(1))], pool, NOW, sources())
    assert.equal(found.size, 0)
  })

  await check(
    'an anime sequel from the story links; a grouped show asks from its last season',
    async () => {
      const found = await continuationsFor([watch(knight1, daysAgo(1))], pool, NOW, sources())
      assert.ok(found.has(knight2.id))
      // Seasons 1 and 2 are one tile keyed on season 1; season 2 is not a
      // different title to suggest, and what follows the tile is the film.
      const grouped = new Map(pool)
      grouped.set(knight1.id, anime(knight1.id, knight1.title, [knight2.id]))
      const folded = await continuationsFor([watch(knight1, daysAgo(1))], grouped, NOW, sources())
      assert.deepEqual([...folded.keys()], [knight3.id])
    }
  )

  await check(
    'a next part outside the pool is looked up, and failing that the collection record stands',
    async () => {
      const small = new Map([[wick2.id, wick2]])
      const looked = await continuationsFor(
        [watch(wick2, daysAgo(1))],
        small,
        NOW,
        sources({ lookup: (ids) => (ids[0] === wick3.id ? [{ ...wick3, rating: '9' }] : []) })
      )
      assert.equal(looked.get(wick3.id)?.item.rating, '9', 'the index record wins')
      const fallback = await continuationsFor([watch(wick2, daysAgo(1))], small, NOW, sources())
      assert.equal(fallback.get(wick3.id)?.item.title, wick3.title)
    }
  )

  await check('one failing lookup does not cost the others theirs', async () => {
    const found = await continuationsFor(
      [watch(wick2, daysAgo(1)), watch(knight1, daysAgo(2))],
      pool,
      NOW,
      sources({
        collection: async () => {
          throw new Error('TMDB down')
        }
      })
    )
    assert.deepEqual([...found.keys()], [knight2.id])
  })

  console.log('\nranking')

  await check('a recent watch outranks an old one, and the catalogue answer names itself', () => {
    const oldSource = film('old-1', 'Old Saga', '2010')
    const oldNext = film('old-2', 'Old Saga Part Two', '2012')
    const ranked = rankPersonalizedRecommendationsScored([oldNext, wick3], {
      history: [watch(wick2, daysAgo(1)), watch(oldSource, daysAgo(400))],
      now: new Date(NOW),
      continuations: new Map([[wick3.id, { from: wick2.title, watchedAt: daysAgo(1) }]])
    })
    assert.equal(ranked[0].item.id, wick3.id)
    assert.deepEqual(ranked[0].reason, { kind: 'next', detail: wick2.title })
    assert.deepEqual(ranked[0].continuation, { from: wick2.title, watchedAt: daysAgo(1) })
    assert.deepEqual(ranked[1].reason, { kind: 'continues', detail: 'Old Saga' })
    assert.ok(ranked[0].score > ranked[1].score * 2, 'recency is most of the difference')
  })

  await check('recency falls away but never to nothing', () => {
    const now = new Date(NOW)
    assert.ok(recencyWeight(daysAgo(1), now) > recencyWeight(daysAgo(10), now))
    assert.ok(recencyWeight(daysAgo(10), now) > recencyWeight(daysAgo(100), now))
    assert.ok(recencyWeight(daysAgo(1000), now) > 0)
    assert.equal(recencyWeight(null, now), recencyWeight(daysAgo(1000), now))
  })

  await check('a continuation is the one watched title allowed into the ranking', () => {
    const ranked = rankPersonalizedRecommendationsScored([wick3, wick4], {
      history: [watch(wick2, daysAgo(1)), watch(wick3, daysAgo(30)), watch(wick4, daysAgo(30))],
      now: new Date(NOW),
      continuations: new Map([[wick3.id, { from: wick2.title, watchedAt: daysAgo(1) }]])
    })
    assert.deepEqual(
      ranked.map((entry) => entry.item.id),
      [wick3.id],
      'Chapter 4 is watched and not a continuation, so it stays out'
    )
  })

  await check('every continuation shelves together, from the first one', () => {
    const next = (id: string, from: string): ScoredRecommendation => ({
      item: film(id, id, '2020'),
      score: 100,
      reason: { kind: 'next', detail: from },
      continuation: { from, watchedAt: daysAgo(1) }
    })
    const rails = groupRecommendationRails([next('a', 'A'), next('b', 'B')], { minItems: 4 })
    assert.equal(rails.length, 1)
    assert.equal(rails[0].id, 'next')
    assert.deepEqual(
      rails[0].items.map((item) => item.id),
      ['a', 'b']
    )
    assert.equal(recommendationRailTitle(rails[0].reason), 'Up next in your series')
    assert.equal(recommendationReasonLabel({ kind: 'next', detail: 'A' }), 'Next after A')
  })

  console.log('\nstored list')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-continuations-test-'))
  const db = createDatabase(path.join(dir, 'test.sqlite'), 'profile-test')
  setDatabase(db)

  await check('a continuation survives being watched before the build, not after', () => {
    const entries: ScoredRecommendation[] = Array.from({ length: 40 }, (_, i) => ({
      item: film(`f${i}`, `Film ${i}`, '2020'),
      score: 100 - i
    }))
    entries.unshift({
      item: wick3,
      score: 500,
      reason: { kind: 'next', detail: wick2.title },
      continuation: { from: wick2.title, watchedAt: daysAgo(1) }
    })
    db.markWatched(wick3, {})
    storeRecommendations(entries, [])
    const before = readStoredRecommendations(liveExclusions(db.history()), db.history())
    assert.ok(before, 'the list is served')
    assert.equal(before.items[0].id, wick3.id, 'seen before the build: still the next part')

    // Watched again, after the build.
    const stored = db.getCache<{ entries: ScoredRecommendation[]; builtAt: number }>(storeKey(), {
      allowExpired: true
    })!
    db.putCache(storeKey(), { ...stored, builtAt: Date.now() - 60_000 }, 60 * 60 * 1000)
    db.markWatched(wick3, {})
    const after = readStoredRecommendations(liveExclusions(db.history()), db.history())
    assert.ok(after)
    assert.ok(!after.items.some((item) => item.id === wick3.id), 'they carried on; it goes')
  })

  await check('a planned continuation is served; a disliked one is not', () => {
    const entries: ScoredRecommendation[] = Array.from({ length: 40 }, (_, i) => ({
      item: film(`g${i}`, `Film ${i}`, '2020'),
      score: 100 - i
    }))
    entries.unshift({
      item: wick4,
      score: 500,
      reason: { kind: 'next', detail: wick3.title },
      continuation: { from: wick3.title, watchedAt: daysAgo(1) }
    })
    db.track(wick4)
    storeRecommendations(entries, [])
    const planned = readStoredRecommendations(liveExclusions(db.history()), db.history())
    assert.equal(planned?.items[0].id, wick4.id, 'on the plan is exactly where a next part sits')
    db.dislike(wick4)
    const disliked = readStoredRecommendations(liveExclusions(db.history()), db.history())
    assert.ok(!disliked?.items.some((item) => item.id === wick4.id), 'not interested still wins')
  })

  console.log(`\n${pass} passed`)
}

void main()
