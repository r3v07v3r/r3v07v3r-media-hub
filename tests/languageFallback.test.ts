// Unit tests for which copy play:stream settles on when the first one is in
// the wrong language (src/main/media-hub/languageFallback.ts), and for
// languageFit, the per-file verdict it works from.
// Run with: npx tsx tests/languageFallback.test.ts

import assert from 'node:assert'
import { languageFit } from '../src/shared/media-hub/language'
import {
  LANGUAGE_RETRY_LIMIT,
  languageHuntAllowed,
  languageSearchExhausted,
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
const [a, b, c, d, e, f, g, h] = [1, 2, 3, 4, 5, 6, 7, 8].map(copy)
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
check('capped at the pick plus the retry limit (no known copies)', () =>
  assert.equal(languageTryOrder(a, [b, c, d, e, f], {}).length, 1 + LANGUAGE_RETRY_LIMIT)
)
check('a copy known to lack the audio goes behind the unknown ones', () =>
  assert.deepEqual(languageTryOrder(a, [b, c], { [sourceKey(a)]: jaNoSubs }), [b, c, a])
)
check('only the closest known copy is kept as the last resort', () =>
  assert.deepEqual(
    languageTryOrder(a, [b, c], { [sourceKey(a)]: jaNoSubs, [sourceKey(b)]: jaEnSubs }),
    [c, b]
  )
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
check('a copy on this disk is keyed as the release it came from', () =>
  assert.equal(
    sourceKey({
      source: 'localcache',
      cacheToken: 'tok',
      cacheSourceRef: { source: 'torbox', infoHash: a.infoHash }
    } as StreamCandidate),
    sourceKey(a)
  )
)
check('a local session with no recorded release keeps its token', () =>
  assert.equal(sourceKey({ source: 'localcache', cacheToken: 'tok' } as StreamCandidate), 'c:tok')
)

console.log('\nno copy has the audio (Dragon Ball Super: Beerus, Japanese only)')
// A full round: the pick plus LANGUAGE_RETRY_LIMIT, all without the audio.
const round = [a, b, c, d].slice(0, 1 + LANGUAGE_RETRY_LIMIT)
const roundFindings = Object.fromEntries(
  round.map((stream, index) => [sourceKey(stream), index === 2 ? jaEnSubs : jaNoSubs])
)
check('a round short of the limit is not exhausted', () =>
  assert.equal(
    languageSearchExhausted(
      Object.fromEntries(
        round.slice(0, LANGUAGE_RETRY_LIMIT).map((stream) => [sourceKey(stream), jaNoSubs])
      )
    ),
    false
  )
)
check('a full round without the audio is exhausted', () =>
  assert.equal(languageSearchExhausted(roundFindings), true)
)
check('one copy with the audio means it is not', () =>
  assert.equal(languageSearchExhausted({ ...roundFindings, [sourceKey(h)]: english }), false)
)
check('after a full round a replay starts on the closest known copy, not four new ones', () =>
  assert.equal(languageTryOrder(e, [f, g, a, b, c, d], roundFindings)[0], c)
)
check('...with untried copies kept behind it for a copy that will not open', () =>
  assert.deepEqual(languageTryOrder(e, [f, g, a, b, c, d], roundFindings), [c, e, f, g])
)
check('...and no language hunt past the first copy that opens', () =>
  assert.equal(languageHuntAllowed(roundFindings), false)
)
check('a copy known to have the audio still wins after a full round', () =>
  assert.deepEqual(
    languageTryOrder(e, [f, g, h, c], { ...roundFindings, [sourceKey(h)]: english }),
    [h, e, f, g, c]
  )
)
check('the hunt runs while nothing is known', () => assert.equal(languageHuntAllowed({}), true))
check('a show known to lack the audio does not hunt on a new episode', () =>
  assert.equal(languageHuntAllowed({}, { showLacksAudio: true }), false)
)
check('...but keeps the whole order for copies that will not open', () =>
  assert.deepEqual(languageTryOrder(a, [b, c, d], {}), [a, b, c, d])
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
