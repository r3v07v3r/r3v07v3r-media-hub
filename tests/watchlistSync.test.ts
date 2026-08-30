// The rule that stops two-way sync deleting somebody's list.
//
// docs/WATCHLIST-SYNC.md rule 2: a removal only propagates INWARD if this
// app saw the title arrive. "On the local list and not on Trakt" is an
// ambiguous state — it means either "you added it here and Trakt has not
// heard" or "you removed it there and this app has not heard" — and a
// snapshot cannot tell those apart. The origins record is what makes it
// answerable, and this pins the decision that reads it.
//
// The decision is tested rather than the pull: fetching needs three
// authenticated accounts, and what could actually destroy data is this
// judgement, not the HTTP around it.

import assert from 'node:assert/strict'

import { plannedRemovals } from '../src/main/media-hub/watchlistRules'

const HOUR = 60 * 60 * 1000
const now = Date.now()

// --- the case the whole rule exists for ------------------------------------

// Added HERE, never seen on any service. Absent from every list it has
// never been on — and must survive, because the answer is to push it, not
// to delete it. This is the one that would lose real data.
assert.deepEqual(
  plannedRemovals({
    tracked: ['tt-local'],
    origins: {},
    sources: {},
    answered: new Set(['simkl', 'trakt', 'mal'])
  }),
  [],
  'a title added here is never removed by a pull, however long it is absent'
)

// Pulled from Trakt, now gone from Trakt. This app watched it arrive and
// watched it leave: established, not inferred.
assert.deepEqual(
  plannedRemovals({
    tracked: ['tt-remote'],
    origins: { 'tt-remote': { source: 'trakt', addedAt: now - HOUR } },
    sources: {},
    answered: new Set(['trakt'])
  }),
  ['tt-remote'],
  'a title this app pulled in, now gone from its source, is removed'
)

// --- rule 5: absence has to be an ANSWER ----------------------------------

// Trakt errored, so nothing it holds is known to be absent. Removing on
// that basis would let an outage read as "they emptied their watchlist".
assert.deepEqual(
  plannedRemovals({
    tracked: ['tt-remote'],
    origins: { 'tt-remote': { source: 'trakt', addedAt: now - HOUR } },
    sources: {},
    answered: new Set(['simkl', 'mal'])
  }),
  [],
  'a service that did not answer cannot be the reason to delete anything'
)

// --- still on somebody's list ---------------------------------------------

assert.deepEqual(
  plannedRemovals({
    tracked: ['tt-remote'],
    origins: { 'tt-remote': { source: 'trakt', addedAt: now - HOUR } },
    sources: { 'tt-remote': ['simkl'] },
    answered: new Set(['simkl', 'trakt'])
  }),
  [],
  'a title still on another service has not left anywhere that counts'
)

// --- already gone locally --------------------------------------------------

assert.deepEqual(
  plannedRemovals({
    tracked: [],
    origins: { 'tt-remote': { source: 'trakt', addedAt: now - HOUR } },
    sources: {},
    answered: new Set(['trakt'])
  }),
  [],
  'nothing to remove when it is already off the local list'
)

// --- a first sync cannot delete -------------------------------------------
//
// The property that makes this safe to ship: an account nobody has pulled
// from has no origins, so every local title is unexplained and none of
// them can be removed. Whatever else is wrong, the first run is harmless.
const firstSync = plannedRemovals({
  tracked: ['a', 'b', 'c', 'd'],
  origins: {},
  sources: { a: ['trakt'] },
  answered: new Set(['simkl', 'trakt', 'mal'])
})
assert.deepEqual(firstSync, [], 'a first sync against a fresh account removes nothing')

console.log('ok  watchlist two-way removal rule')
