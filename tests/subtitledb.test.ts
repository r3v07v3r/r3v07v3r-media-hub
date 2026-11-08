// Unit tests for the SubtitleDB subtitle provider (src/main/media-hub/subtitledb.ts)
// and the three-provider merge (src/main/media-hub/subtitlesService.ts).
// Run with: npx tsx tests/subtitledb.test.ts   (or npm.cmd test)
//
// subtitledb.ts is imported directly because it is electron-free, as
// subdl.ts is; the merge is re-implemented here for the reason
// tests/subdl.test.ts gives in its header.

import assert from 'node:assert'
import type { SubtitleResult } from '../src/shared/media-hub/types'
import { subtitleProviderName } from '../src/shared/media-hub/subtitleProviders'
import {
  buildTsdbInfohashPath,
  buildTsdbLookupPath,
  normalizeTsdbResult,
  resolveTsdbDownloadUrl,
  stripLeadingCredits
} from '../src/main/media-hub/subtitledb'

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

function params(path: string): URLSearchParams {
  return new URL(path, 'https://api.thesubtitledb.org').searchParams
}

// --- lookup paths ----------------------------------------------------------

check('looks a film up by its IMDb id, SRT only, in the wanted language', () => {
  const path = buildTsdbLookupPath(
    { id: 'tt1843866', type: 'movie', title: 'Captain America: The Winter Soldier' },
    { language: 'en' }
  )
  assert.ok(path.startsWith('/v1/by-imdb/tt1843866?'), path)
  assert.equal(params(path).get('lang'), 'en')
  assert.equal(params(path).get('format'), 'srt')
  assert.equal(params(path).get('sort'), 'cues', 'fullest file first, not newest')
})

check('appends season and episode for an episode of a show', () => {
  const path = buildTsdbLookupPath(
    { id: 'tt0903747', type: 'series', title: 'Breaking Bad' },
    { language: 'fr', season: 2, episode: 5 }
  )
  assert.ok(path.startsWith('/v1/by-imdb/tt0903747/season/2/episode/5?'), path)
  assert.equal(params(path).get('lang'), 'fr')
})

check('a film with a season number in the playback is still looked up as a film', () => {
  const path = buildTsdbLookupPath({ id: 'tt1375666', type: 'movie' }, { season: 1, episode: 1 })
  assert.ok(path.startsWith('/v1/by-imdb/tt1375666?'), path)
})

check('falls back to the title, with the episode tag SubtitleDB reads', () => {
  const path = buildTsdbLookupPath(
    { id: 'kitsu:1', type: 'anime', title: 'Frieren' },
    { language: 'en', season: 1, episode: 3 }
  )
  assert.ok(path.startsWith('/v1/by-title?'), path)
  assert.equal(params(path).get('q'), 'Frieren S01E03')
  assert.equal(params(path).get('type'), 'tv')
})

check('never sends an anime catalog id as an IMDb id', () => {
  const path = buildTsdbLookupPath({ id: 'tt9999999', type: 'anime', title: 'Frieren' })
  assert.ok(path.startsWith('/v1/by-title?'), path)
  assert.equal(params(path).get('q'), 'Frieren')
})

check('asks nothing for an item with neither id nor title', () => {
  assert.equal(buildTsdbLookupPath({ id: '', type: 'movie', title: ' ' }), '')
  assert.equal(buildTsdbLookupPath(undefined), '')
})

check('looks the torrent playing up by its info hash, and only a real one', () => {
  const hash = 'A'.repeat(40)
  const path = buildTsdbInfohashPath(hash, 'en')
  assert.ok(path.startsWith(`/v1/by-infohash/${'a'.repeat(40)}?`), path)
  assert.equal(buildTsdbInfohashPath('not-a-hash', 'en'), '')
  assert.equal(buildTsdbInfohashPath(undefined, 'en'), '')
})

// --- normalization ---------------------------------------------------------

