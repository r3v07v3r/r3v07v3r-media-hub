// The reason a suggestion gives for itself.
//
// Two things are being pinned here. First, that the label always names
// real evidence — the failure this replaces was a renderer-side string
// saying "Popular right now" over a figure nothing had measured. Second,
// that the reason the ranker emits is the signal that actually put the
// title where it is, since a reason derived from anything else is a second
// opinion about an ordering it did not produce.

import assert from 'node:assert/strict'

import { rankPersonalizedRecommendationsScored } from '../src/shared/media-hub/catalog-logic'
import { recommendationReasonLabel } from '../src/shared/media-hub/recommendationReason'
import type { CatalogItem, HistoryEntry } from '../src/shared/media-hub/types'

// ---------------------------------------------------------------------
// Labels.
// ---------------------------------------------------------------------
assert.equal(
  recommendationReasonLabel({ kind: 'continues', detail: 'Dune' }),
  'Because you watched Dune'
)
assert.equal(
  recommendationReasonLabel({ kind: 'creator', detail: 'Denis Villeneuve' }),
  'From Denis Villeneuve'
)
assert.equal(recommendationReasonLabel({ kind: 'cast', detail: 'Zendaya' }), 'With Zendaya')
assert.equal(recommendationReasonLabel({ kind: 'genre', detail: 'Sci-Fi' }), 'More Sci-Fi')
assert.equal(recommendationReasonLabel({ kind: 'new', detail: '2026' }), 'New in 2026')

// No evidence, no chip — an empty string, which callers render as nothing
// at all rather than as an empty pill.
assert.equal(recommendationReasonLabel(undefined), '')
assert.equal(recommendationReasonLabel({ kind: 'genre', detail: '   ' }), '')

// ---------------------------------------------------------------------
// What the ranker actually attributes.
// ---------------------------------------------------------------------
function item(over: Partial<CatalogItem> & Pick<CatalogItem, 'id' | 'title'>): CatalogItem {
  return {
    type: 'movie',
    poster: '',
    background: '',
    logo: '',
    year: '2000',
    description: '',
    rating: '0',
    runtime: '',
    genres: [],
    videos: [],
    trailers: [],
    ...over
  } as CatalogItem
}

function watched(over: Partial<HistoryEntry> & Pick<HistoryEntry, 'id' | 'title'>): HistoryEntry {
  return { type: 'movie', year: '2021', watchedAt: '2026-01-01T00:00:00Z', ...over } as HistoryEntry
}

const thisYear = new Date().getFullYear()

{
  // A franchise continuation names the title it follows. This is the
  // strongest signal in the ranking by a wide margin, so it is the one most
  // often asked to explain itself — and "because you watched something"
  // would be no explanation at all.
  const ranked = rankPersonalizedRecommendationsScored(
    [item({ id: 'b', title: 'Dune Part Two', year: '2024' })],
    { history: [watched({ id: 'a', title: 'Dune', year: '2021' })], now: new Date('2026-06-01') }
  )
  assert.deepEqual(ranked[0].reason, { kind: 'continues', detail: 'Dune' })
}

{
  // A genre match names the genre, spelled as the CATALOG spells it, not
  // as the affinity comparison lowercased it.
  const ranked = rankPersonalizedRecommendationsScored(
    [item({ id: 'c', title: 'Solaris', genres: ['Sci-Fi'] })],
    { history: [], preferredGenres: ['sci-fi'], now: new Date('2026-06-01') }
  )
  assert.deepEqual(ranked[0].reason, { kind: 'genre', detail: 'Sci-Fi' })
}

{
  // A title nothing about this person picked out gets NO reason. Its card
  // shows no chip, rather than a chip that says nothing.
  const ranked = rankPersonalizedRecommendationsScored(
    [item({ id: 'd', title: 'Whatever', year: '1994', rating: '9' })],
    { history: [], now: new Date('2026-06-01') }
  )
  assert.equal(ranked[0].reason, undefined)
}

{
  // The year is the fallback signal, and it is the year itself — a list
  // read in January is largely last year's releases, which "new this year"
  // would misreport.
  const ranked = rankPersonalizedRecommendationsScored(
    [item({ id: 'e', title: 'Fresh', year: String(thisYear) })],
    { history: [], now: new Date() }
  )
  assert.deepEqual(ranked[0].reason, { kind: 'new', detail: String(thisYear) })
}

{
  // The strongest contribution wins, not the first one found: a genre
  // match (12) outweighs a last-year release (8) on the same title.
  const ranked = rankPersonalizedRecommendationsScored(
    [item({ id: 'f', title: 'Both', year: String(thisYear - 1), genres: ['Horror'] })],
    { history: [], preferredGenres: ['horror'], now: new Date() }
  )
  assert.deepEqual(ranked[0].reason, { kind: 'genre', detail: 'Horror' })
}

console.log('recommendation reason tests passed')
