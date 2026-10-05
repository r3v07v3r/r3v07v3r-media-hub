// Searching what is known about a title, not just its name.
//
// Both functions read the same credits cache and answer deliberately
// different questions, which is the thing worth pinning down: clicking a name
// means THAT name, and typing one means anything containing it. Getting those
// the same way round would make a click on "Ana de Armas" also return every
// title with an "Ana" in the cast.
//
// Also catalog:search's cast and label pass over those rows (searchPool.ts):
// read from the cached catalog blob only, never by crawling, and kept in
// memory until the blob or the credits change.
// Run with: npx tsx tests/creditSearch.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDatabase } from '../src/main/media-hub/database'
import { setDatabase } from '../src/main/media-hub/dbState'
import { enrichCredits, searchCredits, titlesFeaturing } from '../src/main/media-hub/credits'
import { invalidateSearchPool, searchByCredits } from '../src/main/media-hub/searchPool'
import type { CatalogItem, TitleCredits } from '../src/shared/media-hub/types'

// Both functions read through the credits cache, which lives in the database —
// so a real one, seeded the way the enrichment pass seeds it.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-credit-search-'))
const db = createDatabase(path.join(dir, 'test.sqlite'), 'profile-test')
setDatabase(db)

/** Mirrors the key the enrichment pass writes under (see credits.ts). */
function seed(id: string, credits: TitleCredits): void {
  db.putCache(`credits:v1:${id}`, credits, 30 * 24 * 60 * 60 * 1000)
}

seed('tt1', {
  cast: ['Timothée Chalamet', 'Rebecca Ferguson'],
  creators: ['Denis Villeneuve'],
  keywords: ['desert', 'chosen one']
})
seed('tt2', {
  cast: ['Ryan Gosling', 'Ana de Armas'],
  creators: ['Denis Villeneuve'],
  keywords: ['dystopia', 'artificial intelligence']
})
seed('tt3', {
  cast: ['Ryan Gosling'],
  creators: ['Nicolas Winding Refn'],
  keywords: ['driving', 'heist']
})
seed('tt4', { cast: [], creators: [], keywords: [] })

const ids = ['tt1', 'tt2', 'tt3', 'tt4', 'never-enriched']

// ---------------------------------------------------------------------
// Clicking a name: exact, and split by the role people came looking for.
// ---------------------------------------------------------------------
{
  const villeneuve = titlesFeaturing(ids, 'Denis Villeneuve')
  assert.deepEqual(villeneuve.creators.sort(), ['tt1', 'tt2'])
  assert.deepEqual(villeneuve.cast, [])

  const gosling = titlesFeaturing(ids, 'Ryan Gosling')
  assert.deepEqual(gosling.cast.sort(), ['tt2', 'tt3'])

  // Case and surrounding space are not part of a name.
  assert.deepEqual(titlesFeaturing(ids, '  ryan gosling ').cast.sort(), ['tt2', 'tt3'])

  // EXACT, not substring: a click means that person, and a partial match would
  // put every "Ana" in the cast list of somebody who clicked "Ana de Armas".
  assert.deepEqual(titlesFeaturing(ids, 'Ryan').cast, [])
  assert.deepEqual(titlesFeaturing(ids, '').cast, [])
}

// ---------------------------------------------------------------------
// Typing a query: substring, because somebody is part-way through it.
// ---------------------------------------------------------------------
{
  assert.deepEqual(searchCredits(ids, 'villeneuve').people.sort(), ['tt1', 'tt2'])
  assert.deepEqual(searchCredits(ids, 'gosl').people.sort(), ['tt2', 'tt3'])

  // A name match and a label match are separated so the caller can put names
  // first — somebody typing "drive" wants the film before everything tagged
  // "driving".
  const dystopia = searchCredits(ids, 'dystopia')
  assert.deepEqual(dystopia.people, [])
  assert.deepEqual(dystopia.labels, ['tt2'])

  // A title matching on BOTH is counted once, on the stronger signal.
  const gosling = searchCredits(ids, 'gosling')
  assert.ok(gosling.people.includes('tt3'))
  assert.ok(!gosling.labels.includes('tt3'))

  // One character matches most of a catalog and means nothing.
  assert.deepEqual(searchCredits(ids, 'a'), { people: [], labels: [] })
  assert.deepEqual(searchCredits(ids, ' '), { people: [], labels: [] })
}

