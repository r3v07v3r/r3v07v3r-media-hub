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

import { mayRemoveAt, plannedRemovals } from '../src/main/media-hub/watchlistRules'

const HOUR = 60 * 60 * 1000
const now = Date.now()

/** The accounts connected right now, as settingsStore's marks. An origin
 *  has to name one of these to justify anything — signing into a
 *  different account changes these strings and orphans every stamp. */
const ACCOUNTS = { simkl: 'simkl-a', trakt: 'trakt-a', mal: 'mal-a' }

/** The ordinary origin: pulled from Trakt, under the Trakt account that
 *  is still connected. */
const fromTrakt = { source: 'trakt' as const, addedAt: now - HOUR, account: ACCOUNTS.trakt }

// --- the case the whole rule exists for ------------------------------------

// Added HERE, never seen on any service. Absent from every list it has
// never been on — and must survive, because the answer is to push it, not
// to delete it. This is the one that would lose real data.
assert.deepEqual(
  plannedRemovals({
    tracked: ['tt-local'],
    origins: {},
    sources: {},
    answered: new Set(['simkl', 'trakt', 'mal']),
    accounts: ACCOUNTS
  }),
  [],
  'a title added here is never removed by a pull, however long it is absent'
)

// Pulled from Trakt, now gone from Trakt. This app watched it arrive and
// watched it leave: established, not inferred.
assert.deepEqual(
  plannedRemovals({
    tracked: ['tt-remote'],
    origins: { 'tt-remote': fromTrakt },
    sources: {},
    answered: new Set(['trakt']),
    accounts: ACCOUNTS
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
    origins: { 'tt-remote': fromTrakt },
    sources: {},
    answered: new Set(['simkl', 'mal']),
    accounts: ACCOUNTS
  }),
  [],
  'a service that did not answer cannot be the reason to delete anything'
)

// --- still on somebody's list ---------------------------------------------

assert.deepEqual(
  plannedRemovals({
    tracked: ['tt-remote'],
    origins: { 'tt-remote': fromTrakt },
    sources: { 'tt-remote': ['simkl'] },
    answered: new Set(['simkl', 'trakt']),
    accounts: ACCOUNTS
  }),
  [],
  'a title still on another service has not left anywhere that counts'
)

// --- already gone locally --------------------------------------------------

assert.deepEqual(
  plannedRemovals({
    tracked: [],
    origins: { 'tt-remote': fromTrakt },
    sources: {},
    answered: new Set(['trakt']),
    accounts: ACCOUNTS
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
  answered: new Set(['simkl', 'trakt', 'mal']),
  accounts: ACCOUNTS
})
assert.deepEqual(firstSync, [], 'a first sync against a fresh account removes nothing')

// --- whose account said so --------------------------------------------
//
// "It came from Trakt" is not enough to delete anything, because Trakt is
// not one person. Sign into a different Trakt and its watchlist says
// nothing at all about the titles the previous account contributed — but
// it IS a successful answer that does not contain them, which is exactly
// the shape the removal rule looks for. The account stamp is what stops
// somebody else's empty list emptying this one.
assert.deepEqual(
  plannedRemovals({
    tracked: ['tt-remote'],
    origins: { 'tt-remote': fromTrakt },
    sources: {},
    answered: new Set(['trakt']),
    accounts: { ...ACCOUNTS, trakt: 'trakt-b' }
  }),
  [],
  'a snapshot from a different account is not evidence about the first one'
)

// Records written before stamps existed name no account at all, so they
// can never be attributed to the person signed in now. They become
// ordinary unexplained titles — kept, pushed, never deleted.
assert.deepEqual(
  plannedRemovals({
    tracked: ['tt-remote'],
    origins: { 'tt-remote': { source: 'trakt', addedAt: now - HOUR } },
    sources: {},
    answered: new Set(['trakt']),
    accounts: ACCOUNTS
  }),
  [],
  'an origin with no account on it cannot justify a removal'
)

// Nothing connected: every mark is the empty string. Empty must not
// compare equal to an origin's empty stamp and let a signed-out service
// delete things.
assert.deepEqual(
  plannedRemovals({
    tracked: ['tt-remote'],
    origins: { 'tt-remote': { source: 'trakt', addedAt: now - HOUR, account: '' } },
    sources: {},
    answered: new Set(['trakt']),
    accounts: { simkl: '', trakt: '', mal: '' }
  }),
  [],
  'a disconnected service matches no stamp, not even an empty one'
)

// --- the outward half: which removals may be SENT ------------------------
//
// Simkl's removal endpoint is the one that also un-watches, because list
// membership and watched state are one record there. Sending it for a
// title Simkl never had would erase that account's watch history for it —
// so it goes only where this app has seen the title on the list.

assert.equal(
  mayRemoveAt('simkl', []),
  false,
  'no evidence the title is on Simkl means no unscoped removal is sent'
)
assert.equal(
  mayRemoveAt('simkl', ['trakt']),
  false,
  'evidence about Trakt is not evidence about Simkl'
)
assert.equal(mayRemoveAt('simkl', ['simkl', 'trakt']), true, 'seen on Simkl, so Simkl may be told')

// Scoped removals need no evidence: asking Trakt to drop something that
// is not on the watchlist drops nothing and touches no other record, and
// MAL's push checks the entry's status before deleting it.
assert.equal(mayRemoveAt('trakt', []), true, 'a watchlist-scoped removal is safe without evidence')
assert.equal(mayRemoveAt('mal', []), true, 'a status-scoped removal is safe without evidence')

console.log('ok  watchlist two-way removal rule')
