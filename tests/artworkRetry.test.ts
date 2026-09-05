// The rule behind ArtworkImage's one retry, and which picture an episode
// tile shows. Run with: npx tsx tests/artworkRetry.test.ts

import assert from 'node:assert/strict'

import {
  ARTWORK_MAX_RETRIES,
  episodeStillOrShowArt,
  initialArtworkState,
  nextArtworkState
} from '../src/renderer/src/components/media/artworkRetry'

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

check('a src starts loading; no src is the fallback at once', () => {
  assert.deepEqual(initialArtworkState('https://x/a.jpg'), { status: 'loading', attempts: 0 })
  assert.deepEqual(initialArtworkState(''), { status: 'error', attempts: 0 })
  assert.deepEqual(initialArtworkState(undefined), { status: 'error', attempts: 0 })
})

check('the first failure retries once, the second is terminal', () => {
  assert.equal(ARTWORK_MAX_RETRIES, 1)
  const first = nextArtworkState(initialArtworkState('u'), 'error')
  assert.equal(first.status, 'retrying')
  const retried = nextArtworkState(first, 'retry')
  assert.deepEqual(
    retried,
    { status: 'loading', attempts: 1 },
    'a new attempt number remounts the image'
  )
  const second = nextArtworkState(retried, 'error')
  assert.equal(second.status, 'error')
  assert.equal(nextArtworkState(second, 'retry').status, 'error', 'no retry after the last failure')
})

check('a load settles it, and a stray retry event changes nothing', () => {
  const loaded = nextArtworkState(initialArtworkState('u'), 'load')
  assert.equal(loaded.status, 'loaded')
  assert.equal(nextArtworkState(loaded, 'retry'), loaded)
})

check('an episode still wins, the show art fills in, nothing else is drawn', () => {
  assert.equal(
    episodeStillOrShowArt({ thumbnail: 'https://x/still.jpg' }, 'https://x/show.jpg'),
    'https://x/still.jpg'
  )
  assert.equal(episodeStillOrShowArt({ thumbnail: '' }, 'https://x/show.jpg'), 'https://x/show.jpg')
  assert.equal(
    episodeStillOrShowArt({ thumbnail: '  ' }, ' https://x/show.jpg '),
    'https://x/show.jpg'
  )
  assert.equal(episodeStillOrShowArt(undefined, undefined), undefined)
  assert.equal(episodeStillOrShowArt({ thumbnail: null }, ''), undefined)
})

console.log(`\n${pass} passed`)
