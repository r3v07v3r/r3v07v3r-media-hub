// The ranking shelved by reason (groupRecommendationRails), and the floor
// that decides whether a stored ranking is still worth serving
// (enoughStoredRecommendations). Both in src/shared/media-hub/catalog-logic.ts.
// Run with: npx tsx tests/recommendationRails.test.ts

import assert from 'node:assert/strict'

import {
  enoughStoredRecommendations,
  groupRecommendationRails,
  type ScoredRecommendation
} from '../src/shared/media-hub/catalog-logic'
import type { CatalogItem, RecommendationReason } from '../src/shared/media-hub/types'

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

function title(id: string): CatalogItem {
  return {
    id,
    title: id,
    year: '2024',
    rating: '7',
    genres: [],
    type: 'movie',
    poster: '',
    background: '',
    logo: '',
    description: ''
  } as CatalogItem
}

function entry(id: string, reason?: RecommendationReason, score = 10): ScoredRecommendation {
  return reason ? { item: title(id), score, reason } : { item: title(id), score }
}

const dune = (id: string) => entry(id, { kind: 'continues', detail: 'Dune' })
const zendaya = (id: string) => entry(id, { kind: 'cast', detail: 'Zendaya' })
const scifi = (id: string) => entry(id, { kind: 'genre', detail: 'Sci-Fi' })
const fresh = (id: string) => entry(id, { kind: 'new', detail: '2026' })

console.log('groupRecommendationRails')

check('shelves by kind AND detail, keeping the ranking order', () => {
  const rails = groupRecommendationRails(
    [zendaya('z1'), dune('d1'), zendaya('z2'), dune('d2'), zendaya('z3'), dune('d3')],
    { minItems: 3 }
  )
  assert.deepEqual(
    rails.map((rail) => [rail.id, rail.items.map((item) => item.id)]),
    [
      ['continues:Dune', ['d1', 'd2', 'd3']],
      ['cast:Zendaya', ['z1', 'z2', 'z3']]
    ],
    'continues leads cast whatever ranked first; each shelf keeps rank order'
  )
})

check('a shelf below the minimum is not a shelf', () => {
  const rails = groupRecommendationRails([dune('d1'), dune('d2'), zendaya('z1')], { minItems: 2 })
  assert.deepEqual(
    rails.map((rail) => rail.id),
    ['continues:Dune']
  )
})

check('entries without a reason shelve nowhere', () => {
  const rails = groupRecommendationRails([entry('plain'), dune('d1'), dune('d2')], { minItems: 2 })
  assert.equal(rails.length, 1)
  assert.deepEqual(
    rails[0].items.map((item) => item.id),
    ['d1', 'd2']
  )
})

check('a shelf is capped and the shelf count is capped', () => {
  const many = Array.from({ length: 30 }, (_, i) => dune(`d${i}`))
  const rails = groupRecommendationRails(many, { maxItems: 5 })
  assert.equal(rails[0].items.length, 5)
  const kinds = Array.from({ length: 10 }, (_, i) =>
    Array.from({ length: 4 }, (_, j) => entry(`g${i}-${j}`, { kind: 'genre', detail: `G${i}` }))
  ).flat()
  assert.equal(groupRecommendationRails(kinds, { maxRails: 3 }).length, 3)
})

check('same kind: the shelf whose best title ranked higher comes first', () => {
  const rails = groupRecommendationRails(
    [
      scifi('s1'),
      fresh('n1'),
      entry('a1', { kind: 'genre', detail: 'Action' }),
      scifi('s2'),
      entry('a2', { kind: 'genre', detail: 'Action' }),
      fresh('n2')
    ],
    { minItems: 2 }
  )
  assert.deepEqual(
    rails.map((rail) => rail.id),
    ['genre:Sci-Fi', 'genre:Action', 'new:2026']
  )
})

check('the reason is carried whole, so the label can be worded on the other side', () => {
  const [rail] = groupRecommendationRails([dune('d1'), dune('d2')], { minItems: 2 })
  assert.deepEqual(rail.reason, { kind: 'continues', detail: 'Dune' })
})

console.log('\nenoughStoredRecommendations')

check('a store that could fill the row must fill it', () => {
  assert.equal(enoughStoredRecommendations(150, 36, 36), true)
  assert.equal(enoughStoredRecommendations(150, 35, 36), false)
  assert.equal(enoughStoredRecommendations(38, 35, 36), false, 'one short is still short')
  assert.equal(enoughStoredRecommendations(36, 36, 36), true)
})

check('a small library is judged against what it held', () => {
  assert.equal(enoughStoredRecommendations(20, 10, 36), true, 'half of twenty survives')
  assert.equal(enoughStoredRecommendations(20, 9, 36), false)
  assert.equal(enoughStoredRecommendations(1, 1, 36), true)
})

check('an empty store never suffices', () => {
  assert.equal(enoughStoredRecommendations(0, 0, 36), false)
})

console.log(`\n${pass} passed`)
