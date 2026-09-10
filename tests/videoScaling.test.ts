// GPU scaler presets (src/shared/media-hub/videoScaling.ts). The live
// "Scaling" menu in the player writes every property of a preset in turn,
// so each preset must name all three and only known mpv properties.

import assert from 'node:assert/strict'

import {
  VIDEO_SCALING_PRESETS,
  normalizeVideoScaling,
  scalerPropertiesFor,
  videoScalingDescription,
  videoScalingLabel
} from '../src/shared/media-hub/videoScaling'

assert.deepEqual([...VIDEO_SCALING_PRESETS], ['auto', 'high', 'sharp'])

for (const preset of VIDEO_SCALING_PRESETS) {
  const properties = scalerPropertiesFor(preset)
  assert.deepEqual(Object.keys(properties).sort(), ['cscale', 'dscale', 'scale'], preset)
  for (const value of Object.values(properties)) assert.match(value, /^[a-z0-9_]+$/)
  assert.ok(videoScalingLabel(preset).length > 0)
  assert.ok(videoScalingDescription(preset).length > 0)
  assert.equal(normalizeVideoScaling(preset), preset)
}

// The three labels are distinct — the menu shows them side by side.
assert.equal(new Set(VIDEO_SCALING_PRESETS.map(videoScalingLabel)).size, 3)

assert.equal(normalizeVideoScaling('ultra'), 'auto')
assert.equal(normalizeVideoScaling(undefined), 'auto')
assert.equal(normalizeVideoScaling(null), 'auto')

console.log('video scaling tests passed')
