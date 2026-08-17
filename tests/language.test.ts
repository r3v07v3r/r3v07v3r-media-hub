// Unit tests for language preference (src/shared/media-hub/language.ts)
// and the audio-track selection that consumes it.
// Run with: npx tsx tests/language.test.ts   (or npm.cmd test)

import assert from 'node:assert'
import type { MediaTrack, MediaTracks } from '../src/shared/media-hub/types'
import {
  languageMatches,
  languageName,
  normalizeLanguage,
  releaseLacksPreferredLanguage,
  releaseLocalisedInto
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

function audio(ordinal: number, language: string, codec = 'aac', isDefault = false): MediaTrack {
  return {
    ordinal,
    index: ordinal + 1,
    codec,
    language,
    title: '',
    label: `${language} ${codec}`,
    default: isDefault
  }
}
const tracks = (...list: MediaTrack[]): MediaTracks => ({
  video: [],
  audio: list,
  subtitle: [],
  probed: true
})

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
