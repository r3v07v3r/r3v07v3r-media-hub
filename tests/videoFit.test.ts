// Unit tests for the fit-mode mapping (src/shared/media-hub/videoFit.ts).
// Run with: npx tsx tests/videoFit.test.ts   (or npm.cmd test)
//
// This mapping is worth pinning because getting it wrong is silent. Every
// combination of `keepaspect` and `panscan` is a valid mpv state that plays a
// title perfectly well — the only symptom of a wrong pair is a picture that is
// cropped, stretched or letterboxed when the person asked for something else,
// which nothing in the app can detect and report.
//
// The other half is `normalizeVideoFit`, which is what stands between an IPC
// payload and two property writes.

import assert from 'node:assert'
import {
  DEFAULT_VIDEO_FIT,
  VIDEO_FIT_MODES,
  mpvPropertiesForFit,
  normalizeVideoFit,
  videoFitDescription,
  videoFitLabel,
  type VideoFitMode
} from '../src/shared/media-hub/videoFit'

let pass = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

check('fit keeps the aspect ratio and does not zoom', () => {
  assert.deepStrictEqual(mpvPropertiesForFit('contain'), { keepaspect: true, panscan: 0 })
})

check('fill crops to the window without distorting', () => {
  // panscan 1 is the whole point: keepaspect alone would letterbox.
  assert.deepStrictEqual(mpvPropertiesForFit('cover'), { keepaspect: true, panscan: 1 })
})

check('stretch is the only mode that abandons the aspect ratio', () => {
  assert.deepStrictEqual(mpvPropertiesForFit('fill'), { keepaspect: false, panscan: 0 })
  const distorting = VIDEO_FIT_MODES.filter((mode) => !mpvPropertiesForFit(mode).keepaspect)
  assert.deepStrictEqual(distorting, ['fill'])
})

check('every mode writes both properties, so no two modes collide', () => {
  const pairs = VIDEO_FIT_MODES.map((mode) => JSON.stringify(mpvPropertiesForFit(mode)))
  assert.strictEqual(new Set(pairs).size, VIDEO_FIT_MODES.length)
})

check('the default is the non-destructive one', () => {
  // Anything that crops or stretches has to be asked for — never landed on by
  // a missing value.
  assert.strictEqual(DEFAULT_VIDEO_FIT, 'contain')
  assert.deepStrictEqual(mpvPropertiesForFit(DEFAULT_VIDEO_FIT), { keepaspect: true, panscan: 0 })
})

check('normalize passes the three real modes through untouched', () => {
  for (const mode of VIDEO_FIT_MODES) assert.strictEqual(normalizeVideoFit(mode), mode)
})

check('normalize falls back for anything else', () => {
  // Everything an untrusted IPC payload can actually be.
  for (const value of [undefined, null, '', 'COVER', 'contains', 0, 1, {}, [], true]) {
    assert.strictEqual(normalizeVideoFit(value), DEFAULT_VIDEO_FIT)
  }
})

check('labels are distinct, so the button always names one mode', () => {
  const labels = VIDEO_FIT_MODES.map(videoFitLabel)
  assert.deepStrictEqual(labels, ['Fit', 'Fill', 'Stretch'])
  assert.strictEqual(new Set(labels).size, labels.length)
})

check('every mode has a label and a description', () => {
  for (const mode of VIDEO_FIT_MODES) {
    assert.ok(videoFitLabel(mode).length > 0, `no label for ${mode}`)
    assert.ok(videoFitDescription(mode).length > 0, `no description for ${mode}`)
  }
})

check('an unrecognized mode still renders as the default rather than blank', () => {
  const bogus = 'sideways' as VideoFitMode
  assert.strictEqual(videoFitLabel(bogus), 'Fit')
  assert.deepStrictEqual(mpvPropertiesForFit(bogus), { keepaspect: true, panscan: 0 })
})

console.log(`
${pass} checks passed`)
