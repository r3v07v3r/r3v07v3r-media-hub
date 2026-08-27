// Reads a plain zip archive's central directory and inflates one entry from
// it — the two operations every consumer of a zip in this app actually
// needs (a subtitle archive, a Letterboxd export), extracted out of what
// was originally subdl.ts's own SRT-only reader so the second consumer does
// not have to carry a second copy of real binary-parsing complexity. This is
// the one place in the codebase that departs from its usual "small local
// duplication over a shared cross-module utility" convention — the
// duplication that convention is meant to avoid is a few lines re-typed
// per caller, not a hand-rolled zip parser re-typed per caller.
//
// Hand-rolled rather than a dependency: every archive this app ever opens is
// small (a subtitle download, an export file), and node:zlib already does
// the one hard part (inflating DEFLATE) without adding anything to the
// dependency tree.

import zlib from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_FILE_SIGNATURE = 0x02014b50
const LOCAL_FILE_SIGNATURE = 0x04034b50

export interface ZipEntry {
  fileName: string
  compressionMethod: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

/** Locates the End Of Central Directory record, scanning back from the end
 *  over the maximum possible trailing comment (64KB). Returns -1 if absent,
 *  which means "not a zip" — e.g. an error page served with a 200. */
function findEndOfCentralDirectory(buffer: Buffer): number {
  const earliest = Math.max(0, buffer.length - 0xffff - 22)
  for (let offset = buffer.length - 22; offset >= earliest; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  return -1
}

/** Every entry a zip's central directory lists, in the order it lists them.
 *  Empty for anything that is not a well-formed zip. */
export function readZipCentralDirectory(buffer: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer)
  if (eocd < 0) return []

  const entryCount = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []

  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > buffer.length) break
    if (buffer.readUInt32LE(offset) !== CENTRAL_FILE_SIGNATURE) break

    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)

    entries.push({
      fileName: buffer.toString('utf8', offset + 46, offset + 46 + nameLength),
      compressionMethod: buffer.readUInt16LE(offset + 10),
      compressedSize: buffer.readUInt32LE(offset + 20),
      uncompressedSize: buffer.readUInt32LE(offset + 24),
      localHeaderOffset: buffer.readUInt32LE(offset + 42)
    })

    offset += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

/** Inflates one entry's bytes. `maxOutputLength` is a zip-bomb guard, not a
 *  real-world expectation — callers size it to what a legitimate file of
 *  that kind could plausibly be. */
export function inflateZipEntry(buffer: Buffer, entry: ZipEntry, maxOutputLength: number): Buffer {
  const header = entry.localHeaderOffset
  if (header + 30 > buffer.length || buffer.readUInt32LE(header) !== LOCAL_FILE_SIGNATURE) {
    throw new Error('The archive is malformed.')
  }

  // The local header repeats the name/extra lengths, and they can legally
  // differ from the central directory's (extra fields especially) — so the
  // data offset must be computed from the LOCAL header, not the central one.
  const nameLength = buffer.readUInt16LE(header + 26)
  const extraLength = buffer.readUInt16LE(header + 28)
  const start = header + 30 + nameLength + extraLength
  const data = buffer.subarray(start, start + entry.compressedSize)

  if (entry.compressionMethod === 0) return data
  if (entry.compressionMethod !== 8) {
    throw new Error('The archive uses an unsupported compression method.')
  }
  return zlib.inflateRawSync(data, { maxOutputLength })
}
