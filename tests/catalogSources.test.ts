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
import { mergeCatalogSources, normalizeMeta } from '../src/main/media-hub/core'

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

// --- normalizeMeta's crawl-path `lightweight` flag ---
//
// The browse catalog is one cache row and one IPC payload per kind, and
// Cinemeta ships a full synopsis plus a thumbnail URL for EVERY episode of
// every series in it. None of that is ever read from a catalog entry, so
// the crawl drops it. What must survive is the episode POSITIONS: the
// browse grid's season/episode counts and its "Completed" badge are
// derived from them (adapters.ts), and emptying the array is a regression
// that has already been shipped once on the anime side.

const rawSeriesMeta = {
  id: 'tt100',
  name: 'Example',
  type: 'series',
  videos: [
    {
      id: 'tt100:1:1',
      season: 1,
      number: 1,
      name: 'Pilot',
      overview: 'A long synopsis nothing in the browse grid ever shows.',
      thumbnail: 'https://episodes.metahub.space/tt100/1/1/w780.jpg',
      released: '2024-01-01T00:00:00.000Z'
    },
    { id: 'tt100:2:3', season: 2, number: 3, name: 'Later', overview: 'More prose.' }
  ]
}

check('lightweight keeps every episode position intact', () => {
  const light = normalizeMeta(rawSeriesMeta, 'series', true)
  assert.equal(light.videos.length, 2, 'the episode list was shortened')
  assert.deepEqual(
    light.videos.map((v) => [v.season, v.episode, v.number]),
    [
      [1, 1, 1],
      [2, 3, 3]
    ],
    'season/episode positions must survive — the completed badge is derived from them'
  )
  assert.deepEqual(
    light.videos.map((v) => v.id),
    ['tt100:1:1', 'tt100:2:3'],
    'episode ids are the badge/watch-history join key'
  )
  assert.equal(light.videos[0].released, '2024-01-01T00:00:00.000Z', 'aired-date filter needs this')
})

check('lightweight drops the per-episode prose', () => {
  const light = normalizeMeta(rawSeriesMeta, 'series', true)
  for (const v of light.videos) {
    assert.equal(v.title, '', 'episode title should be blank on a crawl path')
    assert.equal(v.description, '', 'episode synopsis should be blank on a crawl path')
    assert.equal(v.thumbnail, '', 'episode thumbnail should be blank on a crawl path')
  }
})

check('the per-title path is untouched by default', () => {
  // metadata()'s own fetch calls normalizeMeta unflagged, and the detail
  // page's episode list comes from THAT — so the full text has to survive
  // there or every episode row goes blank.
  const full = normalizeMeta(rawSeriesMeta, 'series')
  assert.equal(full.videos[0].title, 'Pilot')
  assert.equal(full.videos[0].description, 'A long synopsis nothing in the browse grid ever shows.')
  assert.equal(full.videos[0].thumbnail, 'https://episodes.metahub.space/tt100/1/1/w780.jpg')
  assert.equal(full.videos[1].title, 'Later')
})

check('lightweight leaves the title-level fields alone', () => {
  // Only the per-episode fields are dropped. The entry's OWN description is
  // what the browse grid and hero render.
  const light = normalizeMeta(
    { ...rawSeriesMeta, description: 'Show synopsis.', poster: 'p.jpg' },
    'series',
    true
  )
  assert.equal(light.description, 'Show synopsis.')
  assert.equal(light.poster, 'p.jpg')
  assert.equal(light.title, 'Example')
})

check('a movie with no videos is unaffected either way', () => {
  const raw = { id: 'tt200', name: 'Film', type: 'movie' }
  assert.deepEqual(normalizeMeta(raw, 'movie', true).videos, [])
  assert.deepEqual(normalizeMeta(raw, 'movie').videos, [])
})

// --- coalescing a duplicate instead of dropping it ---
//
// Measured live: 546 of Cinemeta's 1,999 series also appear in Simkl's
// trending feeds. Simkl is read first because its order is the ranking, and
// a Simkl entry carries `videos: []`. Dropping the Cinemeta duplicate threw
// away the episode list for those 546 — the most popular titles, the top of
// the grid — so they showed no season/episode counts and could never earn a
// Completed badge. The data that answers both had been discarded on the way
// in.

