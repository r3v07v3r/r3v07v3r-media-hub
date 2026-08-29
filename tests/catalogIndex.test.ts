// Unit tests for the accumulating title index
// (src/main/media-hub/database.ts's indexUpsert/indexCount/indexList).
//
// The catalog this replaces was ONE cache row per kind — a JSON blob holding
// the whole crawl, rewritten wholesale every six hours. That shape is what
// capped the library at a couple of thousand titles, and it had a second
// property nobody chose: a refresh REPLACED it, so a title that fell out of
// Cinemeta's top window fell out of the library with it.
//
// So the behaviour worth pinning down here is not "rows can be written" —
// it is everything about a SECOND crawl. Does it keep what the first one
// found? Does it keep the day the title was first seen? Can a source that
// carries fewer fields erase what a richer source already stored? Those are
// the ways an accumulating index quietly stops accumulating.
//
// Run with: npx tsx tests/catalogIndex.test.ts   (or npm.cmd test)

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase } from '../src/main/media-hub/database'
import type { CatalogItem } from '../src/shared/media-hub/types'

const TEST_PROFILE = 'profile-under-test'

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

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-index-test-'))
  return path.join(dir, 'test.sqlite')
}

function item(id: string, over: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id,
    title: id,
    type: 'movie',
    poster: '',
    background: '',
    logo: '',
    year: '',
    status: '',
    description: '',
    rating: '',
    runtime: '',
    genres: [],
    videos: [],
    trailers: [],
    ...over
  }
}

/** Reads the raw row, for the columns indexList deliberately does not expose. */
function raw(dbPath: string, id: string): Record<string, unknown> | undefined {
  const sql = new DatabaseSync(dbPath)
  try {
    return sql.prepare('SELECT * FROM catalog_index WHERE id=?').get(id) as
      | Record<string, unknown>
      | undefined
  } finally {
    sql.close()
  }
}

// --- accumulation: the whole reason the table exists --------------------

check('a later crawl does not delete what an earlier one found', () => {
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath, TEST_PROFILE)
  db.indexUpsert('movie', [item('tt1'), item('tt2'), item('tt3')])
  // The second crawl sees only one of them — exactly what happens when a
  // title drops out of Cinemeta's trending window.
  db.indexUpsert('movie', [item('tt2')])
  assert.equal(db.indexCount('movie'), 3, 'titles absent from a later crawl must survive it')
  db.close()
})

check('first_seen survives a re-crawl; updated_at moves', () => {
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath, TEST_PROFILE)
  db.indexUpsert('movie', [item('tt1')], { now: 1_000 })
  db.indexUpsert('movie', [item('tt1')], { now: 2_000 })
  const row = raw(dbPath, 'tt1')
  assert.equal(row?.first_seen, 1_000, 'first_seen is the one column a re-crawl must never touch')
  assert.equal(row?.updated_at, 2_000, 'updated_at tracks the most recent sighting')
  db.close()
})

check('a blank field never overwrites a populated one', () => {
  // The same title arrives from more than one source and they do not carry
  // the same fields — a Simkl entry has no logo, a Cinemeta one has no
  // simklId. Whichever is written second must not erase the other's work.
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath, TEST_PROFILE)
  db.indexUpsert('movie', [
    item('tt1', { poster: 'p.jpg', logo: 'l.png', description: 'A film.', rating: '8.4' })
  ])
  db.indexUpsert('movie', [item('tt1', { poster: '', logo: '', description: '', rating: '' })])
  const [row] = db.indexList('movie', 10)
  assert.equal(row.poster, 'p.jpg')
  assert.equal(row.logo, 'l.png')
  assert.equal(row.description, 'A film.')
  assert.equal(row.rating, '8.4')
  db.close()
})

check('a populated field does overwrite a blank one', () => {
  // The converse has to hold too, or the index could never be enriched.
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath, TEST_PROFILE)
  db.indexUpsert('movie', [item('tt1')])
  db.indexUpsert('movie', [item('tt1', { poster: 'p.jpg', year: '1999' })])
  const [row] = db.indexList('movie', 10)
  assert.equal(row.poster, 'p.jpg')
  assert.equal(row.year, '1999')
  db.close()
})

// --- kinds are separate namespaces --------------------------------------

