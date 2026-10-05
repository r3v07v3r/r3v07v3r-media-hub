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
import { indexTitleIfMissing } from '../src/main/media-hub/deepScanRules'
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
      Record<string, unknown> | undefined
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

check('title_key is the title in a search query’s own form', () => {
  // The name search compares a punctuation-free query against this column
  // (see indexSearch), so what "Spider-Man" stores must equal what somebody
  // typing "spider man" is compared as — the same fold the query goes through.
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath, TEST_PROFILE)
  db.indexUpsert('movie', [item('tt1', { title: 'Spider-Man: Amélie’s Web' })])
  assert.equal(raw(dbPath, 'tt1')?.title_key, 'spider man amelie s web')
  assert.equal(raw(dbPath, 'tt1')?.title_sort, 'spider-man: amelie’s web')
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
  assert.deepEqual(
    db.indexList('movie', 10, 0).map((x) => x.id),
    first,
    'and the order is stable'
  )
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

// --- the aired count moves by itself as air dates pass ------------------

check('a cached title re-read after an episode airs refreshes its aired count', () => {
  // The metadata cache-hit path calls this on every read (catalog.ts): the
  // entry it serves has not changed, but a dated episode in it has crossed
  // its air time since the row was written.
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath, TEST_PROFILE)
  const airsAt = Date.UTC(2026, 8, 17, 3)
  const title = item('tt1', {
    type: 'series',
    videos: [
      { id: 'a', season: 1, episode: 1, number: 1, title: '', released: '2026-09-10T03:00:00Z' },
      { id: 'b', season: 1, episode: 2, number: 2, title: '', released: '2026-09-17T03:00:00Z' },
      { id: 'c', season: 1, episode: 3, number: 3, title: '', released: '', upcoming: true }
    ]
  })
  db.indexUpsert('series', [title], { now: 1_000 })
  db.indexRefreshFromMetadata('series', title, airsAt - 60_000)
  assert.equal(raw(dbPath, 'tt1')?.aired_episodes, 1, 'before air time: one aired, one flagged')

  db.indexRefreshAiredCount('series', title, airsAt + 60_000)
  const after = raw(dbPath, 'tt1')
  assert.equal(after?.aired_episodes, 2, 'after air time: the dated episode counts')
  assert.equal(after?.updated_at, airsAt + 60_000, 'a real change is a sighting')

  db.indexRefreshAiredCount('series', title, airsAt + 120_000)
  assert.equal(
    raw(dbPath, 'tt1')?.updated_at,
    airsAt + 60_000,
    'an unchanged count writes nothing — the sweeps call this on every read'
  )

  db.indexRefreshAiredCount('series', item('tt1', { type: 'series', videos: [] }), airsAt)
  assert.equal(raw(dbPath, 'tt1')?.aired_episodes, 2, 'no episode data never erases a count')
  db.close()
})

check('a title whose episodes have all still to air stores a confirmed zero', () => {
  // The row was first written from a crawl's dateless placeholders (every
  // one presumed aired); the resolve then learns none has. Zero must land,
  // or the COALESCE that protects real counts from "no data" would keep
  // the placeholder count and the title would read as watchable — and, once
  // its episodes were marked, as Completed.
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath, TEST_PROFILE)
  const placeholders = [
    { id: 'a', season: 1, episode: 1, number: 1, title: '', released: '' },
    { id: 'b', season: 1, episode: 2, number: 2, title: '', released: '' }
  ]
  db.indexUpsert('anime', [item('kitsu:1', { type: 'anime', videos: placeholders })])
  assert.equal(raw(dbPath, 'kitsu:1')?.aired_episodes, 2, 'placeholders count as aired')
  const resolved = item('kitsu:1', {
    type: 'anime',
    videos: placeholders.map((v) => ({ ...v, upcoming: true }))
  })
  db.indexRefreshFromMetadata('anime', resolved)
  assert.equal(raw(dbPath, 'kitsu:1')?.aired_episodes, 0, 'none aired is zero, not "no data"')
  db.close()
})

// --- a title found only by a remote search (deepScanRules.ts) ------------
//
// Opened or tracked, it gets a row, or the grids and My Stuff (which read
// the index by id) cannot show it. The deep scan's skip-existing rule
// applies: nothing the crawl curated is touched.

