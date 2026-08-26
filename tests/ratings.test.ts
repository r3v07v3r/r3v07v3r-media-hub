// What a rating is worth, and what it changes.
//
// The storage half is easy; the half worth testing is that ratings actually
// move the two signals the recommender learns from — preferred genres and the
// taste profile — WITHOUT changing anything for a library nobody has rated.
// That last property is what makes this safe to ship on by default.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDatabase } from '../src/main/media-hub/database'
import { buildTasteProfile } from '../src/shared/media-hub/catalog-logic'
import { ratingWeight } from '../src/shared/media-hub/rating'
import type { TitleCredits } from '../src/shared/media-hub/types'

const PROFILE = 'profile-ratings'

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-ratings-'))
  return createDatabase(path.join(dir, 'test.sqlite'), PROFILE)
}

// ---------------------------------------------------------------------
// The weight curve.
// ---------------------------------------------------------------------

// Unrated is neutral, which is the property that leaves an unrated library
// ranking exactly as it did before ratings existed.
assert.equal(ratingWeight(undefined), 1)
assert.equal(ratingWeight(null), 1)
assert.equal(ratingWeight(Number.NaN), 1)

// A bad score withdraws its vote rather than casting the opposite one — the
// app has an explicit dislike for "less like this".
assert.equal(ratingWeight(1), 0)
assert.equal(ratingWeight(4), 0)
assert.ok(
  ratingWeight(5) > 0 && ratingWeight(5) < 1,
  'a middling score counts for less than neutral'
)
assert.ok(ratingWeight(8) > 1, 'a good score counts for more')
assert.ok(ratingWeight(10) > ratingWeight(8), 'and a great one for more still')

// ---------------------------------------------------------------------
// Storage.
// ---------------------------------------------------------------------
{
  const db = tempDb()
  db.rate('tt1', 9)
  assert.equal(db.ratings().get('tt1'), 9)

  db.rate('tt1', 4)
  assert.equal(db.ratings().get('tt1'), 4, 'rating again replaces rather than accumulating')

  // 0 is the UI's clear action. "No opinion" is an absence, not a zero.
  db.rate('tt1', 0)
  assert.equal(db.ratings().has('tt1'), false)

  // Anything outside 1-10 is a removal too, not a stored nonsense value.
  db.rate('tt2', 99)
  db.rate('tt3', -5)
  assert.equal(db.ratings().size, 0)

  // Scores are per profile, like everything else a profile owns.
  db.rate('tt1', 10)
  db.setActiveProfile('someone-else')
  assert.equal(db.ratings().has('tt1'), false)
  db.setActiveProfile(PROFILE)
  assert.equal(db.ratings().get('tt1'), 10)
  db.close()
}

// ---------------------------------------------------------------------
// Preferred genres follow the ratings.
// ---------------------------------------------------------------------
{
  const db = tempDb()
  // Three horror titles and two comedies. On raw counts horror wins outright.
  for (const id of ['h1', 'h2', 'h3']) {
    db.markWatched({ id, type: 'movie', title: id, genres: ['Horror'] })
  }
  for (const id of ['c1', 'c2']) {
    db.markWatched({ id, type: 'movie', title: id, genres: ['Comedy'] })
  }
  assert.deepEqual(db.preferredGenres(1), ['Horror'], 'unrated, the majority genre leads')

  // Now say the horror was endured and the comedies were loved.
  for (const id of ['h1', 'h2', 'h3']) db.rate(id, 3)
  for (const id of ['c1', 'c2']) db.rate(id, 10)
  assert.deepEqual(
    db.preferredGenres(1),
    ['Comedy'],
    'a genre watched more but enjoyed less no longer leads'
  )

  // A genre rated badly across the board drops out entirely rather than
  // trailing the list — its weight is zero, not merely small.
  assert.deepEqual(db.preferredGenres(4), ['Comedy'])
  db.close()
}

// ---------------------------------------------------------------------
// The taste profile follows them too.
// ---------------------------------------------------------------------
function credits(cast: string[], creators: string[] = []): TitleCredits {
  return { cast, creators, keywords: [] }
}

{
  // Two performers, each in two watched titles, so both clear the
  // "appeared more than once" bar. Only one of them is in things this person
  // actually liked.
  const liked = [
    { credits: credits(['Loved Actor']), weight: ratingWeight(10) },
    { credits: credits(['Loved Actor']), weight: ratingWeight(9) },
    { credits: credits(['Endured Actor']), weight: ratingWeight(2) },
    { credits: credits(['Endured Actor']), weight: ratingWeight(3) }
  ]
  const taste = buildTasteProfile(liked)
  assert.ok(taste.cast.has('loved actor'))
  assert.ok(taste.cast.has('endured actor'), 'both still clear the appearance floor')

  // The floor is an appearance count, NOT a weight sum — one adored film must
  // not be enough to establish a taste, which is what MIN_APPEARANCES exists
  // to prevent and what a single weighted tally would have quietly undone.
  const oneGreatFilm = buildTasteProfile([
    { credits: credits(['One Hit Actor']), weight: ratingWeight(10) }
  ])
  assert.equal(
    oneGreatFilm.cast.has('one hit actor'),
    false,
    'a single title, however loved, is not a preference'
  )

  // Bare credits still work and mean "no opinion recorded".
  const unrated = buildTasteProfile([credits(['Plain Actor']), credits(['Plain Actor'])])
  assert.ok(unrated.cast.has('plain actor'), 'an unrated library builds the profile it always did')
}

console.log('ratings tests passed')