// ---------------------------------------------------------------------
// Titles with nothing cached contribute nothing rather than throwing.
// ---------------------------------------------------------------------
assert.deepEqual(searchCredits(['never-enriched'], 'anything'), { people: [], labels: [] })
assert.deepEqual(titlesFeaturing(['tt4'], 'Ryan Gosling'), { cast: [], creators: [] })

// ---------------------------------------------------------------------
// catalog:search's cast and label pass (searchPool.ts): the cached blob
// only, never a crawl, and kept in memory until the blob or the credits
// change. It used to await catalogData, which on a cold install or an
// expired blob joined a whole catalogue crawl before the reply could go.
// ---------------------------------------------------------------------
const HOUR = 60 * 60 * 1000
const card = (id: string, title: string): CatalogItem =>
  ({ id, type: 'movie', title, videos: [] }) as unknown as CatalogItem
const idsOf = (items: CatalogItem[]): string[] => items.map((item) => String(item.id))

// Every request this section could make is recorded; the search half must
// make none. The AniList answer is for the enrichment step further down.
const requests: string[] = []
globalThis.fetch = (async (url: string | URL) => {
  requests.push(String(url))
  const body = {
    data: { a0: { tags: [{ name: 'Found family', rank: 90 }], studios: { nodes: [] } } }
  }
  return new Response(JSON.stringify(body), { status: 200 })
}) as typeof fetch

async function poolChecks(): Promise<void> {
  db.putCache(
    'catalog:v2:movie',
    [card('tt1', 'Dune'), card('tt9', 'Bare'), card('tt2', 'BR')],
    HOUR
  )

  // Blob order, names before labels, and the ids already listed skipped.
  assert.deepEqual(idsOf(searchByCredits('movie', 'villeneuve')), ['tt1', 'tt2'])
  assert.deepEqual(idsOf(searchByCredits('movie', 'villeneuve', new Set(['tt1']))), ['tt2'])
  // A title with no credits is never an answer, and is not kept.
  assert.deepEqual(idsOf(searchByCredits('movie', 'bare')), [])

  // No blob at all (a cold install): nothing, at once, and no request.
  assert.deepEqual(searchByCredits('series', 'villeneuve'), [])
  // An expired blob still answers: a search adds what is known, it does
  // not go and find out more.
  db.putCache('catalog:v2:anime', [card('tt3', 'Drive')], -HOUR)
  assert.deepEqual(idsOf(searchByCredits('anime', 'refn')), ['tt3'])
  assert.deepEqual(requests, [], 'the search half made a request')

  // Kept between searches: a blob written behind the pool's back is not
  // re-read until the blob's writer says so (catalog.ts calls this beside
  // both of its writes).
  db.putCache('catalog:v2:movie', [card('tt2', 'BR')], HOUR)
  assert.deepEqual(idsOf(searchByCredits('movie', 'villeneuve')), ['tt1', 'tt2'])
  invalidateSearchPool('movie')
  assert.deepEqual(idsOf(searchByCredits('movie', 'villeneuve')), ['tt2'])

  // A credits write is seen without anybody invalidating: storeCredits moves
  // the version the pool was read at.
  db.putCache('catalog:v2:anime', [card('tt3', 'Drive'), card('kitsu:7', 'Show')], HOUR)
  invalidateSearchPool('anime')
  assert.deepEqual(idsOf(searchByCredits('anime', 'found family')), [])
  db.putCache('kitsu:anilist:7', 123, HOUR)
  assert.equal(await enrichCredits([{ id: 'kitsu:7', type: 'anime' }], 5), 1)
  assert.deepEqual(idsOf(searchByCredits('anime', 'found family')), ['kitsu:7'])

  db.close()
  console.log('credit search tests passed')
}

void poolChecks().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