function withFields(id: string, over: Partial<CatalogItem>): CatalogItem {
  return { ...item(id), ...over }
}

function rich(id: string, over: Partial<CatalogItem> = {}): CatalogItem {
  return {
    ...item(id),
    poster: 'p.jpg',
    description: 'A show.',
    videos: [{ id: `${id}:1:1`, season: 1, episode: 1, number: 1, title: 'Pilot', released: '' }],
    genres: ['Drama'],
    ...over
  }
}

check('a duplicate fills the gaps in the first occurrence', () => {
  // Simkl first (ranking, no episodes), Cinemeta second (episodes, no simklId).
  const simkl = withFields('tt1', { simklId: 42, poster: 'simkl.jpg' })
  const cinemeta = rich('tt1')
  const merged = mergeCatalogSources([ok([[simkl]]), ok([[cinemeta]])])
  assert.equal(merged.length, 1, 'still one entry per title')
  assert.equal(merged[0].videos.length, 1, 'the episode list survives the merge')
  assert.equal(merged[0].simklId, 42, "and so does the first source's own id")
  assert.deepEqual(merged[0].genres, ['Drama'])
  assert.equal(merged[0].description, 'A show.')
})

check('the first occurrence wins any field both sources have', () => {
  // Only gaps are filled. The first source keeps what it actually said, or
  // the merge would silently re-rank and re-describe the catalog by
  // whichever source happened to be read last.
  const merged = mergeCatalogSources([
    ok([[withFields('tt1', { poster: 'first.jpg', rating: '9.0' })]]),
    ok([[withFields('tt1', { poster: 'second.jpg', rating: '1.0' })]])
  ])
  assert.equal(merged[0].poster, 'first.jpg')
  assert.equal(merged[0].rating, '9.0')
})

check('coalescing does not change the ranking', () => {
  // The property the old dedupe guaranteed and this must not lose: source
  // order is the ranking, and a title in both keeps its FIRST position.
  const merged = mergeCatalogSources([
    ok([[item('tt1'), item('tt2')]]),
    ok([[item('tt3'), rich('tt1')]])
  ])
  assert.deepEqual(ids(merged), ['tt1', 'tt2', 'tt3'], 'tt1 keeps its leading position')
})

check('an empty value counts as missing, a real one does not', () => {
  // `videos: []` and `poster: ''` are how a normalizer says "this source has
  // none" — not "this source says there are none".
  const merged = mergeCatalogSources([
    ok([[withFields('tt1', { poster: '', videos: [] })]]),
    ok([[rich('tt1')]])
  ])
  assert.equal(merged[0].poster, 'p.jpg')
  assert.equal(merged[0].videos.length, 1)
})

check('episodeCounts and groupedIds fill in too', () => {
  // A grouped anime's combined totals are the browse grid's only correct
  // season/episode source for it — losing them under-reports the franchise.
  const merged = mergeCatalogSources([
    ok([[item('kitsu:1')]]),
    ok([
      [
        withFields('kitsu:1', {
          groupedIds: ['kitsu:2'],
          episodeCounts: { totalSeasons: 4, totalEpisodes: 97 }
        })
      ]
    ])
  ])
  assert.deepEqual(merged[0].groupedIds, ['kitsu:2'])
  assert.deepEqual(merged[0].episodeCounts, { totalSeasons: 4, totalEpisodes: 97 })
})

check('three sources coalesce into one entry', () => {
  const merged = mergeCatalogSources([
    ok([[withFields('tt1', { simklId: 7 })]]),
    ok([[withFields('tt1', { poster: 'p.jpg' })]]),
    ok([[withFields('tt1', { description: 'D' })]])
  ])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].simklId, 7)
  assert.equal(merged[0].poster, 'p.jpg')
  assert.equal(merged[0].description, 'D')
})

check('a failed source still costs only its own contribution', () => {
  // The negative property the old chain gave for free, re-asserted against
  // the new implementation rather than assumed to have survived it.
  const merged = mergeCatalogSources([failed('Simkl is down'), ok([[rich('tt1')]])])
  assert.deepEqual(ids(merged), ['tt1'])
  assert.equal(merged[0].videos.length, 1)
})

console.log(`\n${pass} passed`)
