import assert from 'node:assert'
import { malStatusForProgress } from '../src/main/media-hub/mal'

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

console.log('malStatusForProgress')

check('marks an anime completed when every known episode is watched', () => {
  assert.equal(malStatusForProgress(12, 12), 'completed')
  assert.equal(malStatusForProgress(13, 12), 'completed')
})

check('returns an unmarked completed anime to watching', () => {
  assert.equal(malStatusForProgress(11, 12), 'watching')
})

check('does not guess a status without a valid total', () => {
  assert.equal(malStatusForProgress(12, undefined), undefined)
  assert.equal(malStatusForProgress(12, 0), undefined)
})

console.log(`\n${pass} passed`)
