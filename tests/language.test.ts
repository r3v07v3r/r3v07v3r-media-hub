// Unit tests for language preference (src/shared/media-hub/language.ts)
// and the audio-track selection that consumes it.
// Run with: npx tsx tests/language.test.ts   (or npm.cmd test)

import assert from 'node:assert'
import {
  languageMatches,
  languageName,
  normalizeLanguage,
  releaseAudioLanguages,
  releaseDeclaresLanguage,
  tracksLackLanguage
} from '../src/shared/media-hub/language'

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

console.log('normalizeLanguage')
check('639-2/B to 639-1', () => assert.equal(normalizeLanguage('fre'), 'fr'))
check('639-2/T to 639-1', () => assert.equal(normalizeLanguage('fra'), 'fr'))
check('already 639-1', () => assert.equal(normalizeLanguage('fr'), 'fr'))
check('strips region', () => assert.equal(normalizeLanguage('en-US'), 'en'))
check('strips underscore region', () => assert.equal(normalizeLanguage('pt_BR'), 'pt'))
check('case insensitive', () => assert.equal(normalizeLanguage('ENG'), 'en'))
check('unknown passes through', () => assert.equal(normalizeLanguage('xyz'), 'xyz'))

console.log('\nlanguageMatches')
check('eng matches en', () => assert.equal(languageMatches('eng', 'en'), true))
check('fre does not match en', () => assert.equal(languageMatches('fre', 'en'), false))
check('an unlabelled track never matches', () => assert.equal(languageMatches('', 'en'), false))
check('jpn matches ja', () => assert.equal(languageMatches('jpn', 'ja'), true))

// The selectTranscodeAudioTrack / needsAudioCompatibility sections that used to
// sit here are gone with vlc.ts. Both existed to serve a <video> element:
// needsAudioCompatibility decided whether ffmpeg had to be involved at all, and
// selectTranscodeAudioTrack picked which single track to bake into the stream —
// including deliberately declining TrueHD/DTS, because downmixing those through
// ffmpeg produced packets Chromium's decoder rejected mid-playback.
//
// mpv resolves the language preference against the container itself (--alang)
// and plays whatever it finds, so there is nothing left to pick or avoid. What
// remains below is the language matching those functions were built on, which
// torbox.ts's release ranking also depends on.

check('language names', () => {
  assert.equal(languageName('fre'), 'French')
  assert.equal(languageName('en'), 'English')
  assert.equal(languageName('xyz'), 'XYZ')
})

console.log(`\n${pass} passed`)

// --- what a release name says about its AUDIO -------------------------------
//
// releaseLacksPreferredLanguage only ever recognises a dub into some OTHER
// language. These three tell a dual-audio release from a raw, which is what
// keeps a series from alternating between dubbed and subbed episodes.

console.log('\nreleaseAudioLanguages')
check('dual audio declares multi', () =>
  assert.deepEqual(releaseAudioLanguages('[Group] Show - 05 [Dual-Audio][1080p]'), ['multi'])
)
check('multi-subs is a subtitle claim, not audio', () =>
  assert.equal(releaseAudioLanguages('[Group] Show - 05 [Multi-Subs][1080p]'), null)
)
check('eng dub declares english', () =>
  assert.deepEqual(releaseAudioLanguages('Show S01E05 1080p ENG DUB WEB-DL'), ['en'])
)
check('fused engdub declares english', () =>
  assert.deepEqual(releaseAudioLanguages('Show.S01E05.1080p.EngDub.WEB-DL'), ['en'])
)
check('english audio declares english', () =>
  assert.deepEqual(releaseAudioLanguages('Show S01E05 [English Audio] 1080p'), ['en'])
)
check('eng sub says nothing about audio', () =>
  assert.equal(releaseAudioLanguages('Show S01E05 1080p ENG SUB'), null)
)
check('a bare language tag is not a claim', () =>
  assert.equal(releaseAudioLanguages('[Group] Show - 05 [ENG][1080p]'), null)
)
check('a localisation marker is a dub into that language', () =>
  assert.deepEqual(releaseAudioLanguages('Film.2019.TRUEFRENCH.1080p.BluRay'), ['fr'])
)
check('vostfr is subtitles, not french audio', () =>
  assert.equal(releaseAudioLanguages('Film.2019.VOSTFR.1080p.BluRay'), null)
)
check('empty says nothing', () => assert.equal(releaseAudioLanguages(''), null))

console.log('\nreleaseDeclaresLanguage')
check('multi counts as carrying the wanted audio', () =>
  assert.equal(releaseDeclaresLanguage('Show 05 Dual Audio 1080p', 'en'), true)
)
check('an english dub carries english', () =>
  assert.equal(releaseDeclaresLanguage('Show 05 English Dub 1080p', 'eng'), true)
)
check('a french dub does not carry english', () =>
  assert.equal(releaseDeclaresLanguage('Film TRUEFRENCH 1080p', 'en'), false)
)
check('silence is not a claim', () =>
  assert.equal(releaseDeclaresLanguage('[Group] Show - 05 [1080p]', 'en'), false)
)

console.log('\ntracksLackLanguage')
const jaOnly = { audio: [{ language: 'jpn' }] }
const dual = { audio: [{ language: 'jpn' }, { language: 'eng' }] }
check('japanese-only lacks english', () => assert.equal(tracksLackLanguage(jaOnly, 'en'), true))
check('dual audio has english', () => assert.equal(tracksLackLanguage(dual, 'en'), false))
check('no preference is never lacking', () => assert.equal(tracksLackLanguage(jaOnly, ''), false))
check('no audio tracks is not a verdict', () =>
  assert.equal(tracksLackLanguage({ audio: [] }, 'en'), false)
)
check('unlabelled tracks do not match', () =>
  assert.equal(tracksLackLanguage({ audio: [{}] }, 'en'), true)
)

console.log(`\n${pass} passed (with audio claims)`)
