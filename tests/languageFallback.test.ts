// Unit tests for which copy play:stream settles on when the first one is in
// the wrong language (src/main/media-hub/languageFallback.ts), and for
// languageFit, the per-file verdict it works from.
// Run with: npx tsx tests/languageFallback.test.ts

import assert from 'node:assert'
import { languageFit } from '../src/shared/media-hub/language'
import {
  LANGUAGE_RETRY_LIMIT,
  languageTryOrder,
  pickFallback,
  sourceKey
} from '../src/main/media-hub/languageFallback'
import type { StreamCandidate } from '../src/shared/media-hub/types'

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

const copy = (n: number): StreamCandidate =>
  ({ infoHash: String(n).repeat(40).slice(0, 40), name: `copy ${n}` }) as StreamCandidate
const [a, b, c, d, e, f] = [1, 2, 3, 4, 5, 6].map(copy)
const jaNoSubs = { audio: false, subtitles: false }
const jaEnSubs = { audio: false, subtitles: true }
const english = { audio: true, subtitles: false }

console.log('languageFit')
const jaOnly = { audio: [{ language: 'jpn' }], subtitle: [] }
check('japanese with no subtitles fits neither', () =>
  assert.deepEqual(languageFit(jaOnly, 'en', 'en'), jaNoSubs)
)
check('english subtitles count', () =>
  assert.deepEqual(
    languageFit({ audio: [{ language: 'jpn' }], subtitle: [{ language: 'eng' }] }, 'en', 'en'),
    jaEnSubs
  )
)
check('dual audio fits the audio', () =>
  assert.equal(
    languageFit({ audio: [{ language: 'jpn' }, { language: 'eng' }], subtitle: [] }, 'en', 'en')
      .audio,
    true
  )
)
check('no subtitle language asked for is a fit', () =>
  assert.equal(languageFit(jaOnly, 'en', '').subtitles, true)
)

console.log('\nlanguageTryOrder')
check('nothing known: the pick, then the ranked alternates', () =>
  assert.deepEqual(languageTryOrder(a, [b, c], {}), [a, b, c])
)
check('capped at the pick plus the retry limit', () =>
  assert.equal(languageTryOrder(a, [b, c, d, e, f], {}).length, 1 + LANGUAGE_RETRY_LIMIT)
)
check('copies known to lack the audio are not opened again', () =>
  assert.deepEqual(languageTryOrder(a, [b, c], { [sourceKey(a)]: jaNoSubs }), [b, c])
)
check('a copy known to have the audio goes first', () =>
  assert.deepEqual(languageTryOrder(a, [b, c], { [sourceKey(c)]: english }), [c, a, b])
)
check('every copy known to lack it: the closest one, once', () =>
  assert.deepEqual(
    languageTryOrder(a, [b, c], {
      [sourceKey(a)]: jaNoSubs,
      [sourceKey(b)]: jaEnSubs,
      [sourceKey(c)]: jaNoSubs
    }),
    [b]
  )
)
check('the same copy listed twice is opened once', () =>
  assert.deepEqual(languageTryOrder(a, [a, b], {}), [a, b])
)

console.log('\npickFallback')
check('english subtitles beat none', () =>
  assert.equal(
    pickFallback([
      { stream: a, fit: jaNoSubs },
      { stream: b, fit: jaEnSubs }
    ]),
    b
  )
)
check('otherwise the ranked pick', () =>
  assert.equal(
    pickFallback([
      { stream: a, fit: jaNoSubs },
      { stream: b, fit: jaNoSubs }
    ]),
    a
  )
)
check('nothing tried is null', () => assert.equal(pickFallback([]), null))

console.log(`\n${pass} passed`)
