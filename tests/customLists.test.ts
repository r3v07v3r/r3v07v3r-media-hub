// Named lists somebody made themselves.
//
// The two things worth pinning down are both about ownership. `list_items` has
// no profile column of its own — a list_id already belongs to exactly one
// profile, and a second copy of that fact is a second thing that can disagree
// — so every write has to check the parent list first. And deleting a list has
// to take its contents with it, which is a foreign key doing the work rather
// than a second DELETE that could be forgotten.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDatabase } from '../src/main/media-hub/database'

const ALICE = 'profile-alice'
const BOB = 'profile-bob'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-lists-'))
const db = createDatabase(path.join(dir, 'test.sqlite'), ALICE)

const dune = { id: 'tt1', type: 'movie' as const, title: 'Dune', poster: 'p1' }
const arrival = { id: 'tt2', type: 'movie' as const, title: 'Arrival', poster: 'p2' }

// ---------------------------------------------------------------------
// Creating, filling, reading.
// ---------------------------------------------------------------------
const halloween = db.createList('  Halloween  ')
assert.equal(halloween.name, 'Halloween', 'the name is trimmed')
assert.equal(halloween.count, 0)

assert.equal(db.addToList(halloween.id, dune), true)
assert.equal(db.addToList(halloween.id, arrival), true)

{
  const lists = db.lists()
  assert.equal(lists.length, 1)
  assert.equal(lists[0].count, 2, 'the size comes back with the list, not from a second read')

  const items = db.listItems(halloween.id)
  assert.deepEqual(
    items.map((item) => item.title).sort(),
    ['Arrival', 'Dune'],
    'the stored metadata is what gets read back, so a list renders with no catalog'
  )
  assert.equal(items.find((item) => item.contentId === 'tt1')?.poster, 'p1')
}

// Adding the same title twice is an update, not a duplicate — the composite
// primary key sees to that, and somebody clicking twice should not end up with
// two rows.
assert.equal(db.addToList(halloween.id, { ...dune, title: 'Dune (2021)' }), true)
assert.equal(db.lists()[0].count, 2)
assert.equal(
  db.listItems(halloween.id).find((item) => item.contentId === 'tt1')?.title,
  'Dune (2021)',
  'and the newer metadata wins'
)

// ---------------------------------------------------------------------
// Names are not unique. Two lists called the same thing is somebody's
// business, not an error to raise at them.
// ---------------------------------------------------------------------
const second = db.createList('Halloween')
assert.notEqual(second.id, halloween.id)
assert.equal(db.lists().length, 2)

// A list with no name at all IS an error, because there would be nothing to
// click on.
assert.throws(() => db.createList('   '), /needs a name/i)

// ---------------------------------------------------------------------
// Membership, for a picker that has to tick several boxes at once.
// ---------------------------------------------------------------------
db.addToList(second.id, dune)
assert.deepEqual(db.listsContaining('tt1').sort(), [halloween.id, second.id].sort())
assert.deepEqual(db.listsContaining('tt2'), [halloween.id])
assert.deepEqual(db.listsContaining('never-added'), [])

// ---------------------------------------------------------------------
// Renaming and removing.
// ---------------------------------------------------------------------
assert.equal(db.renameList(halloween.id, 'Spooky season'), true)
assert.equal(db.lists().find((list) => list.id === halloween.id)?.name, 'Spooky season')
assert.equal(db.renameList(halloween.id, '   '), false, 'a blank rename is refused, not applied')

assert.equal(db.removeFromList(halloween.id, 'tt2'), true)
assert.equal(db.listItems(halloween.id).length, 1)
assert.equal(db.removeFromList(halloween.id, 'tt2'), false, 'removing twice is a no-op')

// ---------------------------------------------------------------------
// Deleting a list takes its contents with it.
// ---------------------------------------------------------------------
assert.equal(db.deleteList(second.id), true)
assert.equal(db.lists().length, 1)
assert.deepEqual(db.listsContaining('tt1'), [halloween.id], 'the deleted list left no rows behind')

// ---------------------------------------------------------------------
// One profile cannot reach another's lists — the check that stands in for
// the profile column list_items deliberately does not have.
// ---------------------------------------------------------------------
db.setActiveProfile(BOB)
assert.deepEqual(db.lists(), [], 'Bob has none of his own')
assert.equal(db.addToList(halloween.id, dune), false, "and cannot write into Alice's")
assert.equal(db.removeFromList(halloween.id, 'tt1'), false, 'nor remove from it')
assert.equal(db.renameList(halloween.id, 'Hijacked'), false)
assert.equal(db.deleteList(halloween.id), false)
assert.deepEqual(db.listItems(halloween.id), [], 'nor read it')

db.setActiveProfile(ALICE)
assert.equal(db.lists()[0].name, 'Spooky season', 'and none of that touched it')
assert.equal(db.listItems(halloween.id).length, 1)

db.close()
console.log('custom list tests passed')
