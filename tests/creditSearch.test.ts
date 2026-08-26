// Searching what is known about a title, not just its name.
//
// Both functions read the same credits cache and answer deliberately
// different questions, which is the thing worth pinning down: clicking a name
// means THAT name, and typing one means anything containing it. Getting those
// the same way round would make a click on "Ana de Armas" also return every
// title with an "Ana" in the cast.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDatabase } from '../src/main/media-hub/database'
import { setDatabase } from '../src/main/media-hub/dbState'
import { searchCredits, titlesFeaturing } from '../src/main/media-hub/credits'
import type { TitleCredits } from '../src/shared/media-hub/types'

// Both functions read through the credits cache, which lives in the database —
// so a real one, seeded the way the enrichment pass seeds it.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-credit-search-'))
const db = createDatabase(path.join(dir, 'test.sqlite'), 'profile-test')
setDatabase(db)

/** Mirrors the key the enrichment pass writes under (see credits.ts). */
function seed(id: string, credits: TitleCredits): void {
  db.putCache(`credits:v1:${id}`, credits, 30 * 24 * 60 * 60 * 1000)
}

seed('tt1', {
  cast: ['Timothée Chalamet', 'Rebecca Ferguson'],
  creators: ['Denis Villeneuve'],
  keywords: ['desert', 'chosen one']
})
seed('tt2', {
  cast: ['Ryan Gosling', 'Ana de Armas'],
  creators: ['Denis Villeneuve'],
  keywords: ['dystopia', 'artificial intelligence']
})
seed('tt3', {
  cast: ['Ryan Gosling'],
  creators: ['Nicolas Winding Refn'],
  keywords: ['driving', 'heist']
})
seed('tt4', { cast: [], creators: [], keywords: [] })

const ids = ['tt1', 'tt2', 'tt3', 'tt4', 'never-enriched']

// ---------------------------------------------------------------------
// Clicking a name: exact, and split by the role people came looking for.
// ---------------------------------------------------------------------
{
  const villeneuve = titlesFeaturing(ids, 'Denis Villeneuve')
  assert.deepEqual(villeneuve.creators.sort(), ['tt1', 'tt2'])
  assert.deepEqual(villeneuve.cast, [])

  const gosling = titlesFeaturing(ids, 'Ryan Gosling')
  assert.deepEqual(gosling.cast.sort(), ['tt2', 'tt3'])

  // Case and surrounding space are not part of a name.
  assert.deepEqual(titlesFeaturing(ids, '  ryan gosling ').cast.sort(), ['tt2', 'tt3'])

  // EXACT, not substring: a click means that person, and a partial match would
  // put every "Ana" in the cast list of somebody who clicked "Ana de Armas".
  assert.deepEqual(titlesFeaturing(ids, 'Ryan').cast, [])
  assert.deepEqual(titlesFeaturing(ids, '').cast, [])
}

// ---------------------------------------------------------------------
// Typing a query: substring, because somebody is part-way through it.
// ---------------------------------------------------------------------
{
  assert.deepEqual(searchCredits(ids, 'villeneuve').people.sort(), ['tt1', 'tt2'])
  assert.deepEqual(searchCredits(ids, 'gosl').people.sort(), ['tt2', 'tt3'])

  // A name match and a label match are separated so the caller can put names
  // first — somebody typing "drive" wants the film before everything tagged
  // "driving".
  const dystopia = searchCredits(ids, 'dystopia')
  assert.deepEqual(dystopia.people, [])
  assert.deepEqual(dystopia.labels, ['tt2'])

  // A title matching on BOTH is counted once, on the stronger signal.
  const gosling = searchCredits(ids, 'gosling')
  assert.ok(gosling.people.includes('tt3'))
  assert.ok(!gosling.labels.includes('tt3'))

  // One character matches most of a catalog and means nothing.
  assert.deepEqual(searchCredits(ids, 'a'), { people: [], labels: [] })
  assert.deepEqual(searchCredits(ids, ' '), { people: [], labels: [] })
}

// ---------------------------------------------------------------------
// Titles with nothing cached contribute nothing rather than throwing.
// ---------------------------------------------------------------------
assert.deepEqual(searchCredits(['never-enriched'], 'anything'), { people: [], labels: [] })
assert.deepEqual(titlesFeaturing(['tt4'], 'Ryan Gosling'), { cast: [], creators: [] })

db.close()
console.log('credit search tests passed')
