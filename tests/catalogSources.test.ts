// Unit tests for merging the browse catalog's sources
// (src/main/media-hub/core.ts's mergeCatalogSources).
//
// The movie and series catalogs are now read from Simkl AND Cinemeta
// together, rather than Cinemeta only being consulted when Simkl had
// already failed — Simkl's trending feeds cap out around 600 unique
// titles however they are combined, which is why the library was small.
//
// Reading both together must not cost the guarantee the old conditional
// chain gave for free: one source being unreachable has to cost that
// source's contribution and nothing else.
//
// Run with: npx tsx tests/catalogSources.test.ts   (or npm.cmd test)

import assert from 'node:assert'
import type { CatalogItem } from '../src/shared/media-hub/types'
import { mergeCatalogSources } from '../src/main/media-hub/core'

let pass = 0

function check(name: string, fn: () => void): void {
  try {
    fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

function item(id: string, title = id): CatalogItem {
  return {
    id,
    title,
    type: 'movie',
    poster: '',
    background: '',
    logo: '',
    year: '2024',
    genres: [],
    description: '',
    rating: '',
    runtime: '',
    trailers: [],
    videos: []
  }
}

function ok(pages: CatalogItem[][]): PromiseSettledResult<CatalogItem[][]> {
  return { status: 'fulfilled', value: pages }
}

function failed(message: string): PromiseSettledResult<CatalogItem[][]> {
  return { status: 'rejected', reason: new Error(message) }
}

function ids(items: CatalogItem[]): string[] {
  return items.map((x) => x.id)
}

check('merges every source into one list', () => {
  const merged = mergeCatalogSources([
    ok([[item('tt1'), item('tt2')]]),
    ok([[item('tt3')], [item('tt4')]])
  ])
  assert.deepEqual(ids(merged), ['tt1', 'tt2', 'tt3', 'tt4'])
})

check('source order is the ranking — the first occurrence of an id wins', () => {
  // The same film in both sources keeps its position from the source
  // listed first (Simkl's trending order), not from the deeper catalog.
  const merged = mergeCatalogSources([
    ok([[item('tt1', 'from trending'), item('tt2')]]),
    ok([[item('tt9'), item('tt1', 'from top-rated')]])
  ])
  assert.deepEqual(ids(merged), ['tt1', 'tt2', 'tt9'])
  assert.equal(merged[0].title, 'from trending')
})

check('a failed source costs only its own contribution', () => {
  const merged = mergeCatalogSources([failed('Simkl is unreachable'), ok([[item('tt3')]])])
  assert.deepEqual(ids(merged), ['tt3'], 'the surviving source did not fill the catalog')
})

check('a failed second source leaves the first one intact', () => {
  const merged = mergeCatalogSources([ok([[item('tt1')]]), failed('Cinemeta is unreachable')])
  assert.deepEqual(ids(merged), ['tt1'])
})

check('every source failing yields an empty list, not a throw', () => {
  // catalogData reads an empty result as "fall back to the stale cache,
  // then rethrow" — so this must come back empty rather than escaping as
  // an exception from the merge itself.
  const merged = mergeCatalogSources([failed('down'), failed('also down')])
  assert.deepEqual(merged, [])
})

check('empty pages and entries without an id are dropped', () => {
  // A Cinemeta page past the end of the catalog is a legitimate empty
  // result, not an error, and normalizeMeta can produce an idless entry
  // from a malformed record.
  const merged = mergeCatalogSources([ok([[item('tt1')], [], [item(''), item('tt2')]]), ok([[]])])
  assert.deepEqual(ids(merged), ['tt1', 'tt2'])
})

check('no sources at all is an empty list', () => {
  assert.deepEqual(mergeCatalogSources([]), [])
})

console.log(`\n${pass} passed`)
