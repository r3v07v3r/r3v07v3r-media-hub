// The OpenSubtitles/"moviehash" algorithm — a 64-bit checksum computed from
// a file's size plus its first and last 64KB, published by OpenSubtitles as
// a standard every major subtitle client (Kodi, VLC, Bazarr, Subliminal)
// implements identically so results are interchangeable between them.
//
// WHY THIS EXISTS. Every subtitle search this app has ever done matches by
// IMDb id (or title) plus season/episode — which finds subtitles for the
// TITLE, not for the specific RELEASE somebody is actually playing. Two
// releases of the same episode can differ by a few seconds of intro,
// different encode framerates, or a few extra frames of a studio logo, and
// any of those is enough for an IMDb-matched subtitle to drift out of sync
// over two hours. A hash match is keyed to the exact bytes on screen, so
// when one exists it is frame-accurate by construction — no manual delay
// nudging required.
//
// Pure and file-agnostic on purpose: this module only does arithmetic on
// buffers already in hand. Reading those buffers off a live stream (a
// player's local StreamCache origin, in this app's case) is main-only I/O
// and lives in main/media-hub/movieHash.ts instead — see that file for why
// small files are never hashed at all.

/** Below this, the first-64KB and last-64KB windows the algorithm reads
 *  would overlap, and the file no longer has two independent halves to
 *  checksum. This is the reference implementation's own precondition, not a
 *  choice made here — see the OpenSubtitles hash specification. */
export const MIN_HASHABLE_BYTES = 65536 * 2

/**
 * Sums a buffer as consecutive little-endian 64-bit words, wrapping on
 * overflow the way the reference C implementation's `unsigned long long`
 * arithmetic does.
 *
 * JavaScript has no native 64-bit integer arithmetic with wraparound, which
 * is exactly what this needs — BigInt does, and `BigInt.asUintN(64, ...)` is
 * the direct translation of the reference's implicit modulo-2^64 behaviour.
 */
function sumLittleEndianWords(buffer: Buffer): bigint {
  let sum = 0n
  // The algorithm is defined only for buffers that are a whole number of
  // 8-byte words — true for every 65536-byte chunk this is ever called
  // with, since 65536 / 8 is exact.
  for (let offset = 0; offset < buffer.length; offset += 8) {
    sum = BigInt.asUintN(64, sum + buffer.readBigUInt64LE(offset))
  }
  return sum
}

/**
 * The hash, as OpenSubtitles' API expects it: 16 lowercase hex characters,
 * zero-padded.
 *
 * `firstChunk` and `lastChunk` must each be exactly 65536 bytes — the
 * caller's job, since only main/media-hub/movieHash.ts knows how to read
 * them off a real file, and this module stays pure. `fileSizeBytes` must be
 * at least MIN_HASHABLE_BYTES; the caller checks that BEFORE reading either
 * chunk, since there is no point downloading 128KB from a stream only to
 * throw the reads away.
 */
export function openSubtitlesHash(
  firstChunk: Buffer,
  lastChunk: Buffer,
  fileSizeBytes: number
): string {
  if (firstChunk.length !== 65536 || lastChunk.length !== 65536) {
    throw new Error('Each chunk must be exactly 65536 bytes.')
  }
  if (!Number.isFinite(fileSizeBytes) || fileSizeBytes < MIN_HASHABLE_BYTES) {
    throw new Error('File is too small to hash.')
  }
  const sum = BigInt.asUintN(
    64,
    sumLittleEndianWords(firstChunk) +
      sumLittleEndianWords(lastChunk) +
      BigInt(Math.trunc(fileSizeBytes))
  )
  return sum.toString(16).padStart(16, '0')
}