check('the same id can be a movie and a series at once', () => {
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath, TEST_PROFILE)
  db.indexUpsert('movie', [item('tt1', { title: 'As a film' })])
  db.indexUpsert('series', [item('tt1', { type: 'series', title: 'As a show' })])
  assert.equal(db.indexCount('movie'), 1)
  assert.equal(db.indexCount('series'), 1)
  assert.equal(db.indexList('movie', 10)[0].title, 'As a film')
  assert.equal(db.indexList('series', 10)[0].title, 'As a show')
  db.close()
})

// --- typed columns ------------------------------------------------------

check('stringly-typed fields are stored as numbers', () => {
  // A range filter over TEXT is a string comparison, which is how
  // "rating >= 9" starts matching "10". These must be real numbers.
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath, TEST_PROFILE)
  db.indexUpsert('movie', [item('tt1', { year: '1999', rating: '8.4', runtime: '142 min' })])
  const row = raw(dbPath, 'tt1')
  assert.equal(row?.year, 1999)
  assert.equal(row?.rating, 8.4)
  assert.equal(row?.runtime_min, 142, '"142 min" must parse to 142, not NaN')
  db.close()
})

check('unparseable fields are null, not zero', () => {
  // "unknown year" and "year 0" are different answers, and a filter must be
  // able to tell them apart.
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath, TEST_PROFILE)
  db.indexUpsert('movie', [item('tt1', { year: '', rating: 'N/A', runtime: '' })])
  const row = raw(dbPath, 'tt1')
  assert.equal(row?.year, null)
  assert.equal(row?.rating, null)
  assert.equal(row?.runtime_min, null)
  db.close()
})

check('title_sort folds diacritics so byte order lands where localeCompare does', () => {
  // Byte order puts "Pokémon" after "Pz"; localeCompare files it under
  // "Poke". Since SQLite has no locale-aware collation, the sort key is what
  // has to carry the equivalence. Measured over the real catalog, this takes
  // the disagreement with localeCompare from 0.019% of pairs to none.
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath, TEST_PROFILE)
  db.indexUpsert('series', [
    item('a', { type: 'series', title: 'Pokémon' }),
    item('b', { type: 'series', title: 'Portlandia' }),
    item('c', { type: 'series', title: 'Pz Show' })
  ])
  assert.deepEqual(
    db.indexQuery({ kind: 'series', sort: 'title-asc' }).items.map((x) => x.title),
    ['Pokémon', 'Portlandia', 'Pz Show'],
    'the accented title sorts by its base letters, not after every ASCII one'
  )
  assert.equal(raw(dbPath, 'a')?.title_sort, 'pokemon')
  db.close()
})

check('title_sort is lowercased and NOT article-stripped', () => {
  // The sort being reproduced is title.localeCompare(title), which files
  // "The Matrix" under T. Stripping articles here would change what the A-Z
  // sort means as a side effect of moving it into SQL.
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath, TEST_PROFILE)
  db.indexUpsert('movie', [item('tt1', { title: 'The Matrix' })])
  assert.equal(raw(dbPath, 'tt1')?.title_sort, 'the matrix')
  db.close()
})

// --- episode counts replace episode positions ---------------------------

check('episode counts are derived from videos when no override is given', () => {
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath, TEST_PROFILE)
  const videos = [
    { id: 'a', season: 1, episode: 1, number: 1, title: '', released: '' },
    { id: 'b', season: 1, episode: 2, number: 2, title: '', released: '' },
    { id: 'c', season: 2, episode: 1, number: 1, title: '', released: '' }
  ]
  db.indexUpsert('series', [item('tt1', { type: 'series', videos })])
  const [row] = db.indexList('series', 10)
  assert.deepEqual(row.episodeCounts, { totalSeasons: 2, totalEpisodes: 3 })
  assert.deepEqual(row.videos, [], 'the index stores no per-episode data')
  db.close()
})

check("a normalizer's own episodeCounts wins over deriving from videos", () => {
  // A grouped anime's `videos` only ever covers its first season, so
  // deriving from it would under-report the whole franchise.
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath, TEST_PROFILE)
  db.indexUpsert('anime', [
    item('kitsu:1', {
      type: 'anime',
      videos: [{ id: 'a', season: 1, episode: 1, number: 1, title: '', released: '' }],
      episodeCounts: { totalSeasons: 4, totalEpisodes: 97 }
    })
  ])
  const [row] = db.indexList('anime', 10)
  assert.deepEqual(row.episodeCounts, { totalSeasons: 4, totalEpisodes: 97 })
  db.close()
})

