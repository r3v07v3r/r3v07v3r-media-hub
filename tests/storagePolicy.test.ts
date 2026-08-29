// "Stream only" as a promise the backend keeps, not a checkbox.
//
// The whole point of the setting is that somebody who says "do not keep
// anything on my disk" gets that, whatever the cache mode saved underneath
// happens to say. Enforcing it by hiding the disk controls would leave the
// stored mode reading 'disk' and streamCache still writing — the setting
// would be a label. So it is resolved in ONE function that everything else
// reads, and this pins that behaviour down.

import assert from 'node:assert/strict'

import { effectiveCacheMode, normalizeCacheMode } from '../src/main/media-hub/preferences'

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

// publicSettings is deliberately NOT exercised here: it reaches
// watchProviders, which calls electron's app.getLocale(), so importing it
// outside Electron throws. It is a one-line call to the function above and
// typechecked as such — the property that actually needs defending is the
// resolution, and that is what is pinned.

console.log('ok  storage policy')
