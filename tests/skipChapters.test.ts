// Skip-intro/credits windows derived from a file's own chapter marks — the
// Aniskip-free path for movies and series (shared/media-hub/skipChapters.ts).
//
// Two things are being pinned down: that a genuine, well-placed chapter
// gets a correct window, and that everything this exists to NOT act on —
// a wrong name, a wrong position, an unreasonably long "intro" — is left
// alone rather than guessed at.

import assert from 'node:assert/strict'

import { skipWindowsFromChapters } from '../src/shared/media-hub/skipChapters'

const DURATION = 1400 // ~23 minutes, a typical TV episode

// ---------------------------------------------------------------------
// The ordinary case.
// ---------------------------------------------------------------------
{
  const chapters = [
    { title: 'Cold Open', time: 0 },
    { title: 'Opening Credits', time: 45 },
    { title: 'Act One', time: 135 },
    { title: 'Act Two', time: 600 },
    { title: 'End Credits', time: 1350 }
  ]
  const windows = skipWindowsFromChapters(chapters, DURATION)
  assert.deepEqual(windows, {
    intro: { start: 45, end: 135 },
    // Credits run to the end of the FILE, not to a next chapter — there
    // rarely is one, and "skip credits" means "go to the end", not "go to
    // whatever chapter happens to follow".
    credits: { start: 1350, end: DURATION }
  })
}

// Case and a trailing ellipsis, either spelling, are the same title.
{
  const chapters = [
    { title: '  PREVIOUSLY ON…  ', time: 10 },
    { title: 'Act One', time: 120 }
  ]
  assert.deepEqual(skipWindowsFromChapters(chapters, DURATION), {
    intro: { start: 10, end: 120 }
  })
  const dots = skipWindowsFromChapters(
    [
      { title: 'Previously On...', time: 10 },
      { title: 'Act One', time: 120 }
    ],
    DURATION
  )
  assert.deepEqual(dots, { intro: { start: 10, end: 120 } })
}

// ---------------------------------------------------------------------
// The name gate: only the literal allowlist, no substring matching.
// ---------------------------------------------------------------------
{
  // Contains "intro" but is not the word "Intro" — must not match. This is
  // the exact false-positive substring matching would produce.
  const chapters = [
    { title: 'Introduction to the Order', time: 10 },
    { title: 'Act One', time: 120 }
  ]
  assert.equal(skipWindowsFromChapters(chapters, DURATION), null)
}

// ---------------------------------------------------------------------
// The position gate: a matching name in the wrong PLACE is not trusted
// either.
// ---------------------------------------------------------------------
{
  // "Recap" three-quarters through the runtime — a flashback scene that
  // happens to share the name, not an episode-opening recap.
  const chapters = [
    { title: 'Act One', time: 0 },
    { title: 'Recap', time: 1100 },
    { title: 'Act Two', time: 1200 }
  ]
  assert.equal(skipWindowsFromChapters(chapters, DURATION), null)
}
{
  // "Credits" in the first few minutes — not a real ending.
  const chapters = [
    { title: 'Credits', time: 30 },
    { title: 'Act One', time: 120 }
  ]
  assert.equal(skipWindowsFromChapters(chapters, DURATION), null)
}

// ---------------------------------------------------------------------
// No next chapter to bound an intro against: left unoffered rather than
// guessed at with an arbitrary cap.
// ---------------------------------------------------------------------
{
  const chapters = [{ title: 'Opening Credits', time: 10 }]
  assert.equal(skipWindowsFromChapters(chapters, DURATION), null)
}

// ---------------------------------------------------------------------
// A "match" that runs unreasonably long is not really an opening
// sequence — some other convention this app has not seen before.
// ---------------------------------------------------------------------
{
  const chapters = [
    { title: 'Intro', time: 0 },
    { title: 'Act One', time: 400 } // a 400s "intro" — far past MAX_INTRO_SECONDS
  ]
  assert.equal(skipWindowsFromChapters(chapters, DURATION), null)
}

// ---------------------------------------------------------------------
// Guards.
// ---------------------------------------------------------------------
assert.equal(skipWindowsFromChapters([], DURATION), null)
assert.equal(skipWindowsFromChapters([{ title: 'Intro', time: 0 }], 0), null)
assert.equal(skipWindowsFromChapters([{ title: 'Intro', time: 0 }], Number.NaN), null)

console.log('skip chapters tests passed')