check('a search-only title gets a row ranked below everything indexed', () => {
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath, TEST_PROFILE)
  db.indexUpsert('movie', [item('tt1'), item('tt2')], { source: 'cinemeta+simkl', rankBase: 40 })
  const found = item('tt9', { title: 'Remote Harbour', poster: 'https://img.example/p.jpg' })
  assert.equal(indexTitleIfMissing(db, 'movie', found), true)
  const row = raw(dbPath, 'tt9')
  assert.equal(row?.source, 'search')
  assert.equal(row?.title, 'Remote Harbour')
  assert.ok(Number(row?.rank) > 41, `rank ${row?.rank} is not below the crawled rows`)
  assert.deepEqual(
    db.indexByIds(['tt9']).items.map((x) => x.id),
    ['tt9'],
    'My Stuff reads tracked titles by id, and now finds it'
  )
  db.close()
})

check('a title the index already holds is left exactly as the crawl wrote it', () => {
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath, TEST_PROFILE)
  db.indexUpsert('movie', [item('tt1', { title: 'Curated' })], { source: 'cinemeta+simkl' })
  assert.equal(indexTitleIfMissing(db, 'movie', item('tt1', { title: 'Other' })), false)
  assert.equal(raw(dbPath, 'tt1')?.title, 'Curated')
  assert.equal(raw(dbPath, 'tt1')?.source, 'cinemeta+simkl')
  db.close()
})

check('a season grouped under its show does not get a row of its own', () => {
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath, TEST_PROFILE)
  db.indexUpsert(
    'anime',
    [item('kitsu:1', { type: 'anime', groupedIds: ['kitsu:1', 'kitsu:2'] })],
    {
      source: 'kitsu'
    }
  )
  assert.equal(indexTitleIfMissing(db, 'anime', item('kitsu:2', { type: 'anime' })), false)
  assert.equal(raw(dbPath, 'kitsu:2'), undefined)
  db.close()
})

check('only ids and titles the index accepts from outside the crawl are written', () => {
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath, TEST_PROFILE)
  assert.equal(indexTitleIfMissing(db, 'movie', item('simkl:42')), false)
  assert.equal(indexTitleIfMissing(db, 'movie', item('tt5', { title: '  ' })), false)
  assert.equal(db.indexCount('movie'), 0)
  db.close()
})

check("a title is only written into its own kind's catalog", () => {
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath, TEST_PROFILE)
  // The status handler reads a typeless payload as a movie: a Kitsu id
  // must not land in the movie grid, nor an IMDb id in the Kitsu-keyed
  // anime grid.
  assert.equal(indexTitleIfMissing(db, 'movie', item('kitsu:5', { type: 'anime' })), false)
  assert.equal(indexTitleIfMissing(db, 'anime', item('tt5', { type: 'anime' })), false)
  assert.equal(db.indexCount('movie') + db.indexCount('anime'), 0)
  assert.equal(indexTitleIfMissing(db, 'series', item('tt6', { type: 'series' })), true)
  assert.equal(indexTitleIfMissing(db, 'anime', item('kitsu:6', { type: 'anime' })), true)
  db.close()
})

check('a title with its own row is answered by key, without the grouped pass', () => {
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath, TEST_PROFILE)
  db.indexUpsert('anime', [item('kitsu:1', { type: 'anime', groupedIds: ['kitsu:1', 'kitsu:2'] })])
  assert.equal(db.indexHasRow('anime', 'kitsu:1'), true)
  assert.equal(db.indexHasRow('anime', 'kitsu:2'), false, 'a grouped member has no row of its own')
  assert.equal(db.indexHasRow('movie', 'kitsu:1'), false, 'per kind')
  // indexTitleIfMissing runs on every open and watched mark; the grouped
  // pass parses every grouped row of the kind, so it is kept for ids with
  // no row of their own.
  let groupedPasses = 0
  const counted = {
    indexHasRow: db.indexHasRow,
    indexMaxRank: db.indexMaxRank,
    indexUpsert: db.indexUpsert,
    indexExistingIds: (kind: Parameters<typeof db.indexExistingIds>[0], ids: readonly string[]) => {
      groupedPasses += 1
      return db.indexExistingIds(kind, ids)
    }
  }
  assert.equal(indexTitleIfMissing(counted, 'anime', item('kitsu:1', { type: 'anime' })), false)
  assert.equal(groupedPasses, 0)
  assert.equal(indexTitleIfMissing(counted, 'anime', item('kitsu:2', { type: 'anime' })), false)
  assert.equal(groupedPasses, 1)
  db.close()
})

check('a later crawl that lists a search row takes it over', () => {
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath, TEST_PROFILE)
  indexTitleIfMissing(db, 'movie', item('tt9', { title: 'Remote Harbour' }))
  db.indexUpsert('movie', [item('tt9', { title: 'Remote Harbour' })], { source: 'cinemeta+simkl' })
  assert.equal(raw(dbPath, 'tt9')?.source, 'cinemeta+simkl')
  assert.equal(raw(dbPath, 'tt9')?.rank, 0)
  db.close()
})

console.log(`\n${pass} passed`)
