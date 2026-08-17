import assert from 'node:assert/strict'
import {
  DEAD_ZONE_SECONDS,
  HARD_SEEK_SECONDS,
  MAX_RATE_DELTA,
  SAMPLE_MAX_AGE_MS,
  expectedHostPosition,
  isSampleUsable,
  syncCorrection
} from '../src/shared/media-hub/partySync'

const sample = { mediaTime: 20, arrivedAt: 1_000, paused: false }

assert.equal(expectedHostPosition(sample, 3_500), 22.5)
assert.equal(expectedHostPosition({ ...sample, paused: true }, 3_500), 20)
assert.equal(expectedHostPosition(sample, 500), 20)

assert.equal(isSampleUsable(sample, 1_000 + SAMPLE_MAX_AGE_MS), true)
assert.equal(isSampleUsable(sample, 1_000 + SAMPLE_MAX_AGE_MS + 1), false)
assert.equal(isSampleUsable(sample, 999), false)
assert.equal(isSampleUsable({ ...sample, mediaTime: Number.NaN }, 1_000), false)

assert.deepEqual(syncCorrection(10, 10 + DEAD_ZONE_SECONDS / 2), { action: 'none' })
assert.deepEqual(syncCorrection(10, 10.5), { action: 'rate', rate: 1.04 })
assert.deepEqual(syncCorrection(10.5, 10), { action: 'rate', rate: 0.96 })
assert.deepEqual(syncCorrection(0, 100), { action: 'seek', position: 100 })
// Exactly at the hard-seek threshold is still steered, not seeked (the check
// is strictly greater-than), and the proportional term has saturated by then.
assert.deepEqual(syncCorrection(0, HARD_SEEK_SECONDS), {
  action: 'rate',
  rate: 1 + MAX_RATE_DELTA
})
// A hair past it flips to a seek. One threshold now, not one per playback
// mode — see HARD_SEEK_SECONDS.
assert.deepEqual(syncCorrection(0, HARD_SEEK_SECONDS + 0.01), {
  action: 'seek',
  position: HARD_SEEK_SECONDS + 0.01
})
assert.deepEqual(syncCorrection(Number.NaN, 10), { action: 'none' })
assert.deepEqual(syncCorrection(10, Number.POSITIVE_INFINITY), { action: 'none' })

console.log('party sync tests passed')
