// Unit tests for the compact picture-control contract
// (src/shared/media-hub/videoPicture.ts).

import assert from 'node:assert'
import {
  DEFAULT_VIDEO_PICTURE,
  VIDEO_PICTURE_CONTROLS,
  VIDEO_PICTURE_MAX,
  VIDEO_PICTURE_MIN,
  isVideoPictureControl
} from '../src/shared/media-hub/videoPicture'

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

check('offers a deliberately small set of live picture controls', () => {
  assert.deepStrictEqual(
    VIDEO_PICTURE_CONTROLS.map(({ control }) => control),
    ['brightness', 'contrast', 'saturation', 'gamma']
  )
})

check('defaults preserve the original picture', () => {
  assert.deepStrictEqual(DEFAULT_VIDEO_PICTURE, {
    brightness: 0,
    contrast: 0,
    saturation: 0,
    gamma: 0
  })
})

check('only the named controls can cross the player IPC boundary', () => {
  for (const { control } of VIDEO_PICTURE_CONTROLS)
    assert.strictEqual(isVideoPictureControl(control), true)
  for (const value of [undefined, null, '', 'hue', 'vf', 0, {}, []]) {
    assert.strictEqual(isVideoPictureControl(value), false)
  }
})

check('MPV range is symmetric around the unadjusted value', () => {
  assert.strictEqual(VIDEO_PICTURE_MIN, -100)
  assert.strictEqual(VIDEO_PICTURE_MAX, 100)
})

console.log(`\n${pass} checks passed`)
