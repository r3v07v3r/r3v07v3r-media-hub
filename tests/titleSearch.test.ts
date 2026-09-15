// Can a search find what the app has?
//
// "Foundation" — a series sitting in the index at rank 243 — came back as
// nothing, because the only place a series search looked was Simkl, whose
// search hits carry no IMDb id and were therefore all dropped. The index
// itself was never asked by name. These tests pin the two halves of the
// replacement: the ranking that one list of hits is built with
// (src/shared/media-hub/titleSearch.ts), and the index's own name search
// (src/main/media-hub/database.ts's indexSearch).
//
// Run with: npx tsx tests/titleSearch.test.ts   (or npm.cmd test)

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase } from '../src/main/media-hub/database'
import {
  CLOSE_MATCH_RANK,
  comparableTitle,
  mergeSearchResults,
  searchTokens,
  titleMatchRank
} from '../src/shared/media-hub/titleSearch'
import type { CatalogItem, MediaKind } from '../src/shared/media-hub/types'

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

function item(id: string, title: string, over: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id,
    title,
    type: 'series',
    poster: '',
    background: '',
    logo: '',
    year: '',
    description: '',
    rating: '',
    runtime: '',
    genres: [],
    videos: [],
    trailers: [],
    ...over
  }
}

const ids = (items: CatalogItem[]): string[] => items.map((x) => x.id)

// ---------------------------------------------------------------------
// 1. The comparable form: what two strings are the same title in.
// ---------------------------------------------------------------------

check('comparableTitle lowercases, folds diacritics and flattens punctuation to spaces', () => {
  assert.equal(comparableTitle('Amélie'), 'amelie')
  assert.equal(comparableTitle('Spider-Man: No Way Home'), 'spider man no way home')
  assert.equal(comparableTitle('  Foundation  '), 'foundation')
  assert.equal(comparableTitle('!!!'), '')
})

check('searchTokens is the words of the comparable form, and nothing for a wordless query', () => {
  assert.deepEqual(searchTokens('Dune: Part Two'), ['dune', 'part', 'two'])
  assert.deepEqual(searchTokens('%'), [])
  assert.deepEqual(searchTokens('_'), [])
  assert.deepEqual(searchTokens(''), [])
})

// ---------------------------------------------------------------------
// 2. The ranking ladder, one rung at a time.
// ---------------------------------------------------------------------

check('exact beats leading beats inner-word beats substring beats scattered beats nothing', () => {
  const q = 'foundation'
  assert.equal(titleMatchRank('Foundation', q), 0)
  assert.equal(titleMatchRank('Foundation: Season One', q), 1)
  assert.equal(titleMatchRank('SCP Foundation', q), 2)
  assert.equal(titleMatchRank('The Foundation', q), 2)
  assert.equal(titleMatchRank('Foundations of Yoga', q), 3)
  assert.equal(titleMatchRank('Wrong Turn', q), 5)
})

check('a word-order-free match ranks below a substring match but above no match', () => {
  assert.equal(titleMatchRank('Dune: Part One', 'part dune'), 4)
  assert.equal(titleMatchRank('Dune: Part One', 'dune part'), 1)
})

check('the ladder ignores case, diacritics and punctuation on both sides', () => {
  assert.equal(titleMatchRank('Amélie', 'amelie'), 0)
  assert.equal(titleMatchRank('Spider-Man', 'spider man'), 0)
  assert.equal(titleMatchRank('spider man', 'Spider-Man'), 0)
})

check('an empty title or query is no match rather than a crash or an exact one', () => {
  assert.equal(titleMatchRank('', 'foundation'), 5)
  assert.equal(titleMatchRank('Foundation', ''), 5)
  assert.equal(titleMatchRank('', ''), 5)
})

check('CLOSE_MATCH_RANK admits the title and its leading form and nothing looser', () => {
  assert.ok(titleMatchRank('Dune', 'Dune') <= CLOSE_MATCH_RANK)
  assert.ok(titleMatchRank('Dune: Part One', 'Dune') <= CLOSE_MATCH_RANK)
  // A model that names "Foundation" must not resolve to a yoga course.
  assert.ok(titleMatchRank('Foundations of Yoga', 'Foundation') > CLOSE_MATCH_RANK)
})

// ---------------------------------------------------------------------
// 3. Merging: one list from several, ranked across them.
// ---------------------------------------------------------------------

check('an exact match from the second source outranks a loose one from the first', () => {
  const first = [item('a', 'Foundations of Yoga'), item('b', 'The Foundation')]
  const second = [item('c', 'Foundation')]
  assert.deepEqual(ids(mergeSearchResults('foundation', [first, second])), ['c', 'b', 'a'])
})

check('equally good matches interleave by position, then fall back to source order', () => {
  const first = [item('a1', 'Foundation A'), item('a2', 'Foundation B')]
  const second = [item('b1', 'Foundation C'), item('b2', 'Foundation D')]
  assert.deepEqual(ids(mergeSearchResults('foundation', [first, second])), ['a1', 'b1', 'a2', 'b2'])
})

