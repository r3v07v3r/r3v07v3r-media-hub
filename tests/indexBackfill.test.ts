// The one-time index backfill (src/main/media-hub/indexBackfill.ts).
//
// Titles tracked, watched, rated or marked Not for me before those actions
// gave a title an index row are missing from the grids, My Stuff and the
// Planned row, which read the index by id. The pass gives them rows once per
// database. What is pinned:
//   - every profile's titles are covered, not only the active profile's;
//   - a row comes from the title's cached meta entry where there is one,
//     and otherwise from the tracking row's id, kind and title;
//   - an id known only by its rating takes its kind from a cached entry,
//     and is left out when nothing says its kind;
//   - a row the crawl wrote, and a season grouped under its show, are never
//     touched;
//   - the finished pass is recorded durably and never runs again;
//   - the pass works in chunks and stops between them when the app is no
//     longer idle, without its record, and the next run finishes it;
//   - a membership read that fails leaves the record unwritten.
//
// Run with: npx tsx tests/indexBackfill.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { createDatabase } from '../src/main/media-hub/database'
import {
  INDEX_BACKFILL_CHUNK,
  INDEX_BACKFILL_KEY,
  indexBackfillDone,
  runIndexBackfill,
  type IndexBackfillDeps
} from '../src/main/media-hub/indexBackfill'
import { metaCacheKey } from '../src/main/media-hub/titleNames'
import type { CatalogItem, MediaKind } from '../src/shared/media-hub/types'

let pass = 0
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

const HOUR = 60 * 60 * 1000
const POSTER = 'https://m.media-amazon.com/images/p.jpg'

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-index-backfill-'))
  return path.join(dir, 'test.sqlite')
}

function item(id: string, type: MediaKind, over: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id,
    title: id,
    type,
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
  } as CatalogItem
}

/** The raw index row, source and rank included. */
function raw(dbPath: string, id: string): Record<string, unknown> | undefined {
  const sql = new DatabaseSync(dbPath)
  try {
    return sql.prepare('SELECT * FROM catalog_index WHERE id=?').get(id) as
      Record<string, unknown> | undefined
  } finally {
    sql.close()
  }
}

type Db = ReturnType<typeof createDatabase>

function deps(db: Db, over: Partial<IndexBackfillDeps> = {}): IndexBackfillDeps {
  return { db, stillIdle: () => true, yieldTurn: async () => {}, ...over }
}

