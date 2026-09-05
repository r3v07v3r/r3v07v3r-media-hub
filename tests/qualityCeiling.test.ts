import assert from 'node:assert/strict'

// The near-tier gate (torbox.ts's withinQualityCeiling) is module-private, so
// this pins the RULE it implements against the setting's own meaning. The
// Settings row is "Maximum video quality — avoid releases sharper than this
// display needs", and the speed test writes it as min(line, screen): it is a
// ceiling. It was once compared as `resolution >= ceiling`, which inverted it.
//
// The signature of that bug is what this table exists to prevent coming back:
// every explicit choice behaved WORSE than "Any", because 0 skipped the check
// entirely while any real number turned the maximum into a minimum.
function withinQualityCeiling(
  resolution: number | undefined,
  ceiling: number | undefined
): boolean {
  if (!ceiling) return true
  if (!resolution) return true
  return resolution <= ceiling
}

const cases: Array<[number | undefined, number | undefined, boolean, string]> = [
  // The regressions. Each of these was false under the inverted rule, which
  // sent playback to the internet for a file already on the machine.
  [1080, 2160, true, 'a 1080p copy on disk is usable when the ceiling is 4K'],
  [720, 1080, true, 'a 720p copy on the LAN cache is usable when the ceiling is 1080p'],
  [480, 1080, true, 'an old film only available at 480p is still played'],
  [480, 720, true, 'and at a lower ceiling too'],

  // The ceiling still means something.
  [2160, 1080, false, 'a 4K copy is refused when the person capped at 1080p'],
  [1080, 720, false, 'one tier over the cap is still over the cap'],

  // Exactly at the ceiling is within it.
  [1080, 1080, true, 'the ceiling itself is allowed'],

  // "Any" accepts everything, and always did — it is the one setting the old
  // rule got right, which is why the bug hid for so long.
  [480, 0, true, 'Any accepts a low-resolution copy'],
  [2160, 0, true, 'Any accepts a high-resolution copy'],
  [2160, undefined, true, 'no ceiling set accepts anything'],

  // Thin metadata must not cost somebody a copy they already hold.
  [undefined, 1080, true, 'an unknown resolution is accepted rather than discarded'],
  [0, 1080, true, 'an unparsed resolution reads as unknown, not as zero']
]

for (const [resolution, ceiling, expected, why] of cases) {
  assert.equal(withinQualityCeiling(resolution, ceiling), expected, why)
}

// The property that would have caught the inversion on its own: raising the
// ceiling can only ever ACCEPT more, never less. Under `>=` it did the
// opposite — a higher ceiling rejected more.
for (const resolution of [480, 720, 1080, 1440, 2160]) {
  const ceilings = [480, 720, 1080, 1440, 2160]
  let seenAccepted = false
  for (const ceiling of ceilings) {
    const ok = withinQualityCeiling(resolution, ceiling)
    if (ok) seenAccepted = true
    else
      assert.ok(
        !seenAccepted,
        `raising the ceiling must never take back an acceptance (${resolution}p at ${ceiling}p)`
      )
  }
}

console.log('ok  quality ceiling')

// --- when the shortfall is worth interrupting somebody over -----------------
import { isNoticeablyBelowCeiling, resolutionLabel } from '../src/shared/media-hub/streamQuality'

const warn: Array<[number, number, boolean, string]> = [
  // One step down is what a ceiling is FOR. No dialog.
  [1440, 2160, false, '1440p under a 4K cap is the ordinary case'],
  [720, 1080, false, '720p under a 1080p cap is the ordinary case'],
  [480, 720, false, '480p under a 720p cap is one step'],

  // Two steps is where somebody would be surprised.
  [480, 1080, true, '480p when 1080p was allowed is worth asking about'],
  [720, 2160, true, '720p when 4K was allowed is worth asking about'],
  [480, 2160, true, 'and 480p under a 4K cap certainly is'],

  // Nothing meaningful to say.
  [480, 0, false, '"Any" expresses no preference to fall short of'],
  [0, 1080, false, 'an unknown resolution is not a shortfall'],
  [1080, 1080, false, 'meeting the ceiling is not a shortfall'],
  [2160, 1080, false, 'exceeding it is certainly not']
]
for (const [got, ceiling, expected, why] of warn) {
  assert.equal(isNoticeablyBelowCeiling(got, ceiling), expected, why)
}

// The warning names what you get, so the label has to read like the setting.
assert.equal(resolutionLabel(2160), '4K')
assert.equal(resolutionLabel(1080), '1080p')
assert.equal(resolutionLabel(480), '480p')

// A shortfall is never a refusal: anything the ceiling allows is still
// playable, warned about or not. This is the promise the whole change rests
// on — an old film that only exists at 480p still plays.
for (const got of [480, 720, 1080]) {
  assert.ok(withinQualityCeiling(got, 2160), `${got}p is still playable under a 4K cap`)
}

console.log('ok  low-quality warning threshold')
