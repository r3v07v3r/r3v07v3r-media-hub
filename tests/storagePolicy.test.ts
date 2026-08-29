// "Stream only" as a promise the backend keeps, not a checkbox.
//
// The whole point of the setting is that somebody who says "do not keep
// anything on my disk" gets that, whatever the cache mode saved underneath
// happens to say. Enforcing it by hiding the disk controls would leave the
// stored mode reading 'disk' and streamCache still writing — the setting
// would be a label. So it is resolved in ONE function that everything else
// reads, and this pins that behaviour down.

import assert from 'node:assert/strict'

import {
  effectiveCacheMode,
  logoutSettings,
  normalizeCacheMode
} from '../src/main/media-hub/preferences'

// --- the resolver ----------------------------------------------------------

// Never asked. Every install that predates the question is here, and every
// one of them already stores — so absence has to read as "yes", or an
// upgrade would silently stop caching for everybody.
assert.equal(effectiveCacheMode({}), 'disk', 'an unanswered install keeps its disk cache')
assert.equal(effectiveCacheMode({ cacheMode: 'memory' }), 'memory')

// Answered yes: the saved mode is simply honoured.
assert.equal(effectiveCacheMode({ storeMedia: true, cacheMode: 'disk' }), 'disk')
assert.equal(effectiveCacheMode({ storeMedia: true, cacheMode: 'memory' }), 'memory')

// Answered no: memory, whatever is saved. This is the assertion the whole
// feature rests on.
assert.equal(
  effectiveCacheMode({ storeMedia: false, cacheMode: 'disk' }),
  'memory',
  'stream-only overrides a saved disk mode rather than trusting the UI to hide it'
)
assert.equal(effectiveCacheMode({ storeMedia: false, cacheMode: 'memory' }), 'memory')

// Junk in the stored field must not be a way past the policy.
for (const rubbish of [undefined, null, '', 'DISK', 'Disk', 0, 1, {}, []]) {
  assert.equal(
    effectiveCacheMode({ storeMedia: false, cacheMode: rubbish }),
    'memory',
    `stream-only holds for a stored mode of ${JSON.stringify(rubbish)}`
  )
}

// The saved mode is left ALONE underneath, so turning storage back on
// restores the choice made before it rather than a default.
assert.equal(
  normalizeCacheMode('disk'),
  'disk',
  'the raw normaliser still reports what was saved, policy aside'
)

// --- signing out ----------------------------------------------------------
//
// logoutSettings is the projection kept when an account signs out: device
// facts stay, account facts go. The storage answer is a device fact — it is
// about this disk — and it has to survive, for two separate reasons.

// It is not a two-state value. "Never asked" must stay never-asked, or the
// first-run dialog is skipped for somebody who signed out before answering.
assert.equal(
  'storeMedia' in logoutSettings({}),
  false,
  'an unanswered question is not answered by signing out'
)

// And an answer must not be forgotten. The dialog cannot be dismissed, so
// dropping the flag would put it back in front of somebody who has already
// dealt with it, every time they sign out.
assert.equal(logoutSettings({ storeMedia: false }).storeMedia, false)
assert.equal(logoutSettings({ storeMedia: true }).storeMedia, true)

// The RAW mode is kept, not the effective one. Writing the effective mode
// back would resolve the policy into the stored value: 'disk' would be
// overwritten with 'memory' and could never be recovered by turning storage
// on again — which is exactly what effectiveCacheMode promises not to do.
assert.equal(
  logoutSettings({ storeMedia: false, cacheMode: 'disk' }).cacheMode,
  'disk',
  'stream-only does not consume the saved disk preference on the way out'
)
assert.equal(logoutSettings({ storeMedia: true, cacheMode: 'memory' }).cacheMode, 'memory')

// And the projection still resolves correctly afterwards — the promise is
// kept by the resolver, not by what was written.
assert.equal(effectiveCacheMode(logoutSettings({ storeMedia: false, cacheMode: 'disk' })), 'memory')

// publicSettings is deliberately NOT exercised here: it reaches
// watchProviders, which calls electron's app.getLocale(), so importing it
// outside Electron throws. It is a one-line call to the function above and
// typechecked as such — the property that actually needs defending is the
// resolution, and that is what is pinned.

console.log('ok  storage policy')
