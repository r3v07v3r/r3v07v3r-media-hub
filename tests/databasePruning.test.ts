// Unit tests for catalog_cache eviction (src/main/media-hub/database.ts).
//
// Before this, nothing ever deleted an expired row — a real user's
// database (inspected for the anime catalog audit) had 298 expired rows
// sitting on disk, several categories 100% expired, with no cleanup ever
// run. The fix has one real failure mode worth guarding against directly:
// eight call sites in catalog.ts/simklClient.ts/torbox.ts deliberately
// read an EXPIRED row as an emergency offline fallback
// (`getCache(key, {allowExpired: true})`) — a prune that is too eager
// would quietly disarm that fallback. These tests prove the grace window
// keeps a recently-expired row available while still reclaiming rows
// abandoned for a long time.
//
// Run with: npx tsx tests/databasePruning.test.ts   (or npm.cmd test)

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase } from '../src/main/media-hub/database'

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-prune-test-'))
  return path.join(dir, 'test.sqlite')
}

/** Seeds a row directly via raw SQL, bypassing putCache — putCache can
 *  only set expires_at relative to "now", and these tests need full
 *  control over exactly how stale a row is. */
function seedRow(dbPath: string, key: string, expiresAt: number): void {
  const raw = new DatabaseSync(dbPath)
  raw.exec(`CREATE TABLE IF NOT EXISTS catalog_cache(
    cache_key TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`)
  raw
    .prepare(
      'INSERT INTO catalog_cache(cache_key,payload_json,expires_at,updated_at) VALUES(?,?,?,?)'
    )
    .run(key, JSON.stringify({ v: key }), expiresAt, Date.now())
  raw.close()
}

const DAY_MS = 24 * 60 * 60 * 1000
const now = Date.now()

console.log('catalog_cache pruning on open')

check('a row expired within the grace window survives (the offline-fallback case)', () => {
  const dbPath = tempDbPath()
  seedRow(dbPath, 'recently-expired', now - 2 * DAY_MS)
  const db = createDatabase(dbPath)
  const value = db.getCache<{ v: string }>('recently-expired', { allowExpired: true })
  assert.ok(value, 'a row expired 2 days ago must still be readable as a stale fallback')
  db.close()
})

check('a row expired just under the grace boundary survives', () => {
  const dbPath = tempDbPath()
  seedRow(dbPath, 'almost-30-days', now - (30 * DAY_MS - 60_000))
  const db = createDatabase(dbPath)
  const value = db.getCache<{ v: string }>('almost-30-days', { allowExpired: true })
  assert.ok(value, 'a row just inside the 30-day grace window must survive')
  db.close()
})

check('a row expired well past the grace window is reclaimed', () => {
  const dbPath = tempDbPath()
  seedRow(dbPath, 'long-abandoned', now - 90 * DAY_MS)
  const db = createDatabase(dbPath)
  const value = db.getCache<{ v: string }>('long-abandoned', { allowExpired: true })
  assert.equal(value, null, 'a row abandoned for 90 days should have been pruned')
  db.close()
})

check('a live (not yet expired) row is never touched', () => {
  const dbPath = tempDbPath()
  seedRow(dbPath, 'still-live', now + DAY_MS)
  const db = createDatabase(dbPath)
  const value = db.getCache<{ v: string }>('still-live')
  assert.ok(value, 'a row that has not expired yet must never be pruned')
  db.close()
})

check('pruning does not throw or block opening a database with no expired rows at all', () => {
  const dbPath = tempDbPath()
  const db = createDatabase(dbPath)
  db.putCache('fresh', { ok: true }, 60_000)
  assert.ok(db.getCache('fresh'))
  db.close()
})

check('a mix of fresh, gracefully-stale, and abandoned rows resolves independently', () => {
  const dbPath = tempDbPath()
  seedRow(dbPath, 'fresh', now + DAY_MS)
  seedRow(dbPath, 'stale-but-in-grace', now - 5 * DAY_MS)
  seedRow(dbPath, 'abandoned', now - 45 * DAY_MS)
  const db = createDatabase(dbPath)
  assert.ok(db.getCache('fresh'))
  assert.ok(db.getCache('stale-but-in-grace', { allowExpired: true }))
  assert.equal(db.getCache('abandoned', { allowExpired: true }), null)
  db.close()
})

check('re-opening an already-pruned database is idempotent', () => {
  const dbPath = tempDbPath()
  seedRow(dbPath, 'abandoned', now - 60 * DAY_MS)
  const first = createDatabase(dbPath)
  first.close()
  // Second open must not error just because the row is already gone.
  const second = createDatabase(dbPath)
  assert.equal(second.getCache('abandoned', { allowExpired: true }), null)
  second.close()
})

console.log(`\n${pass} passed`)
