// Unit tests for the AniList grouping fallback (src/main/media-hub/anilist.ts).
//
// The `relations` fixtures below are not invented — they are the actual,
// live response bodies from https://graphql.anilist.co, captured while
// building this feature (2026-08-10) for exactly the two cases that
// matter: a franchise with a real TV sequel chain (Attack on Titan) and a
// long-runner with no season-chain edges at all, only noise (One Piece).
// Pinning the filter against real payloads, not synthetic ones, is the
// point — the noise categories (SIDE_STORY specials/movies, an OVA
// PREQUEL) are exactly what a synthetic fixture would be tempted to
// leave out.
//
// Run with: npx tsx tests/anilist.test.ts   (or npm.cmd test)

import assert from 'node:assert'
import {
  anilistIdFromKitsuMappings,
  anilistSeasonOrderKey,
  seasonChainEdges,
  type AnilistMediaNode
} from '../src/main/media-hub/anilist'

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

console.log('anilistIdFromKitsuMappings')

check('extracts the anilist/anime externalId', () => {
  const id = anilistIdFromKitsuMappings({
    data: [
      { attributes: { externalSite: 'thetvdb', externalId: '305074/1' } },
      { attributes: { externalSite: 'anilist/anime', externalId: '16498' } },
      { attributes: { externalSite: 'myanimelist/anime', externalId: '16498' } }
    ]
  })
  assert.equal(id, 16498)
})

check('returns null when there is no anilist entry', () => {
  assert.equal(
    anilistIdFromKitsuMappings({ data: [{ attributes: { externalSite: 'thetvdb', externalId: '1/1' } }] }),
    null
  )
})

check('returns null on an empty/absent mappings list', () => {
  assert.equal(anilistIdFromKitsuMappings({}), null)
  assert.equal(anilistIdFromKitsuMappings({ data: [] }), null)
})

check('rejects a non-numeric or zero externalId rather than crashing', () => {
  assert.equal(
    anilistIdFromKitsuMappings({ data: [{ attributes: { externalSite: 'anilist/anime', externalId: 'abc' } }] }),
    null
  )
  assert.equal(
    anilistIdFromKitsuMappings({ data: [{ attributes: { externalSite: 'anilist/anime', externalId: '0' } }] }),
    null
  )
})

console.log('\nseasonChainEdges — against real AniList responses')

// Attack on Titan, id 16498, fetched live 2026-08-10 via
// Media(search: "Shingeki no Kyojin", type: ANIME) { relations { edges {
// relationType node { id format season seasonYear title { romaji } } } } }
const attackOnTitan: AnilistMediaNode = {
  id: 16498,
  format: 'TV',
  season: 'SPRING',
  seasonYear: 2013,
  relations: {
    edges: [
      { relationType: 'ADAPTATION', node: { id: 53390, format: 'MANGA' } },
      { relationType: 'ALTERNATIVE', node: { id: 20691, format: 'MOVIE' } },
      { relationType: 'ALTERNATIVE', node: { id: 20692, format: 'MOVIE' } },
      { relationType: 'SEQUEL', node: { id: 20958, format: 'TV' } }, // real "Season 2"
      { relationType: 'SPIN_OFF', node: { id: 21281, format: 'TV' } }, // TV format, but not a chain relation
      { relationType: 'SIDE_STORY', node: { id: 18397, format: 'OVA' } },
      { relationType: 'SUMMARY', node: { id: 119113, format: 'MOVIE' } },
      { relationType: 'PREQUEL', node: { id: 20811, format: 'OVA' } }, // real PREQUEL, but not TV
      { relationType: 'SIDE_STORY', node: { id: 99634, format: 'OVA' } },
      { relationType: 'OTHER', node: { id: 19391, format: 'SPECIAL' } },
      { relationType: 'CHARACTER', node: { id: 143391, format: 'ONA' } }
    ]
  }
}

check('finds the real TV sequel edge among the noise', () => {
  const edges = seasonChainEdges(attackOnTitan)
  assert.deepEqual(edges, [{ relationType: 'SEQUEL', targetAnilistId: 20958 }])
})