check('a title both sources return appears once, as the earlier source’s item', () => {
  const local = [item('tt1', 'Foundation', { genres: ['Sci-Fi'], description: 'Seldon.' })]
  const remote = [item('tt1', 'Foundation')]
  const merged = mergeSearchResults('foundation', [local, remote])
  assert.equal(merged.length, 1)
  assert.deepEqual(merged[0].genres, ['Sci-Fi'])
  assert.equal(merged[0].description, 'Seldon.')
})

check('a duplicate sorts by the best position any source gave it', () => {
  // Locally the title sits third, behind a non-match and another leading
  // match; the provider puts it first. It should lead, and still be the
  // local (richer) item.
  const local = [
    item('z', 'Wrong Turn'),
    item('x', 'Foundation A'),
    item('tt1', 'Foundation C', { description: 'rich' })
  ]
  const remote = [item('tt1', 'Foundation C')]
  const merged = mergeSearchResults('foundation', [local, remote])
  assert.deepEqual(ids(merged), ['tt1', 'x', 'z'])
  assert.equal(merged[0].description, 'rich')
})

check(
  'a duplicate takes the better rank, and the name that earned it, when the sources name it differently',
  () => {
    const local = [item('tt1', 'Sousou no Frieren', { genres: ['Adventure'] })]
    const remote = [item('tt1', "Frieren: Beyond Journey's End"), item('tt2', 'Frieren')]
    const merged = mergeSearchResults('frieren', [local, remote])
    assert.deepEqual(ids(merged), ['tt2', 'tt1'])
    // The label agrees with the rank — which is what resolveSimilarTitles
    // checks a suggested title against — and the rest is still the index row.
    assert.equal(merged[1].title, "Frieren: Beyond Journey's End")
    assert.ok(titleMatchRank(merged[1].title, 'frieren') <= CLOSE_MATCH_RANK)
    assert.deepEqual(merged[1].genres, ['Adventure'])
  }
)

check('a sparse index row gains what the provider hit knew, and keeps what it had', () => {
  const local = [
    item('tt1', 'Foundation', { poster: '', year: '', genres: ['Sci-Fi'], rating: '7.6' })
  ]
  const remote = [
    item('tt1', 'Foundation', {
      poster: 'https://images/poster.jpg',
      year: '2021',
      rating: '1.0',
      genres: ['Wrong'],
      videos: [{ id: 'tt1:1:1', season: 1, episode: 1, title: 'Pilot' } as never]
    })
  ]
  const [merged] = mergeSearchResults('foundation', [local, remote])
  assert.equal(merged.poster, 'https://images/poster.jpg')
  assert.equal(merged.year, '2021')
  assert.equal(merged.videos.length, 1)
  // Present values are never overwritten, only gaps are filled.
  assert.equal(merged.rating, '7.6')
  assert.deepEqual(merged.genres, ['Sci-Fi'])
})

check('idless entries are dropped and the limit is honoured', () => {
  const source = [item('', 'Foundation'), item('a', 'Foundation'), item('b', 'Foundation 2')]
  assert.deepEqual(ids(mergeSearchResults('foundation', [source], 1)), ['a'])
  assert.deepEqual(ids(mergeSearchResults('foundation', [source])), ['a', 'b'])
  assert.deepEqual(ids(mergeSearchResults('foundation', [source], 0)), [])
})

check(
  'non-matching hits are kept, after every match — a provider’s relevance is not thrown away',
  () => {
    const merged = mergeSearchResults('foundation', [
      [item('a', 'Wrong Turn'), item('b', 'Foundation')]
    ])
    assert.deepEqual(ids(merged), ['b', 'a'])
  }
)

// ---------------------------------------------------------------------
// 4. The index's own name search.
// ---------------------------------------------------------------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-title-search-'))
const db = createDatabase(path.join(dir, 'test.sqlite'), 'profile-under-test')

function seed(kind: MediaKind, rows: CatalogItem[]): void {
  assert.ok(db.indexUpsert(kind, rows, { source: 'test' }))
}

seed('series', [
  item('tt9000', 'Foundations of Yoga'),
  item('tt0804484', 'Foundation', { year: '2021', genres: ['Sci-Fi', 'Drama'] }),
  item('tt1512813', 'The Foundation'),
  item('tt3000', 'SCP Foundation'),
  item('tt4000', 'Wrong Turn'),
  item('tt5000', 'Amélie in Paris', { type: 'series' }),
  item('tt6000', 'Yoga & Foundations'),
  item('tt7000', 'A 100% True Story')
])
seed('movie', [item('tt8000', 'The Foundation', { type: 'movie' })])
seed('anime', [item('kitsu:1', 'Frieren: Beyond Journey’s End', { type: 'anime' })])