async function main(): Promise<void> {
  await check('every profile, from the meta entry or the tracking row', async () => {
    const dbPath = tempDbPath()
    const db = createDatabase(dbPath, 'profile-a')
    // A crawl row and a grouped anime show, both curated.
    db.indexUpsert('movie', [item('tt0000006', 'movie', { title: 'Curated' })], {
      source: 'cinemeta+simkl'
    })
    db.indexUpsert('anime', [item('kitsu:1', 'anime', { groupedIds: ['kitsu:1', 'kitsu:2'] })], {
      source: 'kitsu'
    })

    // Profile A: planned with a cached entry, disliked with none, a
    // tracked crawl title, and a later season grouped under its show.
    db.putCache(
      metaCacheKey('movie', 'tt0000001'),
      item('tt0000001', 'movie', { title: 'Opened Before', poster: POSTER, year: '2020' }),
      HOUR
    )
    db.track(item('tt0000001', 'movie', { title: 'Opened Before' }))
    db.dislike(item('tt0000003', 'movie', { title: 'Not For Me' }))
    db.track(item('tt0000006', 'movie', { title: 'Tracked Name' }))
    db.markWatched(item('kitsu:2', 'anime', { title: 'Season Two' }))

    // Profile B: watched, and rated only.
    db.setActiveProfile('profile-b')
    db.markWatched(item('tt0000002', 'series', { title: 'Watched Elsewhere' }))
    db.putCache(
      metaCacheKey('series', 'tt0000004'),
      item('tt0000004', 'series', { title: 'Rated Show' }),
      HOUR
    )
    db.rate('tt0000004', 8)
    db.rate('tt0000005', 6)
    db.setActiveProfile('profile-a')

    const report = await runIndexBackfill(deps(db))
    assert.deepEqual(report, { indexed: 4, done: true })

    const opened = raw(dbPath, 'tt0000001')
    assert.equal(opened?.kind, 'movie')
    assert.equal(opened?.poster, POSTER, 'from the cached meta entry')
    assert.equal(opened?.year, 2020)
    assert.equal(opened?.source, 'search')

    assert.equal(raw(dbPath, 'tt0000002')?.kind, 'series', "another profile's watched title")
    assert.equal(raw(dbPath, 'tt0000002')?.title, 'Watched Elsewhere')
    assert.equal(raw(dbPath, 'tt0000003')?.title, 'Not For Me', 'a bare row')
    assert.equal(raw(dbPath, 'tt0000003')?.poster, '')
    assert.equal(raw(dbPath, 'tt0000004')?.kind, 'series', 'rated only: the cached kind')
    assert.equal(raw(dbPath, 'tt0000005'), undefined, 'rated only, nothing says its kind')

    assert.equal(raw(dbPath, 'tt0000006')?.title, 'Curated', 'the crawl row is untouched')
    assert.equal(raw(dbPath, 'tt0000006')?.source, 'cinemeta+simkl')
    assert.equal(raw(dbPath, 'kitsu:2'), undefined, 'a grouped season stays under its show')
    db.close()
  })

  await check('the finished pass is recorded and never runs again', async () => {
    const dbPath = tempDbPath()
    const db = createDatabase(dbPath, 'profile-a')
    db.track(item('tt0000001', 'movie', { title: 'First' }))
    assert.equal(indexBackfillDone(db), false)
    await runIndexBackfill(deps(db))
    assert.equal(indexBackfillDone(db), true)
    const record = db.getCache<{ at: number }>(INDEX_BACKFILL_KEY)
    assert.ok(record && record.at > 0)

    // Tracked after the pass: the tracking handlers index it themselves,
    // and the pass does not even read the candidates.
    db.track(item('tt0000002', 'movie', { title: 'Later' }))
    let reads = 0
    const counted = {
      ...db,
      indexBackfillCandidates: () => {
        reads += 1
        return db.indexBackfillCandidates()
      }
    } as Db
    const again = await runIndexBackfill(deps(counted))
    assert.deepEqual(again, { indexed: 0, done: true })
    assert.equal(reads, 0)
    assert.equal(raw(dbPath, 'tt0000002'), undefined)
    db.close()

    // Durable: the record is in the database, not in memory.
    const reopened = createDatabase(dbPath, 'profile-a')
    assert.equal(indexBackfillDone(reopened), true)
    reopened.close()
  })

  await check('stops between chunks when the app is busy, and finishes later', async () => {
    const dbPath = tempDbPath()
    const db = createDatabase(dbPath, 'profile-a')
    const total = INDEX_BACKFILL_CHUNK * 2 + 10
    for (let n = 0; n < total; n++) {
      const id = `tt${String(1000000 + n)}`
      db.track(item(id, 'movie', { title: `Title ${n}` }))
    }
    let yields = 0
    const busy = await runIndexBackfill(
      deps(db, {
        stillIdle: () => false,
        yieldTurn: async () => {
          yields += 1
        }
      })
    )
    assert.deepEqual(busy, { indexed: INDEX_BACKFILL_CHUNK, done: false })
    assert.equal(yields, 1, 'one turn given up before the check')
    assert.equal(indexBackfillDone(db), false, 'no record for an unfinished pass')
    assert.equal(db.indexCount('movie'), INDEX_BACKFILL_CHUNK)

    const idle = await runIndexBackfill(deps(db))
    assert.deepEqual(idle, { indexed: total - INDEX_BACKFILL_CHUNK, done: true })
    assert.equal(db.indexCount('movie'), total)
    assert.equal(indexBackfillDone(db), true)
    db.close()
  })

  await check('a failed membership read leaves the record unwritten', async () => {
    const dbPath = tempDbPath()
    const db = createDatabase(dbPath, 'profile-a')
    db.track(item('tt0000001', 'movie', { title: 'First' }))
    const failing = { ...db, indexExistingIds: () => null } as Db
    const report = await runIndexBackfill(deps(failing))
    assert.deepEqual(report, { indexed: 0, done: false })
    assert.equal(indexBackfillDone(db), false)
    assert.equal(raw(dbPath, 'tt0000001'), undefined)
    // The next run, with the read working, does it.
    assert.deepEqual(await runIndexBackfill(deps(db)), { indexed: 1, done: true })
    db.close()
  })

  console.log(`\n${pass} checks passed`)
}

void main()
