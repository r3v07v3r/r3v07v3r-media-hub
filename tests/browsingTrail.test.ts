// Unit tests for the contextual back trail's route classification
// (src/renderer/src/lib/mediaHub/browsingContext.ts's isDetailRoute) and
// the push/pop rule AppStateContext builds on it.
// Run with: npx tsx tests/browsingTrail.test.ts   (or npm.cmd test)
//
// The rule is one line in openDetail, and the bug it fixes took two clicks
// to reach: a single-slot origin meant opening a sequel from a film's own
// page overwrote where the film had been opened from, so backing out of the
// sequel returned to the film and then pointed Back at the film's own route
// — a loop with no way out to the grid. The stack itself is trivial; what
// is worth pinning is WHICH routes extend a chain versus start a new one,
// since getting that wrong either strands the old trail or never unwinds.

import assert from 'node:assert'
import { isDetailRoute } from '../src/renderer/src/lib/mediaHub/browsingContext'

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

check('a title page is a detail route', () => {
  for (const p of ['/movies/tt0111161', '/series/tt0903747', '/anime/kitsu-1376']) {
    assert.strictEqual(isDetailRoute(p), true, p)
  }
})

check('a browse page is not — it is where a chain starts', () => {
  for (const p of ['/movies', '/series', '/anime', '/', '/my-stuff', '/downloads', '/moods']) {
    assert.strictEqual(isDetailRoute(p), false, p)
  }
})

check('neighbouring routes are not mistaken for titles', () => {
  // A person page is a drill-down but not a title, and a filtered browse
  // page is still a browse page — both must start a fresh chain.
  assert.strictEqual(isDetailRoute('/people/Christopher%20Nolan'), false)
  assert.strictEqual(isDetailRoute('/movies/tt1/extra'), false)
  assert.strictEqual(isDetailRoute('/settings'), false)
})

// The push rule, exactly as openDetail applies it.
const MAX_TRAIL = 20
function open(trail: string[], fromPath: string, label: string): string[] {
  return (isDetailRoute(fromPath) ? [...trail, label] : [label]).slice(-MAX_TRAIL)
}

check('opening a sequel from a film keeps the grid it was opened from', () => {
  // The reported bug, start to finish.
  let trail = open([], '/movies', 'Trending Movies')
  assert.deepStrictEqual(trail, ['Trending Movies'])
  trail = open(trail, '/movies/tt1', 'Movie 1')
  assert.deepStrictEqual(trail, ['Trending Movies', 'Movie 1'])
  // Back unwinds one step per press, and reaches the grid rather than
  // looping on the film — which is what a single slot did.
  assert.strictEqual(trail.pop(), 'Movie 1')
  assert.strictEqual(trail.pop(), 'Trending Movies')
  assert.strictEqual(trail.pop(), undefined) // caller falls back to /movies
})

check('a chain deeper than two still unwinds a step at a time', () => {
  let trail = open([], '/', 'Home')
  trail = open(trail, '/movies/a', 'A')
  trail = open(trail, '/movies/b', 'B')
  trail = open(trail, '/anime/c', 'C')
  assert.deepStrictEqual(trail, ['Home', 'A', 'B', 'C'])
})

check('leaving mid-chain by the nav rail does not leak into the next chain', () => {
  // Nothing pops when someone abandons a chain by clicking Movies or Home,
  // so the next drill-down has to reset rather than stack on top of a trail
  // whose routes nobody is coming back to.
  let trail = open([], '/movies', 'Trending Movies')
  trail = open(trail, '/movies/tt1', 'Movie 1')
  trail = open(trail, '/my-stuff', 'My List')
  assert.deepStrictEqual(trail, ['My List'])
})

check('the trail is capped, keeping the most recent steps', () => {
  let trail = open([], '/movies', 'grid')
  for (let i = 0; i < 40; i++) trail = open(trail, '/movies/x', `step-${i}`)
  assert.strictEqual(trail.length, MAX_TRAIL)
  // Oldest drop first: the steps anyone presses Back through survive.
  assert.strictEqual(trail[trail.length - 1], 'step-39')
  assert.strictEqual(trail[0], `step-${40 - MAX_TRAIL}`)
})

console.log(`\n${pass} checks passed`)