check('finds a title the index holds, exact match first, every containing title after', () => {
  const found = db.indexSearch('series', 'Foundation')
  assert.equal(found[0].id, 'tt0804484')
  assert.deepEqual(
    ids(found).sort(),
    ['tt0804484', 'tt1512813', 'tt3000', 'tt6000', 'tt9000'].sort()
  )
  assert.ok(!ids(found).includes('tt4000'))
})

check('the index row comes back whole — genres, year and kind included', () => {
  const [top] = db.indexSearch('series', 'foundation')
  assert.equal(top.type, 'series')
  assert.equal(top.year, '2021')
  assert.deepEqual([...top.genres].sort(), ['Drama', 'Sci-Fi'])
})

check('one kind only — the movie called The Foundation is not a series result', () => {
  assert.ok(!ids(db.indexSearch('series', 'foundation')).includes('tt8000'))
  assert.deepEqual(ids(db.indexSearch('movie', 'foundation')), ['tt8000'])
})

check('case and diacritics do not matter', () => {
  assert.deepEqual(
    ids(db.indexSearch('series', 'FOUNDATION')),
    ids(db.indexSearch('series', 'foundation'))
  )
  assert.deepEqual(ids(db.indexSearch('series', 'amelie')), ['tt5000'])
  assert.deepEqual(ids(db.indexSearch('series', 'Amélie')), ['tt5000'])
})

check('every word must appear, in any order', () => {
  assert.deepEqual(ids(db.indexSearch('series', 'yoga foundations')).sort(), ['tt6000', 'tt9000'])
  assert.deepEqual(ids(db.indexSearch('series', 'yoga wrong')), [])
})

check('a leading match outranks an inner one, which outranks a mere substring', () => {
  assert.deepEqual(ids(db.indexSearch('series', 'foundation')), [
    'tt0804484', // exact
    'tt9000', // leading: "foundations of yoga"
    'tt1512813', // inner word: "the foundation"
    'tt3000', // inner word: "scp foundation"
    'tt6000' // inner word: "yoga & foundations" — LIKE '% foundation%' matches the substring too
  ])
})

check('punctuation in the query is not a wildcard and is not a word', () => {
  // "%" alone would match everything as a LIKE pattern; as a query it has
  // no words, so it matches nothing.
  assert.deepEqual(db.indexSearch('series', '%'), [])
  assert.deepEqual(db.indexSearch('series', '_'), [])
  assert.deepEqual(ids(db.indexSearch('series', '100% true')), ['tt7000'])
  assert.deepEqual(ids(db.indexSearch('anime', 'frieren: beyond')), ['kitsu:1'])
})

check('the limit bounds the answer but never drops the best match', () => {
  const found = db.indexSearch('series', 'foundation', 2)
  assert.equal(found.length, 2)
  assert.equal(found[0].id, 'tt0804484')
  assert.deepEqual(db.indexSearch('series', 'foundation', 0), [])
})

check(
  'an exact title survives the candidate limit however many better-ranked rows share its words',
  () => {
    // "Spider-Man" is stored with its hyphen; the query arrives without one.
    // Ranked behind every "Spider Man ..." row in the crawl's order, with a
    // limit smaller than that crowd, it must still be the first candidate —
    // which only holds if the ordering compares like with like (title_key,
    // not title_sort, which keeps the hyphen).
    seed('movie', [
      item('sm1', 'Spider Man Chronicles', { type: 'movie' }),
      item('sm2', 'Spider Man Returns', { type: 'movie' }),
      item('sm3', 'Spider Man Forever', { type: 'movie' })
    ])
    assert.ok(
      db.indexUpsert('movie', [item('tt0145487', 'Spider-Man', { type: 'movie' })], {
        source: 'test',
        rankBase: 500
      })
    )
    const found = db.indexSearch('movie', 'spider man', 2)
    assert.equal(found.length, 2)
    assert.equal(found[0].id, 'tt0145487')
  }
)

check('an index crawled before migration 5 gets its search keys backfilled', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'r3-title-key-')), 'test.sqlite')
  const before = createDatabase(file, 'profile-under-test')
  assert.ok(before.indexUpsert('movie', [item('tt0145487', 'Spider-Man', { type: 'movie' })]))
  before.close()
  // Roll the database back to the version before the key existed, row and
  // all — the state every install that crawled before this migration is in
  // when it next opens.
  const raw = new DatabaseSync(file)
  raw.exec('ALTER TABLE catalog_index DROP COLUMN title_key')
  raw.exec('PRAGMA user_version = 5')
  raw.close()
  const after = createDatabase(file, 'profile-under-test')
  assert.deepEqual(ids(after.indexSearch('movie', 'spider man')), ['tt0145487'])
  after.close()
})

check('the index search survives a bad database rather than throwing into the handler', () => {
  db.close()
  assert.deepEqual(db.indexSearch('series', 'foundation'), [])
})

console.log(`\n${pass} passed${process.exitCode ? ', with failures' : ''}`)
