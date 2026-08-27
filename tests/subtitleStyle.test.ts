// Subtitle appearance: the normalizer and the mpv property mapping.
//
// Both are worth pinning down for the same reason. The style is persisted, so
// the normalizer is the thing standing between a settings file written by a
// different build (or hand-edited, or half-written) and a player that refuses
// to start. The mapping is the thing standing between four sliders and mpv's
// own vocabulary, where "no backdrop" is expressed as a transparent colour
// rather than a switch — the kind of detail that is easy to get backwards and
// impossible to notice without a subtitle on screen.

import assert from 'node:assert/strict'

import {
  DEFAULT_SUBTITLE_STYLE,
  isSubtitleStyleDefault,
  normalizeSubtitleStyle,
  subtitleStyleProperties,
  SUBTITLE_POSITION_MAX,
  SUBTITLE_POSITION_MIN,
  SUBTITLE_SCALE_MAX,
  SUBTITLE_SCALE_MIN
} from '../src/shared/media-hub/subtitleStyle'

// ---------------------------------------------------------------------
// Nothing stored, and nothing sensible stored, both give the default.
// ---------------------------------------------------------------------
assert.deepEqual(normalizeSubtitleStyle(undefined), DEFAULT_SUBTITLE_STYLE)
assert.deepEqual(normalizeSubtitleStyle(null), DEFAULT_SUBTITLE_STYLE)
assert.deepEqual(normalizeSubtitleStyle({}), DEFAULT_SUBTITLE_STYLE)
assert.deepEqual(normalizeSubtitleStyle('nonsense'), DEFAULT_SUBTITLE_STYLE)

// ---------------------------------------------------------------------
// Every field falls back on its own, so one bad value does not discard the
// three good ones beside it.
// ---------------------------------------------------------------------
{
  const mixed = normalizeSubtitleStyle({
    scale: 1.4,
    position: 72,
    background: true,
    color: 'chartreuse'
  })
  assert.equal(mixed.scale, 1.4)
  assert.equal(mixed.position, 72)
  assert.equal(mixed.background, true)
  assert.equal(mixed.color, DEFAULT_SUBTITLE_STYLE.color, 'only the unknown colour fell back')
}

// ---------------------------------------------------------------------
// Out-of-range values are clamped rather than refused: a stored 9 is somebody
// (or an older build) having meant "as large as it goes".
// ---------------------------------------------------------------------
assert.equal(normalizeSubtitleStyle({ scale: 9 }).scale, SUBTITLE_SCALE_MAX)
assert.equal(normalizeSubtitleStyle({ scale: -3 }).scale, SUBTITLE_SCALE_MIN)
assert.equal(normalizeSubtitleStyle({ position: 999 }).position, SUBTITLE_POSITION_MAX)
assert.equal(normalizeSubtitleStyle({ position: 0 }).position, SUBTITLE_POSITION_MIN)
assert.equal(normalizeSubtitleStyle({ scale: Number.NaN }).scale, SUBTITLE_SCALE_MIN)

// A position always comes back a whole number — mpv takes an integer, and a
// slider that produced 72.4 would otherwise be applied and then read back
// differently.
assert.equal(normalizeSubtitleStyle({ position: 72.6 }).position, 73)

// `background` is strictly a boolean: a stored string must not switch the
// backdrop on by being truthy.
assert.equal(normalizeSubtitleStyle({ background: 'yes' as unknown as boolean }).background, false)

// ---------------------------------------------------------------------
// "Is this the untouched look" drives both the modified dot and whether Reset
// does anything, so each field has to count.
// ---------------------------------------------------------------------
assert.equal(isSubtitleStyleDefault(DEFAULT_SUBTITLE_STYLE), true)
assert.equal(isSubtitleStyleDefault({ ...DEFAULT_SUBTITLE_STYLE, scale: 1.2 }), false)
assert.equal(isSubtitleStyleDefault({ ...DEFAULT_SUBTITLE_STYLE, position: 80 }), false)
assert.equal(isSubtitleStyleDefault({ ...DEFAULT_SUBTITLE_STYLE, background: true }), false)
assert.equal(isSubtitleStyleDefault({ ...DEFAULT_SUBTITLE_STYLE, color: 'yellow' }), false)

// ---------------------------------------------------------------------
// The mpv mapping.
// ---------------------------------------------------------------------
{
  const plain = subtitleStyleProperties(DEFAULT_SUBTITLE_STYLE)
  assert.equal(plain['sub-scale'], 1)
  assert.equal(plain['sub-pos'], 100)
  assert.equal(plain['sub-color'], '#FFFFFF')
  // No backdrop is a FULLY TRANSPARENT colour, not an absent property — mpv
  // has no separate switch, and omitting it would leave whatever the previous
  // title set still in force.
  assert.equal(plain['sub-back-color'], '#00000000')

  const boxed = subtitleStyleProperties({
    scale: 1.5,
    position: 80,
    background: true,
    color: 'yellow'
  })
  assert.equal(boxed['sub-scale'], 1.5)
  assert.equal(boxed['sub-pos'], 80)
  assert.equal(boxed['sub-color'], '#F4CB45')
  assert.notEqual(boxed['sub-back-color'], '#00000000', 'a backdrop is not transparent')

  // Every style maps to the same four properties, so switching a setting off
  // always overwrites what the previous one set.
  assert.deepEqual(Object.keys(plain), Object.keys(boxed))
}

console.log('subtitle style tests passed')
