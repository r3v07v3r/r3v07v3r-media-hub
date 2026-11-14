// Repeated-action detection for tester reports. See
// src/shared/feedback/repeatDetector.ts.
// Run with: npx tsx tests/feedbackRepeat.test.ts

import assert from 'node:assert/strict'
import { PingPongDetector, RepeatDetector } from '../src/shared/feedback/repeatDetector'

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

check('three quick presses are a rapid run', () => {
  const d = new RepeatDetector()
  assert.equal(d.note('play', 0), null)
  assert.equal(d.note('play', 400), null)
  assert.deepEqual(d.note('play', 900), { pattern: 'rapid', key: 'play', count: 3, spanMs: 900 })
})

check('three tries inside the window are a repeated run', () => {
  const d = new RepeatDetector()
  d.note('play', 0)
  d.note('play', 8_000)
  assert.equal(d.note('play', 16_000)?.pattern, 'repeated')
})

check('tries spread past the window are not a run', () => {
  const d = new RepeatDetector()
  d.note('play', 0)
  d.note('play', 15_000)
  assert.equal(d.note('play', 30_000), null)
})

check('different keys do not add up', () => {
  const d = new RepeatDetector()
  d.note('a', 0)
  d.note('b', 100)
  assert.equal(d.note('c', 200), null)
})

check('one finding per key per cooldown', () => {
  const d = new RepeatDetector({ cooldownMs: 60_000 })
  d.note('x', 0)
  d.note('x', 1)
  assert.ok(d.note('x', 2))
  for (let t = 3; t < 10; t++) assert.equal(d.note('x', t), null)
  d.note('x', 61_000)
  d.note('x', 61_001)
  assert.ok(d.note('x', 61_002))
})

check('back and forth between two screens is noticed once', () => {
  const p = new PingPongDetector()
  assert.equal(p.note('/movies', 0), null)
  assert.equal(p.note('/movies/1', 2_000), null)
  assert.equal(p.note('/movies', 4_000), null)
  assert.equal(p.note('/movies/1', 6_000), null)
  assert.deepEqual(p.note('/movies', 8_000), { a: '/movies', b: '/movies/1', spanMs: 8_000 })
  p.note('/movies/1', 9_000)
  assert.equal(p.note('/movies', 10_000), null)
})

check('ordinary browsing is not ping-pong', () => {
  const p = new PingPongDetector()
  for (const [i, route] of ['/', '/movies', '/movies/1', '/movies', '/series'].entries()) {
    assert.equal(p.note(route, i * 1000), null)
  }
})

console.log(`\n${pass} passed`)
