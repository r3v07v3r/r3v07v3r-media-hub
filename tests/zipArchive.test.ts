// Unit tests for the shared zip-reading primitives
// (src/main/media-hub/zipArchive.ts) — extracted out of subdl.ts so a
// second consumer (the Letterboxd import) does not have to carry a second
// copy of a hand-rolled binary format parser. subdl.test.ts already
// exercises the round trip indirectly through readSrtFromZip; this tests
// the module's own public surface directly, including the multi-entry and
// nested-path cases the Letterboxd import specifically depends on.

import assert from 'node:assert/strict'
import zlib from 'node:zlib'

import { inflateZipEntry, readZipCentralDirectory } from '../src/main/media-hub/zipArchive'

/** Builds a minimal but standards-correct zip in memory — same construction
 *  subdl.test.ts uses for its own archive fixtures. */
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

// ---------------------------------------------------------------------
// The central directory lists every entry, in order — the shape a
// Letterboxd export actually has: several named CSVs in one archive.
// ---------------------------------------------------------------------
{
  const archive = makeZip([
    { name: 'diary.csv', body: 'diary contents' },
    { name: 'ratings.csv', body: 'ratings contents', store: true },
    { name: 'profile.csv', body: 'profile contents' }
  ])
  const entries = readZipCentralDirectory(archive)
  assert.deepEqual(
    entries.map((e) => e.fileName),
    ['diary.csv', 'ratings.csv', 'profile.csv']
  )
  const diary = entries.find((e) => e.fileName === 'diary.csv')!
  assert.equal(inflateZipEntry(archive, diary, 1024).toString('utf8'), 'diary contents')
  const ratings = entries.find((e) => e.fileName === 'ratings.csv')!
  assert.equal(inflateZipEntry(archive, ratings, 1024).toString('utf8'), 'ratings contents')
}

// A file nested under a folder — Letterboxd's export sometimes wraps its
// CSVs in a dated directory rather than putting them at the archive root.
{
  const archive = makeZip([
    { name: 'letterboxd-export-2026-01-01/diary.csv', body: 'nested diary' }
  ])
  const entries = readZipCentralDirectory(archive)
  assert.equal(entries[0].fileName, 'letterboxd-export-2026-01-01/diary.csv')
  assert.equal(inflateZipEntry(archive, entries[0], 1024).toString('utf8'), 'nested diary')
}

// Not a zip at all — an error page served with a 200, for instance. Empty,
// not a throw: the caller decides what "no entries" means.
assert.deepEqual(readZipCentralDirectory(Buffer.from('not a zip file')), [])

// A zip-bomb guard: an entry claiming to inflate past the caller's own
// limit is refused rather than silently allocated.
{
  const archive = makeZip([{ name: 'big.csv', body: 'x'.repeat(1000) }])
  const entry = readZipCentralDirectory(archive)[0]
  assert.throws(() => inflateZipEntry(archive, entry, 10))
}

console.log('zip archive tests passed')
