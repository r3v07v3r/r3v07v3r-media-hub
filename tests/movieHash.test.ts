// The OpenSubtitles hash algorithm — sum of first/last 64KB as little-endian
// 64-bit words, plus file size, wrapping on overflow.
//
// There is no real video file in this test environment to check against
// OpenSubtitles' own published example, so every vector here is synthetic
// and hand-designed instead: simple enough that the expected value is
// computed independently with plain Number arithmetic (never exceeding
// Number.MAX_SAFE_INTEGER in these cases), as a cross-check against the
// BigInt implementation rather than a restatement of it. What this pins
// down is the mechanics that are easy to get quietly wrong — byte order,
// chunk boundaries, and 64-bit wraparound — not fidelity to one canonical
// external number.

import assert from 'node:assert/strict'

import { MIN_HASHABLE_BYTES, openSubtitlesHash } from '../src/shared/media-hub/movieHash'

assert.equal(MIN_HASHABLE_BYTES, 131072, "two 64KB windows — the spec's own precondition")

function chunk(fill: (buf: Buffer) => void): Buffer {
  const buf = Buffer.alloc(65536)
  fill(buf)
  return buf
}

const zeroChunk = Buffer.alloc(65536)

// ---------------------------------------------------------------------
// An all-zero file at exactly the minimum hashable size: every word sums to
// zero, so the hash is just the file size itself, in hex.
// ---------------------------------------------------------------------
assert.equal(
  openSubtitlesHash(zeroChunk, zeroChunk, MIN_HASHABLE_BYTES),
  (131072).toString(16).padStart(16, '0')
)

// ---------------------------------------------------------------------
// One word set in the FIRST chunk, little-endian: byte 0 is the low byte,
// so a lone 0x05 there is the value 5, not 5 shifted into some other
// position. Catches a byte-order mistake that would otherwise pass by
// coincidence on a big round number.
// ---------------------------------------------------------------------
{
  const first = chunk((buf) => buf.writeUInt8(5, 0))
  const fileSize = 200000
  const expected = (5 + fileSize).toString(16).padStart(16, '0')
  assert.equal(openSubtitlesHash(first, zeroChunk, fileSize), expected)
}

// ---------------------------------------------------------------------
// The SAME word placed in the LAST chunk instead must contribute the same
// amount — the two windows are summed the same way, not treated
// asymmetrically.
// ---------------------------------------------------------------------
{
  const last = chunk((buf) => buf.writeUInt8(5, 0))
  const fileSize = 200000
  const expected = (5 + fileSize).toString(16).padStart(16, '0')
  assert.equal(openSubtitlesHash(zeroChunk, last, fileSize), expected)
}

// ---------------------------------------------------------------------
// Two non-zero words, one in each chunk, at a non-zero offset within the
// chunk — exercises reading past the first 8 bytes, not just the start.
// ---------------------------------------------------------------------
{
  const first = chunk((buf) => buf.writeUInt32LE(1000, 8))
  const last = chunk((buf) => buf.writeUInt32LE(2000, 65536 - 8))
  const fileSize = 500000
  const expected = (1000 + 2000 + fileSize).toString(16).padStart(16, '0')
  assert.equal(openSubtitlesHash(first, last, fileSize), expected)
}

// ---------------------------------------------------------------------
// 64-bit wraparound: the reference algorithm uses unsigned 64-bit
// arithmetic, so the maximum word value plus anything at all must wrap
// rather than overflow into a wider type. This is exactly the failure mode
// plain JS Number arithmetic (53 bits of precision) cannot represent —
// BigInt.asUintN is what this implementation leans on to get it right.
// ---------------------------------------------------------------------
{
  const maxWord = chunk((buf) => buf.writeBigUInt64LE(0xffffffffffffffffn, 0))
  const fileSize = 131072
  // (2^64 - 1) + fileSize, mod 2^64, computed independently via BigInt here
  // (not by re-deriving the implementation's own summation) as the
  // cross-check.
  const expected = ((0xffffffffffffffffn + BigInt(fileSize)) % (1n << 64n))
    .toString(16)
    .padStart(16, '0')
  assert.equal(openSubtitlesHash(maxWord, zeroChunk, fileSize), expected)
  assert.equal(expected, (fileSize - 1).toString(16).padStart(16, '0'), 'wraps back past zero')
}

// ---------------------------------------------------------------------
// Guards.
// ---------------------------------------------------------------------
assert.throws(() => openSubtitlesHash(zeroChunk, zeroChunk, MIN_HASHABLE_BYTES - 1))
assert.throws(() => openSubtitlesHash(Buffer.alloc(100), zeroChunk, MIN_HASHABLE_BYTES))
assert.throws(() => openSubtitlesHash(zeroChunk, Buffer.alloc(100), MIN_HASHABLE_BYTES))

console.log('movie hash tests passed')
