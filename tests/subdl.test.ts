// Unit tests for the SubDL subtitle provider (src/main/media-hub/subdl.ts)
// and the two-provider result merge (src/main/media-hub/subtitlesService.ts).
// Run with: npx tsx tests/subdl.test.ts   (or npm.cmd test)
//
// subdl.ts is imported directly because it is deliberately electron-free;
// mergeSubtitleResults is re-implemented here rather than imported, since
// subtitlesService.ts pulls in `electron` at module load and would need a
// full app harness to import under plain tsx. The copy is annotated below.

import assert from 'node:assert'
import zlib from 'node:zlib'
import type { SubtitleResult } from '../src/shared/media-hub/types'
import {
  buildSubdlSearchParams,
  normalizeSubdlResult,
  readSrtFromZip,
  resolveSubdlDownloadUrl
} from '../src/main/media-hub/subdl'

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

// --- search params ---------------------------------------------------------

check('searches by full tt-form IMDb id when the item has one', () => {
  const params = buildSubdlSearchParams({ id: 'tt1375666', type: 'movie', title: 'Inception' })
  assert.equal(params.imdb_id, 'tt1375666')
  assert.equal(params.type, 'movie')
  assert.equal(params.film_name, undefined)
})

check('falls back to a title query when there is no IMDb id', () => {
  const params = buildSubdlSearchParams({ id: '12345', type: 'series', title: 'Severance' })
  assert.equal(params.imdb_id, undefined)
  assert.equal(params.film_name, 'Severance')
  assert.equal(params.type, 'tv')
})

check('never sends an anime catalog id as an IMDb id', () => {
  // Matches buildSearchParams' own anime carve-out: anime ids come from
  // Kitsu/MAL and are not IMDb ids even when they pattern-match.
  const params = buildSubdlSearchParams({ id: 'tt9999999', type: 'anime', title: 'Frieren' })
  assert.equal(params.imdb_id, undefined)
  assert.equal(params.film_name, 'Frieren')
})

check('attaches season/episode for series but not for movies', () => {
  const series = buildSubdlSearchParams(
    { id: 'tt0903747', type: 'series', title: 'Breaking Bad' },
    { season: 2, episode: 5, language: 'en' }
  )
  assert.equal(series.season_number, 2)
  assert.equal(series.episode_number, 5)

  const movie = buildSubdlSearchParams(
    { id: 'tt1375666', type: 'movie', title: 'Inception' },
    { season: 2, episode: 5, language: 'en' }
  )
  assert.equal(movie.season_number, undefined)
  assert.equal(movie.episode_number, undefined)
})

check('uppercases the language code SubDL expects', () => {
  const params = buildSubdlSearchParams({ id: 'tt1375666', type: 'movie' }, { language: 'fr' })
  assert.equal(params.languages, 'FR')
})

// --- normalization ---------------------------------------------------------

check('normalizes a SubDL row into a provider-tagged SubtitleResult', () => {
  const result = normalizeSubdlResult({
    release_name: 'Inception.2010.1080p.BluRay',
    name: 'Inception.srt',
    url: '/subtitle/3197651-3213944.zip',
    language: 'EN',
    author: 'someuploader',
    hi: true
  })
  assert.equal(result.provider, 'subdl')
  assert.equal(result.downloadPath, '/subtitle/3197651-3213944.zip')
  assert.equal(result.fileId, 0, 'fileId is an OpenSubtitles-only concept')
  assert.equal(result.language, 'EN')
  assert.equal(result.uploader, 'someuploader')
  assert.equal(result.hearingImpaired, true)
})

check('survives a row missing every optional field', () => {
  const result = normalizeSubdlResult({})
  assert.equal(result.provider, 'subdl')
  assert.equal(result.uploader, 'Anonymous')
  assert.equal(result.hearingImpaired, false)
  assert.equal(result.downloadPath, '')
})

// --- SSRF boundary ---------------------------------------------------------

check('accepts a well-formed archive path', () => {
  assert.equal(
    resolveSubdlDownloadUrl('/subtitle/3197651-3213944.zip'),
    'https://dl.subdl.com/subtitle/3197651-3213944.zip'
  )
})

check('rejects paths that would leave dl.subdl.com', () => {
  // Each of these is what a compromised renderer would send to make the
  // main process fetch something of its choosing.
  for (const hostile of [
    'https://evil.host/x.zip',
    '//evil.host/x.zip',
    '/subtitle/../../x.zip',
    '/subtitle/x.zip?a=b',
    '/subtitle/x.zip#/../y',
    'subtitle/x.zip',
    '/subtitle/x.exe',
    '',
    null,
    undefined,
    42
  ]) {
    assert.equal(resolveSubdlDownloadUrl(hostile), '', `should reject ${String(hostile)}`)
  }
})

