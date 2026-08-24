// Unit tests for the anime catalog storage fixes (src/main/media-hub/core.ts's
// normalizeKitsuAnime lightweight mode, animeSeasons.ts's
// combineGroupEpisodeCounts) — from the anime catalog audit: the crawled
// catalog blob was ~59% throwaway placeholder-episode text nothing ever
// reads, and a grouped multi-season anime's browse-grid badge silently
// under-reported to just its first season's own count.
//
// Run with: npx tsx tests/animeCatalogStorage.test.ts   (or npm.cmd test)

import assert from 'node:assert'
import type { CatalogItem, Episode } from '../src/shared/media-hub/types'
import { animeStoryLinks, normalizeKitsuAnime } from '../src/main/media-hub/core'
import { combineGroupEpisodeCounts } from '../src/main/media-hub/animeSeasons'

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

function kitsuRecord(id: string, episodeCount: number) {
  return {
    id,
    attributes: {
      canonicalTitle: `Show ${id}`,
      episodeCount,
      startDate: '2020-01-01',
      genres: ['Action']
    }
  }
}

function anime(
  id: string,
  videos: Episode[],
  episodeCounts?: CatalogItem['episodeCounts']
): CatalogItem {
  return {
    id,
    title: `Show ${id}`,
    type: 'anime',
    poster: '',
    background: '',
    logo: '',
    year: '2020',
    description: '',
    rating: '',
    runtime: '',
    genres: [],
    videos,
    trailers: [],
    ...(episodeCounts ? { episodeCounts } : {})
  }
}

function episodes(count: number): Episode[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `ep${i + 1}`,
    season: 1,
    episode: i + 1,
    number: i + 1,
    title: `Episode ${i + 1}`,
    released: ''
  }))
}

console.log('normalizeKitsuAnime — lightweight mode')

check('default (non-lightweight) keeps the templated id/title, unchanged', () => {
  const item = normalizeKitsuAnime(kitsuRecord('123', 3))
  assert.equal(item.videos[0].id, 'kitsu:123:1:1')
  assert.equal(item.videos[0].title, 'Episode 1')
  assert.equal(item.videos[2].id, 'kitsu:123:1:3')
})

check('lightweight empties id/title but keeps every other field identical', () => {
  const full = normalizeKitsuAnime(kitsuRecord('123', 5))
  const light = normalizeKitsuAnime(kitsuRecord('123', 5), true)
  assert.equal(light.videos.length, full.videos.length, 'same episode count')
  for (let i = 0; i < full.videos.length; i++) {
    assert.equal(light.videos[i].season, full.videos[i].season)
    assert.equal(light.videos[i].episode, full.videos[i].episode)
    assert.equal(light.videos[i].number, full.videos[i].number)
    assert.equal(light.videos[i].released, full.videos[i].released)
    assert.equal(light.videos[i].id, '', `episode ${i + 1} id should be emptied`)
    assert.equal(light.videos[i].title, '', `episode ${i + 1} title should be emptied`)
  }
})

check('lightweight measurably shrinks the serialized payload', () => {
  const full = normalizeKitsuAnime(kitsuRecord('99999', 24))
  const light = normalizeKitsuAnime(kitsuRecord('99999', 24), true)
  const fullBytes = Buffer.byteLength(JSON.stringify(full.videos))
  const lightBytes = Buffer.byteLength(JSON.stringify(light.videos))
  assert.ok(lightBytes < fullBytes, `expected lightweight (${lightBytes}B) < full (${fullBytes}B)`)
})

check('a zero-episode title produces an empty array either way', () => {
  assert.deepEqual(normalizeKitsuAnime(kitsuRecord('1', 0)).videos, [])
  assert.deepEqual(normalizeKitsuAnime(kitsuRecord('1', 0), true).videos, [])
})

console.log('\nanimeStoryLinks')

check('keeps only direct sequel/prequel links and preserves availability status', () => {
  const links = animeStoryLinks({
    data: [
      { attributes: { role: 'sequel' }, relationships: { destination: { data: { id: '2' } } } },
      { attributes: { role: 'prequel' }, relationships: { destination: { data: { id: '3' } } } },
      { attributes: { role: 'spin_off' }, relationships: { destination: { data: { id: '4' } } } },
      { attributes: { role: 'sequel' }, relationships: { destination: { data: { id: '2' } } } }
    ],
    included: [
      { id: '2', type: 'anime', attributes: { canonicalTitle: 'Story After', status: 'upcoming' } },
      { id: '3', type: 'anime', attributes: { canonicalTitle: 'Story Before', status: 'finished' } },
      { id: '4', type: 'anime', attributes: { canonicalTitle: 'Spin-off', status: 'finished' } }
    ]
  })
  assert.deepEqual(
    links.map((link) => [link.relation, link.item.title, link.item.status]),
    [
      ['sequel', 'Story After', 'upcoming'],
      ['prequel', 'Story Before', 'finished']
    ]
  )
})

check(
  'lightweight still preserves real season/episode positions — the exact thing a "Completed" badge is computed from',
  () => {
    // This is the regression an earlier version of this fix would have
    // shipped: emptying the whole array, not just id/title, would have
    // made every anime in the browse grid read as "0 episodes aired."
    const light = normalizeKitsuAnime(kitsuRecord('1', 12), true)
    assert.equal(light.videos.length, 12)
    assert.deepEqual(
      light.videos.map((v) => [v.season, v.episode]),
      Array.from({ length: 12 }, (_, i) => [1, i + 1])
    )
  }
)

console.log('\ncombineGroupEpisodeCounts')

check('a single-member group just reflects that member', () => {
  const result = combineGroupEpisodeCounts([anime('a', episodes(12))])
  assert.deepEqual(result, { totalSeasons: 1, totalEpisodes: 12 })
})

check('sums episode counts across every season, counts seasons by member count', () => {
  const result = combineGroupEpisodeCounts([
    anime('s1', episodes(13)),
    anime('s2', episodes(25)),
    anime('s3', episodes(13))
  ])
  assert.deepEqual(result, { totalSeasons: 3, totalEpisodes: 51 })
})

check("prefers a member's own episodeCounts hint over deriving from videos.length", () => {
  // Exercises the defensive fallback path directly — a member that
  // already carries a combined hint (shouldn't normally happen for a
  // single season, but the reduce must not silently double-count if it
  // ever does).
  const result = combineGroupEpisodeCounts([
    anime('s1', episodes(1), { totalSeasons: 1, totalEpisodes: 999 }),
    anime('s2', episodes(10))
  ])
  assert.equal(result.totalEpisodes, 1009)
})

check('an empty group is zero, not a crash', () => {
  assert.deepEqual(combineGroupEpisodeCounts([]), { totalSeasons: 0, totalEpisodes: 0 })
})

check('matches the real shape a franchise crawl produces (season counts vary per cour)', () => {
  // Modeled on the audit's own real example: Boku no Hero Academia-style,
  // uneven per-season episode counts, several seasons.
  const result = combineGroupEpisodeCounts([
    anime('s1', episodes(13)),
    anime('s2', episodes(25)),
    anime('s3', episodes(25)),
    anime('s4', episodes(25)),
    anime('s5', episodes(25))
  ])
  assert.deepEqual(result, { totalSeasons: 5, totalEpisodes: 113 })
})

console.log(`\n${pass} passed`)
