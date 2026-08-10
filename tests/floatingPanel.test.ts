import assert from 'node:assert/strict'
import { positionFloatingPanel } from '../src/renderer/src/lib/floatingPanel'

const cases: Array<
  [string, Parameters<typeof positionFloatingPanel>, { left: number; top: number }]
> = [
  ['keeps an ordinary pointer position', [100, 120, 224, 320, 1280, 720], { left: 100, top: 120 }],
  [
    'moves a panel away from the bottom-right edge',
    [1270, 710, 224, 320, 1280, 720],
    { left: 1048, top: 392 }
  ],
  ['keeps a margin at the top-left edge', [-20, -40, 224, 320, 1280, 720], { left: 8, top: 8 }],
  [
    'does not produce negative coordinates in a tiny viewport',
    [100, 100, 224, 320, 180, 240],
    { left: 8, top: 8 }
  ]
]

for (const [name, args, expected] of cases) {
  assert.deepEqual(positionFloatingPanel(...args), expected, name)
  console.log(`ok  ${name}`)
}