check('unplayable entries are excluded from the counts', () => {
  // disambiguateVideos reassigns promotional clips into a fabricated season
  // 0. Counting them would inflate both the episode and the season count.
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath, TEST_PROFILE)
  db.indexUpsert('series', [
    item('tt1', {
      type: 'series',
      videos: [
        { id: 'a', season: 1, episode: 1, number: 1, title: '', released: '' },
        { id: 'b', season: 0, episode: 1, number: 1, title: '', released: '', unplayable: true }
      ]
    })
  ])
  const [row] = db.indexList('series', 10)
  assert.deepEqual(row.episodeCounts, { totalSeasons: 1, totalEpisodes: 1 })
  db.close()
})

check('no episode data at all leaves episodeCounts absent, not zeroed', () => {
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath, TEST_PROFILE)
  db.indexUpsert('series', [item('tt1', { type: 'series' })])
  const [row] = db.indexList('series', 10)
  assert.equal(row.episodeCounts, undefined, '"no data" must stay distinct from "zero episodes"')
  db.close()
})

// --- ordering and paging ------------------------------------------------

check('rank preserves the merged source order', () => {
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath, TEST_PROFILE)
  db.indexUpsert('movie', [item('tt3'), item('tt1'), item('tt2')])
  assert.deepEqual(
    db.indexList('movie', 10).map((x) => x.id),
    ['tt3', 'tt1', 'tt2'],
    'the crawl order IS the default trending ranking'
  )
  db.close()
})

check('paging is stable and non-overlapping', () => {
  // Without a deterministic tiebreaker, equal-rank rows can come back in
  // any order between calls — and a paged reader then sees one title twice
  // while another never appears at all.
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath, TEST_PROFILE)
  db.indexUpsert(
    'movie',
    Array.from({ length: 25 }, (_unused, i) => item(`tt${i}`))
  )
  const first = db.indexList('movie', 10, 0).map((x) => x.id)
  const second = db.indexList('movie', 10, 10).map((x) => x.id)
  const third = db.indexList('movie', 10, 20).map((x) => x.id)
  assert.equal(first.length, 10)
  assert.equal(third.length, 5, 'the last page is short, not padded')
  const all = [...first, ...second, ...third]
  assert.equal(new Set(all).size, 25, 'every title appears exactly once across the pages')
  assert.deepEqual(db.indexList('movie', 10, 0).map((x) => x.id), first, 'and the order is stable')
  db.close()
})

// --- genres -------------------------------------------------------------

check('genres round-trip, and a later crawl replaces rather than merges them', () => {
  // Unlike the scalar fields, a shorter genre list is a legitimate
  // correction — a source dropping a mis-tag — and merging could never undo
  // one.
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath, TEST_PROFILE)
  db.indexUpsert('movie', [item('tt1', { genres: ['Drama', 'Horror'] })])
  assert.deepEqual(db.indexList('movie', 10)[0].genres.sort(), ['Drama', 'Horror'])
  db.indexUpsert('movie', [item('tt1', { genres: ['Drama'] })])
  assert.deepEqual(db.indexList('movie', 10)[0].genres, ['Drama'])
  db.close()
})

// --- junk in, nothing out -----------------------------------------------

check('an entry with no id takes no row', () => {
  // normalizeMeta produces an idless entry from a malformed source record.
  // It can never be routed to, opened or played, so it must not occupy the
  // library.
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath, TEST_PROFILE)
  db.indexUpsert('movie', [item(''), item('tt1')])
  assert.equal(db.indexCount('movie'), 1)
  db.close()
})

check('an empty crawl is a no-op, not a truncation', () => {
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath, TEST_PROFILE)
  db.indexUpsert('movie', [item('tt1')])
  db.indexUpsert('movie', [])
  assert.equal(db.indexCount('movie'), 1, 'a failed crawl must not empty the library')
  db.close()
})

check('counting a kind with nothing in it is 0, not an error', () => {
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath, TEST_PROFILE)
  assert.equal(db.indexCount('anime'), 0)
  assert.deepEqual(db.indexList('anime', 10), [])
  db.close()
})

console.log(`\n${pass} passed`)