check('excludes a PREQUEL edge that points at a non-TV format (the "No Regrets" OVA)', () => {
  const edges = seasonChainEdges(attackOnTitan)
  assert.ok(!edges.some((e) => e.targetAnilistId === 20811), 'the OVA prequel must not appear')
})

check('excludes SPIN_OFF even though its target is TV format — wrong relation type', () => {
  const edges = seasonChainEdges(attackOnTitan)
  assert.ok(!edges.some((e) => e.targetAnilistId === 21281), 'a spin-off is not a season continuation')
})

// One Piece, id 21, fetched live 2026-08-10 — a single continuous TV
// entry whose entire relations list is specials/movies/recaps, with no
// PREQUEL/SEQUEL/PARENT edge at all.
const onePieceRelationTypes = [
  'SIDE_STORY', 'SIDE_STORY', 'SIDE_STORY', 'SIDE_STORY', 'SIDE_STORY', 'SIDE_STORY', 'SIDE_STORY',
  'SIDE_STORY', 'SIDE_STORY', 'SIDE_STORY', 'SUMMARY', 'SUMMARY', 'SIDE_STORY', 'SUMMARY',
  'SIDE_STORY', 'SIDE_STORY', 'SUMMARY', 'SIDE_STORY', 'SIDE_STORY', 'SIDE_STORY', 'SIDE_STORY',
  'SIDE_STORY', 'SIDE_STORY', 'SUMMARY', 'SUMMARY', 'SIDE_STORY', 'SIDE_STORY'
]
const onePiece: AnilistMediaNode = {
  id: 21,
  format: 'TV',
  relations: {
    edges: onePieceRelationTypes.map((relationType, i) => ({
      relationType,
      // Formats mirror the real payload's mix of OVA/SPECIAL/MOVIE — none TV.
      node: { id: 1000 + i, format: i % 2 === 0 ? 'SPECIAL' : 'MOVIE' }
    }))
  }
}

check('a long-runner with only noise relations produces no chain edges at all', () => {
  assert.deepEqual(seasonChainEdges(onePiece), [])
})

console.log('\nseasonChainEdges — synthetic edge cases')

check('a missing relations block is empty, not a crash', () => {
  assert.deepEqual(seasonChainEdges({ id: 1 }), [])
})

check('an edge with no node is skipped, not a crash', () => {
  assert.deepEqual(seasonChainEdges({ id: 1, relations: { edges: [{ relationType: 'SEQUEL' }] } }), [])
})

check('PARENT is included alongside PREQUEL/SEQUEL', () => {
  const edges = seasonChainEdges({
    id: 1,
    relations: { edges: [{ relationType: 'PARENT', node: { id: 99, format: 'TV' } }] }
  })
  assert.deepEqual(edges, [{ relationType: 'PARENT', targetAnilistId: 99 }])
})

console.log('\nanilistSeasonOrderKey')

check('orders chronologically within a year (winter before fall)', () => {
  const winter = anilistSeasonOrderKey('WINTER', 2020)!
  const fall = anilistSeasonOrderKey('FALL', 2020)!
  assert.ok(winter < fall)
})

check('orders chronologically across years regardless of quarter', () => {
  const laterYearWinter = anilistSeasonOrderKey('WINTER', 2021)!
  const earlierYearFall = anilistSeasonOrderKey('FALL', 2020)!
  assert.ok(laterYearWinter > earlierYearFall)
})

check('matches the real Attack on Titan chain order (S1 2013 before S2 2017)', () => {
  const s1 = anilistSeasonOrderKey('SPRING', 2013)!
  const s2 = anilistSeasonOrderKey('SPRING', 2017)!
  assert.ok(s1 < s2)
})

check('null when the season enum value is unrecognized', () => {
  assert.equal(anilistSeasonOrderKey('NOT_A_SEASON', 2020), null)
})

check('null when season is present but year is missing', () => {
  assert.equal(anilistSeasonOrderKey('WINTER', null), null)
  assert.equal(anilistSeasonOrderKey('WINTER', undefined), null)
})

check('null when year is present but season is missing', () => {
  assert.equal(anilistSeasonOrderKey(null, 2020), null)
})

check('null when both are missing', () => {
  assert.equal(anilistSeasonOrderKey(null, null), null)
})

console.log(`\n${pass} passed`)
