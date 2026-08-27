// The two pure functions behind frame-step/A-B loop/screenshot — the parts
// that are actually worth getting wrong, pulled out of a React click handler
// and an Electron-only module so they can be pinned down here instead of
// only living where a test cannot reach them.

import assert from 'node:assert/strict'

import { nextAbLoopPoint, screenshotFilename } from '../src/shared/media-hub/player'

// ---------------------------------------------------------------------
// A-B loop cycling.
// ---------------------------------------------------------------------

// Nothing set -> A.
assert.deepEqual(nextAbLoopPoint(null, 42), { a: 42, b: null })

// A set, B not -> both, ordered forward even when the second press landed
// BEFORE the first — mpv's loop only ever plays forward, and a>b would not
// error, it would just silently never loop.
assert.deepEqual(nextAbLoopPoint({ a: 100, b: null }, 130), { a: 100, b: 130 })
assert.deepEqual(
  nextAbLoopPoint({ a: 100, b: null }, 40),
  { a: 40, b: 100 },
  'the later timestamp is always B, regardless of press order'
)

// A and B both set -> a third press clears everything.
assert.equal(nextAbLoopPoint({ a: 40, b: 100 }, 999), null)

// A whole cycle returns to where it started.
{
  let point: { a: number; b: number | null } | null = null
  point = nextAbLoopPoint(point, 10)
  point = nextAbLoopPoint(point, 20)
  point = nextAbLoopPoint(point, 30)
  assert.equal(point, null)
}

// ---------------------------------------------------------------------
// Screenshot filenames.
// ---------------------------------------------------------------------
const when = new Date('2026-08-27T14:30:05.123Z')

assert.equal(
  screenshotFilename({ title: 'Dune', seasonNumber: undefined, episodeNumber: undefined }, when),
  'Dune - 2026-08-27 14-30-05.jpg'
)

// An episode carries its coordinate — a folder of these should tell two
// episodes of the same show apart at a glance.
assert.equal(
  screenshotFilename({ title: 'Severance', seasonNumber: 2, episodeNumber: 7 }, when),
  'Severance - S02E07 - 2026-08-27 14-30-05.jpg'
)

// Reserved filesystem characters are stripped — Windows' rules are the
// strictest of the three platforms this ships to, so satisfying them
// satisfies all three. A colon is common in real titles ("Dune: Part Two")
// and must not survive into the filename.
assert.equal(
  screenshotFilename(
    { title: 'Dune: Part Two', seasonNumber: undefined, episodeNumber: undefined },
    when
  ),
  'Dune Part Two - 2026-08-27 14-30-05.jpg'
)

// No media playing at all — the caller is not expected to guard this, the
// function has an honest fallback of its own.
assert.equal(screenshotFilename(null, when), 'Screenshot - 2026-08-27 14-30-05.jpg')

// A title that sanitizes down to nothing does not produce a bare timestamp
// with a leading " - ".
assert.equal(
  screenshotFilename({ title: '***', seasonNumber: undefined, episodeNumber: undefined }, when),
  'Untitled - 2026-08-27 14-30-05.jpg'
)

console.log('player precision tests passed')