check('normalizes a SubtitleDB row into a provider-tagged SubtitleResult', () => {
  const result = normalizeTsdbResult({
    id: 8587623,
    language: 'en',
    format: 'srt',
    release_name: 'Captain.America.The.Winter.Soldier.2014.WEB-DL.DSNP\r\nAnother.Name',
    hearing_impaired: true,
    uploader: 'someone',
    download_url: 'https://api.thesubtitledb.org/get/8587623'
  })
  assert.equal(result.provider, 'subtitledb')
  assert.equal(result.id, 'subtitledb:8587623')
  assert.equal(result.downloadPath, '/get/8587623')
  assert.equal(result.fileId, 0, 'fileId is an OpenSubtitles-only concept')
  assert.equal(result.releaseName, 'Captain.America.The.Winter.Soldier.2014.WEB-DL.DSNP')
  assert.equal(result.hearingImpaired, true)
  assert.equal(result.hashMatch, false)
})

check('an info-hash row is marked as the exact match it is', () => {
  assert.equal(normalizeTsdbResult({ id: 1 }, true).hashMatch, true)
})

check('a row without a usable id has no download path', () => {
  assert.equal(normalizeTsdbResult({}).downloadPath, '')
  assert.equal(normalizeTsdbResult({ id: 'abc' }).downloadPath, '')
  assert.equal(normalizeTsdbResult({ id: -4 }).downloadPath, '')
  assert.equal(normalizeTsdbResult({}).uploader, 'Anonymous')
})

// --- SSRF boundary ---------------------------------------------------------

check('resolves a well-formed download path against the API origin', () => {
  assert.equal(
    resolveTsdbDownloadUrl('/get/8587623'),
    'https://api.thesubtitledb.org/get/8587623?remove_watermark=true'
  )
})

check('rejects anything that is not /get/ plus digits', () => {
  for (const hostile of [
    'https://evil.host/get/1',
    '//evil.host/get/1',
    '/get/1/../../x',
    '/get/1?format=vtt',
    '/get/abc',
    'get/1',
    '/subtitle/1.zip',
    '',
    null,
    undefined,
    42
  ]) {
    assert.equal(resolveTsdbDownloadUrl(hostile), '', `should reject ${String(hostile)}`)
  }
})

// --- credit stamps ---------------------------------------------------------

const cue = (n: number, from: string, to: string, text: string): string =>
  `${n}\n00:${from} --> 00:${to}\n${text}`

check('drops a typewriter credit stamp the service left at the top', () => {
  // The live shape (Winter Soldier, 2026-11-08): dozens of 200 ms cues that
  // spell a credit out one character at a time before the first line.
  const stamp = [
    cue(1, '00:02,000', '00:02,200', '<font color=orange>©'),
    cue(2, '00:02,200', '00:02,400', '<font color=orange>© P'),
    cue(3, '00:02,400', '00:02,600', '<font color=orange>© P@r'),
    cue(4, '00:02,600', '00:02,800', '<font color=orange>© P@rM!N'),
    // …then the typed credit held for a few cues, and a line added to it.
    cue(5, '00:05,800', '00:07,000', '<font color=orange>© P@rM!N ™'),
    cue(6, '00:07,200', '00:08,000', '<font color=orange>© P@rM!N ™'),
    cue(7, '00:10,000', '00:11,000', '<font color=orange>© P@rM!N ™ Mobile - +91981')
  ]
  const film = [
    cue(8, '00:46,322', '00:48,014', 'ROGERS: On your left.'),
    cue(9, '00:57,907', '00:59,172', 'On your left.')
  ]
  const stripped = stripLeadingCredits([...stamp, ...film].join('\n\n'))
  assert.equal(stripped, film.join('\n\n'))
})

check('leaves a file that opens with dialogue alone, a repeated line included', () => {
  const srt = [
    cue(1, '00:01,000', '00:02,000', 'Where is he?'),
    cue(2, '00:03,000', '00:04,000', 'Where is he?'),
    cue(3, '00:05,000', '00:06,000', 'Gone.')
  ].join('\n\n')
  assert.equal(stripLeadingCredits(srt), srt)
})

