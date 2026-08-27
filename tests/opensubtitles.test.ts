// Unit tests for the OpenSubtitles query builder and result normalizer
// (src/main/media-hub/opensubtitles.ts). opensubtitles.ts is deliberately
// electron-free — it only touches SubtitleResult's shape — so it imports
// directly under plain tsx, the same reasoning subdl.test.ts documents for
// its own module.

import assert from 'node:assert/strict'

import { buildSearchParams, normalizeSubtitleResult } from '../src/main/media-hub/opensubtitles'

// ---------------------------------------------------------------------
// What identifies the title.
// ---------------------------------------------------------------------
assert.deepEqual(buildSearchParams({ id: 'tt1160419', type: 'movie', title: 'Dune' }, {}), {
  languages: 'en',
  imdb_id: '1160419'
})

// Anime is Kitsu-identified, and Kitsu ids are not IMDb ids even when they
// happen to look numeric — falls back to a title query, the same line every
// other IMDb-keyed feature in this app draws.
assert.deepEqual(buildSearchParams({ id: 'kitsu:12345', type: 'anime', title: 'Frieren' }, {}), {
  languages: 'en',
  query: 'Frieren'
})

// A series carries season/episode; a movie never does, even if playback
// happens to have stray values in it.
assert.deepEqual(
  buildSearchParams(
    { id: 'tt11280740', type: 'series', title: 'Severance' },
    { season: 2, episode: 7 }
  ),
  { languages: 'en', imdb_id: '11280740', season_number: 2, episode_number: 7 }
)
assert.deepEqual(
  buildSearchParams({ id: 'tt1160419', type: 'movie', title: 'Dune' }, { season: 1, episode: 1 }),
  { languages: 'en', imdb_id: '1160419' }
)

// ---------------------------------------------------------------------
// The hash. Sent ALONGSIDE the id, never instead of it — a hash miss (a
// re-encode, a release nobody has hashed yet) must still fall back to the
// ordinary title search rather than returning nothing.
// ---------------------------------------------------------------------
assert.deepEqual(
  buildSearchParams(
    { id: 'tt1160419', type: 'movie', title: 'Dune' },
    { movieHash: 'abc123', movieBytes: 12909756 }
  ),
  { languages: 'en', imdb_id: '1160419', moviehash: 'abc123', moviebytesize: 12909756 }
)

// No hash computed (the ordinary case — see movieHash.ts) adds nothing to
// the query rather than sending an empty or undefined value.
assert.deepEqual(
  buildSearchParams({ id: 'tt1160419', type: 'movie', title: 'Dune' }, { movieHash: undefined }),
  { languages: 'en', imdb_id: '1160419' }
)

// ---------------------------------------------------------------------
// Reading the response back.
// ---------------------------------------------------------------------
const row = normalizeSubtitleResult({
  id: '9001',
  attributes: {
    files: [{ file_id: 555, file_name: 'dune.2021.srt' }],
    language: 'en',
    release: 'Dune.2021.1080p',
    download_count: 42,
    uploader: { name: 'someone' },
    hearing_impaired: false,
    moviehash_match: true
  }
})
assert.equal(row.hashMatch, true)
assert.equal(row.fileId, 555)

// Absent entirely when the search carried no hash — this is the ordinary
// shape for every search this app has ever done before today, and it must
// read as "not a hash match", not crash on a missing field.
const rowWithoutHash = normalizeSubtitleResult({
  id: '9002',
  attributes: { files: [{ file_id: 556 }], language: 'en' }
})
assert.equal(rowWithoutHash.hashMatch, false)

console.log('opensubtitles tests passed')
