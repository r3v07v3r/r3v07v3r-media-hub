// The one translation in stage 3 that could quietly lie: filter-bar
// state → CatalogQuery.
//
// CatalogQuery was SHAPED so this mapping is field-for-field (its doc
// comment says so), and the mapping must honour that: any cleverness —
// defaulting a null, reinterpreting a bucket, dropping a hide-flag —
// recreates exactly the translation-layer drift the shape exists to
// prevent. The hide-flags are the ones with teeth: applied by the query
// they keep pages full-sized and `total` honest; lost here, the backend
// returns rows the client then re-filters, pages shrink unpredictably,
// and the count stops describing what the person is looking at — the
// failure mode CatalogQuery's own comment documents.

import assert from 'node:assert/strict'

import {
  DEFAULT_FILTER_STATE,
  filterStateToCatalogQuery,
  type CategoryFilterState
} from '../src/renderer/src/lib/mediaHub/categoryFilters'

// --- every field crosses, verbatim ------------------------------------------

{
  const filters: CategoryFilterState = {
    genre: 'Horror',
    year: '2023',
    minRating: 7.5,
    runtimeBucket: 'under-90',
    seasonsBucket: '2-3',
    episodeLengthBucket: 'standard',
    episodesBucket: '13-26',
    status: 'ongoing',
    hideWatched: true,
    hideCompleted: false,
    hideDisliked: true,
    sort: 'rating-desc'
  }
  const query = filterStateToCatalogQuery('anime', filters, { offset: 120, limit: 60 })
  assert.deepEqual(query, {
    kind: 'anime',
    genre: 'Horror',
    year: '2023',
    minRating: 7.5,
    runtimeBucket: 'under-90',
    seasonsBucket: '2-3',
    episodeLengthBucket: 'standard',
    episodesBucket: '13-26',
    status: 'ongoing',
    hideWatched: true,
    hideCompleted: false,
    hideDisliked: true,
    sort: 'rating-desc',
    offset: 120,
    limit: 60
  })
}

// --- null stays null, buckets stay verbatim ---------------------------------
//
// A null is "not filtering on this"; a bucket value the backend no longer
// knows must reach it VERBATIM so it matches nothing — a stale bookmark
// showing an empty grid is honest, the same bookmark silently showing
// everything is not. Both properties die if the mapping "helps".

{
  const query = filterStateToCatalogQuery('movie', DEFAULT_FILTER_STATE, {
    offset: 0,
    limit: 60
  })
  assert.equal(query.genre, null, 'null genre crosses as null, not as a default')
  assert.equal(query.minRating, null)
  assert.equal(query.sort, 'trending', 'the default sort crosses like any other value')

  const stale = filterStateToCatalogQuery(
    'movie',
    { ...DEFAULT_FILTER_STATE, runtimeBucket: 'a-bucket-from-2019' },
    { offset: 0, limit: 60 }
  )
  assert.equal(
    stale.runtimeBucket,
    'a-bucket-from-2019',
    'an unknown bucket passes verbatim — matching nothing is the backend’s call'
  )
}

// --- the hide-flags cross, all three, both polarities ------------------------

{
  for (const flag of ['hideWatched', 'hideCompleted', 'hideDisliked'] as const) {
    for (const value of [true, false]) {
      const query = filterStateToCatalogQuery(
        'series',
        { ...DEFAULT_FILTER_STATE, [flag]: value },
        { offset: 0, limit: 60 }
      )
      assert.equal(
        query[flag],
        value,
        `${flag}=${value} must reach the query — client-side re-filtering shrinks pages`
      )
    }
  }
}

console.log('ok  category filter → catalog query mapping')