check('a stamp that starts after the window is not touched', () => {
  const srt = [
    cue(1, '00:30,000', '00:31,000', '©'),
    cue(2, '00:40,000', '00:41,000', 'Hello.')
  ].join('\n\n')
  assert.equal(stripLeadingCredits(srt), srt)
})

check('a file that is not SRT-shaped comes back as it was', () => {
  assert.equal(stripLeadingCredits('WEBVTT\n\nhello'), 'WEBVTT\n\nhello')
  assert.equal(stripLeadingCredits(''), '')
})

// --- names -----------------------------------------------------------------

check('every provider has its own name', () => {
  assert.equal(subtitleProviderName('subtitledb'), 'SubtitleDB')
  assert.equal(subtitleProviderName('subdl'), 'SubDL')
  assert.equal(subtitleProviderName('opensubtitles'), 'OpenSubtitles')
})

// --- provider merge --------------------------------------------------------
//
// Mirrors mergeSubtitleResults in subtitlesService.ts. Kept in sync by hand.
function mergeSubtitleResults(lists: SubtitleResult[][], limit = 20): SubtitleResult[] {
  const present = lists.filter((list) => list.length)
  const share = present.length ? Math.ceil(limit / present.length) : limit
  const merged = present.flatMap((list) => list.slice(0, share)).slice(0, limit)
  const seen = new Set(merged.map((entry) => entry.id))
  const backfill = present.flat().filter((entry) => !seen.has(entry.id))
  const rows = [...merged, ...backfill].slice(0, limit)
  const exact = rows.filter((entry) => entry.hashMatch)
  return exact.length ? [...exact, ...rows.filter((entry) => !entry.hashMatch)] : rows
}

function row(id: string, provider: SubtitleResult['provider'], hashMatch = false): SubtitleResult {
  return {
    id,
    provider,
    fileId: provider === 'opensubtitles' ? 1 : 0,
    downloadPath:
      provider === 'subdl' ? `/subtitle/${id}.zip` : provider === 'subtitledb' ? '/get/1' : '',
    fileName: id,
    language: 'en',
    releaseName: id,
    downloadCount: 0,
    uploader: 'someone',
    hearingImpaired: false,
    hashMatch
  }
}

check('SubtitleDB rows come first, then SubDL, then OpenSubtitles', () => {
  const merged = mergeSubtitleResults([
    [row('t1', 'subtitledb')],
    [row('s1', 'subdl')],
    [row('o1', 'opensubtitles')]
  ])
  assert.deepEqual(
    merged.map((entry) => entry.provider),
    ['subtitledb', 'subdl', 'opensubtitles']
  )
})

check('each provider with rows keeps a share of the menu', () => {
  const many = Array.from({ length: 40 }, (_, i) => row(`t${i}`, 'subtitledb'))
  const merged = mergeSubtitleResults([many, [row('s1', 'subdl')], [row('o1', 'opensubtitles')]])
  assert.equal(merged.length, 20)
  assert.ok(merged.some((entry) => entry.provider === 'subdl'))
  assert.ok(merged.some((entry) => entry.provider === 'opensubtitles'))
})

check('a provider with nothing gives its share to the others', () => {
  const many = Array.from({ length: 40 }, (_, i) => row(`t${i}`, 'subtitledb'))
  const merged = mergeSubtitleResults([many, [], []])
  assert.equal(merged.length, 20, 'empty providers must not shrink the list')
})

check('an exact match from any provider goes to the top', () => {
  const merged = mergeSubtitleResults([
    [row('t1', 'subtitledb'), row('t2', 'subtitledb', true)],
    [row('s1', 'subdl')],
    [row('o1', 'opensubtitles', true)]
  ])
  assert.deepEqual(
    merged.slice(0, 2).map((entry) => entry.id),
    ['t2', 'o1']
  )
  assert.equal(merged.length, 4)
})

console.log(`\n${pass} checks passed${process.exitCode ? ', some FAILED' : ''}`)
