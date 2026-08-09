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
import { needsAudioCompatibility, selectTranscodeAudioTrack } from '../src/main/media-hub/vlc'

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

function audio(
  ordinal: number,
  language: string,
  codec = 'aac',
  isDefault = false
): MediaTrack {
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
check('an unlabelled track never matches', () =>
  assert.equal(languageMatches('', 'en'), false)
)
check('jpn matches ja', () => assert.equal(languageMatches('jpn', 'ja'), true))

console.log('\nselectTranscodeAudioTrack — the reported bug')
check('picks English over a French track marked default', () => {
  const t = tracks(audio(0, 'fre', 'aac', true), audio(1, 'eng'))
  assert.equal(selectTranscodeAudioTrack(t, 'en')?.ordinal, 1)
})
check('picks English even when French is first AND default', () => {
  const t = tracks(audio(0, 'fra', 'ac3', true), audio(1, 'ger'), audio(2, 'eng'))
  assert.equal(selectTranscodeAudioTrack(t, 'en')?.ordinal, 2)
})
check('honours a non-English preference too', () => {
  const t = tracks(audio(0, 'eng', 'aac', true), audio(1, 'jpn'))
  assert.equal(selectTranscodeAudioTrack(t, 'ja')?.ordinal, 1)
})
check('falls back to the default when the language is absent', () => {
  const t = tracks(audio(0, 'fre'), audio(1, 'ger', 'aac', true))
  assert.equal(selectTranscodeAudioTrack(t, 'en')?.ordinal, 1)
})
check('falls back to the first when nothing is marked default', () => {
  const t = tracks(audio(0, 'fre'), audio(1, 'ger'))
  assert.equal(selectTranscodeAudioTrack(t, 'en')?.ordinal, 0)
})
check('no audio at all is undefined, not a crash', () =>
  assert.equal(selectTranscodeAudioTrack(tracks(), 'en'), undefined)
)

console.log('\nselectTranscodeAudioTrack — risky codecs still avoided')
check('prefers a safe English track over a TrueHD English one', () => {
  const t = tracks(audio(0, 'eng', 'truehd', true), audio(1, 'eng', 'ac3'))
  assert.equal(selectTranscodeAudioTrack(t, 'en')?.ordinal, 1)
})
check('does NOT escape to another language to dodge a risky codec', () => {
  // English is only available as TrueHD. A French AC3 track is safer to
  // transcode but is the wrong language — language wins.
  const t = tracks(audio(0, 'eng', 'truehd', true), audio(1, 'fre', 'ac3'))
  assert.equal(selectTranscodeAudioTrack(t, 'en')?.ordinal, 0)
})

console.log('\nneedsAudioCompatibility')
check('true when the wanted track is not the container default', () => {
  // Both browser-playable codecs, so the ONLY reason is track selection.
  const t = tracks(audio(0, 'fre', 'aac', true), audio(1, 'eng', 'aac'))
  assert.equal(needsAudioCompatibility(t, 'en'), true)
})
check('false when the wanted track already is the default', () => {
  const t = tracks(audio(0, 'eng', 'aac', true), audio(1, 'fre', 'aac'))
  assert.equal(needsAudioCompatibility(t, 'en'), false)
})
check('false for a single-track browser-playable file', () =>
  assert.equal(needsAudioCompatibility(tracks(audio(0, 'eng', 'aac', true)), 'en'), false)
)
check('still true for an undecodable codec regardless of language', () =>
  assert.equal(needsAudioCompatibility(tracks(audio(0, 'eng', 'truehd', true)), 'en'), true)
)

console.log('\nreleaseLacksPreferredLanguage')
check('flags a TRUEFRENCH release', () =>
  assert.equal(releaseLacksPreferredLanguage('Movie.2024.TRUEFRENCH.1080p.WEB.x264', 'en'), true)
)
check('flags FRENCH', () =>
  assert.equal(releaseLacksPreferredLanguage('Movie.2024.FRENCH.1080p', 'en'), true)
)
check('flags VOSTFR', () =>
  assert.equal(releaseLacksPreferredLanguage('Movie.2024.VOSTFR.1080p', 'en'), true)
)
check('flags GERMAN', () =>
  assert.equal(releaseLacksPreferredLanguage('Movie.2024.GERMAN.DL.1080p', 'en'), true)
)
check('MULTI cancels it', () =>
  assert.equal(releaseLacksPreferredLanguage('Movie.2024.MULTI.FRENCH.1080p', 'en'), false)
)
check('DUAL cancels it', () =>
  assert.equal(releaseLacksPreferredLanguage('Movie.2024.DUAL.ITA.ENG.1080p', 'en'), false)
)
check('an explicit ENG token cancels it', () =>
  assert.equal(releaseLacksPreferredLanguage('Movie.2024.FRENCH.ENG.1080p', 'en'), false)
)
check('a plain English release is fine', () =>
  assert.equal(releaseLacksPreferredLanguage('Movie.2024.1080p.BluRay.x264-GROUP', 'en'), false)
)
check('does not flag a Japanese-audio anime release', () => {
  // The whole Anime section depends on this NOT being treated as a dub to
  // avoid — Japanese audio is the original work, not a localisation.
  assert.equal(
    releaseLacksPreferredLanguage('[SubsPlease] Show - 05 (1080p) [ABC123].mkv', 'en'),
    false
  )
})
check('does not flag JAPANESE in a release name', () =>
  assert.equal(releaseLacksPreferredLanguage('Film.2024.JAPANESE.1080p', 'en'), false)
)
check('reversed: wanting French, a FRENCH release is fine', () =>
  assert.equal(releaseLacksPreferredLanguage('Movie.2024.FRENCH.1080p', 'fr'), false)
)
check('reversed: wanting French, a GERMAN release is not', () =>
  assert.equal(releaseLacksPreferredLanguage('Movie.2024.GERMAN.1080p', 'fr'), true)
)
check('empty text is not flagged', () =>
  assert.equal(releaseLacksPreferredLanguage('', 'en'), false)
)
check('does not match a substring inside a word', () =>
  // "frenchie" is one token and must not read as the FRENCH marker
  assert.equal(releaseLacksPreferredLanguage('The.Frenchie.2024.1080p', 'en'), false)
)

console.log('\nreleaseLocalisedInto / languageName')
check('names the language a release is dubbed into', () =>
  assert.equal(releaseLocalisedInto('Movie.2024.TRUEFRENCH.1080p', 'en'), 'fr')
)
check('null for a clean release', () =>
  assert.equal(releaseLocalisedInto('Movie.2024.1080p', 'en'), null)
)
check('language names', () => {
  assert.equal(languageName('fre'), 'French')
  assert.equal(languageName('en'), 'English')
  assert.equal(languageName('xyz'), 'XYZ')
})

console.log(`\n${pass} passed`)