// --- zip reading -----------------------------------------------------------

/** Builds a minimal but standards-correct zip in memory. */
function makeZip(files: { name: string; body: Buffer | string; store?: boolean }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const raw = Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body, 'utf8')
    const data = file.store ? raw : zlib.deflateRawSync(raw)
    const method = file.store ? 0 : 8

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + data.length
  }

  const localBytes = Buffer.concat(locals)
  const centralBytes = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBytes.length, 12)
  eocd.writeUInt32LE(localBytes.length, 16)

  return Buffer.concat([localBytes, centralBytes, eocd])
}

const SRT = '1\n00:00:01,000 --> 00:00:03,000\nHello there.\n'

check('reads a deflated .srt out of an archive', () => {
  assert.equal(readSrtFromZip(makeZip([{ name: 'Inception.srt', body: SRT }])), SRT)
})

check('reads a stored (uncompressed) .srt too', () => {
  assert.equal(readSrtFromZip(makeZip([{ name: 'x.srt', body: SRT, store: true }])), SRT)
})

check('skips __MACOSX resource forks that shadow the real entry', () => {
  const archive = makeZip([
    { name: '__MACOSX/._Inception.srt', body: 'junk' },
    { name: 'Inception.srt', body: SRT }
  ])
  assert.equal(readSrtFromZip(archive), SRT)
})

check('strips a UTF-8 BOM so the first cue still parses', () => {
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SRT, 'utf8')])
  assert.equal(readSrtFromZip(makeZip([{ name: 'x.srt', body: withBom }])), SRT)
})

check('falls back to windows-1252 for non-UTF-8 subtitle bytes', () => {
  // 0xE9 alone is invalid UTF-8 but is "é" in windows-1252 — the common
  // case for community-uploaded western European SRTs.
  const latin1 = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nCaf\xe9\n', 'latin1')
  assert.ok(readSrtFromZip(makeZip([{ name: 'x.srt', body: latin1 }])).includes('Café'))
})

check('refuses an archive with no .srt rather than rendering garbage', () => {
  assert.throws(
    () => readSrtFromZip(makeZip([{ name: 'Inception.ass', body: '[Script Info]' }])),
    /no \.srt file/
  )
})

check('refuses a response that is not a zip at all', () => {
  assert.throws(() => readSrtFromZip(Buffer.from('<html>rate limited</html>')), /no \.srt file/)
})

// --- provider merge --------------------------------------------------------
//
// Mirrors mergeSubtitleResults in subtitlesService.ts. Kept in sync by hand;
// see this file's header for why it is not imported.
function mergeSubtitleResults(
  subdl: SubtitleResult[],
  openSubtitles: SubtitleResult[],
  limit = 20
): SubtitleResult[] {
  const half = Math.ceil(limit / 2)
  const merged = [...subdl.slice(0, half), ...openSubtitles.slice(0, limit - half)]
  const seen = new Set(merged.map((entry) => entry.id))
  const backfill = [...subdl, ...openSubtitles].filter((entry) => !seen.has(entry.id))
  return [...merged, ...backfill].slice(0, limit)
}

function row(id: string, provider: SubtitleResult['provider']): SubtitleResult {
  return {
    id,
    provider,
    fileId: provider === 'opensubtitles' ? 1 : 0,
    downloadPath: provider === 'subdl' ? `/subtitle/${id}.zip` : '',
    fileName: id,
    language: 'en',
    releaseName: id,
    downloadCount: 0,
    uploader: 'someone',
    hearingImpaired: false
  }
}

check('puts SubDL first so the free provider is what auto-apply picks', () => {
  const merged = mergeSubtitleResults([row('s1', 'subdl')], [row('o1', 'opensubtitles')])
  assert.equal(merged[0].provider, 'subdl')
})

check('never lets one provider crowd the other out of the menu', () => {
  const many = Array.from({ length: 30 }, (_, i) => row(`s${i}`, 'subdl'))
  const merged = mergeSubtitleResults(many, [row('o1', 'opensubtitles')])
  assert.equal(merged.length, 20)
  assert.ok(
    merged.some((entry) => entry.provider === 'opensubtitles'),
    'OpenSubtitles results must still be reachable'
  )
})

check('backfills from whichever provider has more when the other is short', () => {
  const many = Array.from({ length: 30 }, (_, i) => row(`s${i}`, 'subdl'))
  const merged = mergeSubtitleResults(many, [])
  assert.equal(merged.length, 20, 'an empty second provider must not shrink the list')
  assert.equal(new Set(merged.map((entry) => entry.id)).size, 20, 'no duplicates')
})

check('returns an empty list when neither provider found anything', () => {
  assert.deepEqual(mergeSubtitleResults([], []), [])
})

console.log(`\n${pass} passed`)
