// The Trakt export file reader (src/main/media-hub/traktExport.ts): which
// files in the zip are read, which are left alone, and that a zip it cannot
// read whole is refused rather than half imported.
//
// Run with: npx tsx tests/traktExport.test.ts

import assert from 'node:assert/strict'
import zlib from 'node:zlib'

import { readTraktExport, traktExportFileKind } from '../src/main/media-hub/traktExport'

/** A minimal standards-correct zip — zipArchive.test.ts's construction. */
function makeZip(files: { name: string; body: string }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const raw = Buffer.from(file.body, 'utf8')
    const data = zlib.deflateRawSync(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(8, 10)
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

const film = (imdb: string, title: string) => ({ title, year: 2010, ids: { imdb } })
const json = (name: string, rows: unknown) => ({ name, body: JSON.stringify(rows) })

// --- Which files are read ---------------------------------------------------
assert.equal(traktExportFileKind('watched-history.json'), 'history')
assert.equal(traktExportFileKind('trakt-backup-2026-11-14/watched-history-12.json'), 'history')
assert.equal(traktExportFileKind('Ratings-Movies.json'), 'ratings')
assert.equal(traktExportFileKind('ratings-shows-2.json'), 'ratings')
// The same viewings added up, and ratings this app keeps no score for.
for (const name of [
  'watched-movies.json',
  'watched-shows-2.json',
  'ratings-episodes.json',
  'ratings-seasons.json',
  'lists-watchlist.json',
  'watched-history.json.bak',
  'watched-history-x.json'
]) {
  assert.equal(traktExportFileKind(name), null, name)
}

// --- Pages are joined, dates kept, the other files ignored --------------------
{
  const zip = makeZip([
    json('trakt-backup/watched-history.json', [
      {
        watched_at: '2019-03-01T20:00:00.000Z',
        type: 'movie',
        movie: film('tt1375666', 'Inception')
      }
    ]),
    json('trakt-backup/watched-history-2.json', [
      {
        watched_at: '2020-05-02T21:00:00.000Z',
        type: 'episode',
        episode: { season: 2, number: 3 },
        show: film('tt0903747', 'Breaking Bad')
      },
      // No IMDb id: counted, not guessed at.
      {
        watched_at: '2020-05-03T21:00:00.000Z',
        type: 'movie',
        movie: { title: 'Obscure', ids: {} }
      }
    ]),
    json('trakt-backup/ratings-movies.json', [
      { rating: 9, rated_at: '2019-03-02T00:00:00.000Z', movie: film('tt1375666', 'Inception') }
    ]),
    json('trakt-backup/ratings-shows.json', [
      { rating: 10, rated_at: '2020-06-01T00:00:00.000Z', show: film('tt0903747', 'Breaking Bad') }
    ]),
    // Would rate the whole show 2 if it were read as a show rating.
    json('trakt-backup/ratings-episodes.json', [
      { rating: 2, episode: { season: 1, number: 1 }, show: film('tt0903747', 'Breaking Bad') }
    ]),
    // Would file Inception a second time.
    json('trakt-backup/watched-movies.json', [
      {
        plays: 1,
        last_watched_at: '2019-03-01T20:00:00.000Z',
        movie: film('tt1375666', 'Inception')
      }
    ])
  ])
  const read = readTraktExport(zip)
  assert.deepEqual(
    read.plays.rows.map((row) => [row.id, row.type, row.season, row.episode, row.watchedAt]),
    [
      ['tt1375666', 'movie', null, null, '2019-03-01T20:00:00.000Z'],
      ['tt0903747', 'series', 2, 3, '2020-05-02T21:00:00.000Z']
    ]
  )
  assert.equal(read.plays.skipped, 1)
  assert.deepEqual(
    read.ratings.rows.map((row) => [row.id, row.type, row.score]),
    [
      ['tt1375666', 'movie', 9],
      ['tt0903747', 'series', 10]
    ]
  )
}

// --- Ratings alone are an export too ----------------------------------------
{
  const read = readTraktExport(makeZip([{ name: 'ratings-movies.json', body: '\ufeff' + '[]' }]))
  assert.equal(read.plays.rows.length, 0)
  assert.equal(read.ratings.rows.length, 0)
}

// --- Refused, not reported as an empty import ------------------------------
assert.throws(
  () => readTraktExport(Buffer.from('not a zip at all')),
  /does not look like a Trakt export/
)
assert.throws(
  () => readTraktExport(makeZip([{ name: 'diary.csv', body: 'Name,Year' }])),
  /does not look like a Trakt export/
)
// One unreadable page stops the whole import: the good page is not written
// under a line that says the history is in.
assert.throws(
  () =>
    readTraktExport(
      makeZip([
        json('watched-history.json', [
          { watched_at: '2019-03-01T20:00:00.000Z', movie: film('tt1375666', 'Inception') }
        ]),
        { name: 'watched-history-2.json', body: '[{"watched_at": ' }
      ])
    ),
  /watched-history-2\.json in that export could not be read/
)
assert.throws(
  () => readTraktExport(makeZip([json('ratings-movies.json', { not: 'a list' })])),
  /could not be read/
)

console.log('traktExport: ok')
