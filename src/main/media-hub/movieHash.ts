// Reads the two 64KB windows OpenSubtitles' hash algorithm needs off the
// stream somebody is actually watching, and turns them into the hash itself
// — see shared/media-hub/movieHash.ts for the algorithm, and its own header
// for why this matters: an IMDb-matched subtitle is matched to the TITLE, a
// hash-matched one is matched to the exact RELEASE on screen, frame-accurate
// by construction.
//
// Read from StreamCache's own local origin, not the remote debrid link
// directly — the same reasoning captureThumbnail already established: one
// connection to the remote source, reused, rather than a second one opened
// just for this. A request for the LAST 64KB is not a special case to that
// cache: it is the same kind of out-of-order read a person scrubbing to the
// end of the file already produces, and the cache's own reposition/retry
// logic (streamCache.ts's serveRange) is what makes that request finish
// instead of hanging.
//
// Every failure here is silent, deliberately. This computes an UPGRADE to a
// subtitle search that already works without it — a slow tail read on an
// unfinished torrent, a source with no known length, a transcoded stream
// with nothing to hash — must fall back to exactly the search this app has
// always done, never break it or hold it up.

import http from 'node:http'

import { MIN_HASHABLE_BYTES, openSubtitlesHash } from '../../shared/media-hub/movieHash'

const CHUNK_BYTES = 65536

/**
 * How long the whole computation is allowed before giving up.
 *
 * Generous, because the tail read can genuinely mean waiting on a torrent's
 * own download of a part of the file nothing has fetched yet — but bounded,
 * so a stalled or unusually slow source cannot leave a subtitle search
 * hanging behind it. Subtitle search already has its own request timeouts on
 * top of this (see subtitlesService.ts); this only has to not be the longest
 * one of the bunch.
 */
const HASH_TIMEOUT_MS = 8000

function head(url: string, signal: AbortSignal): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'HEAD', signal }, (res) => {
      const length = Number(res.headers['content-length'])
      res.resume()
      resolve(Number.isFinite(length) && length > 0 ? length : null)
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * Reads exactly `length` bytes starting at `start`, then closes the
 * connection.
 *
 * StreamCache's serveRange streams from the requested byte to the end of the
 * file (or forever, for a source of unknown length) — it has no notion of an
 * END of a range, because nothing else in this app has ever asked it for
 * one. A caller that only wants one 64KB window has no reason to keep that
 * connection open past it, so this destroys the response the moment enough
 * has arrived rather than waiting for a server-side end it will never send.
 */
function readRange(
  url: string,
  start: number,
  length: number,
  signal: AbortSignal
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: 'GET', headers: { range: `bytes=${start}-` }, signal },
      (res) => {
        const parts: Buffer[] = []
        let received = 0
        let settled = false
        res.on('data', (part: Buffer) => {
          if (settled) return
          parts.push(part)
          received += part.length
          if (received < length) return
          settled = true
          res.destroy()
          resolve(Buffer.concat(parts).subarray(0, length))
        })
        res.on('end', () => {
          // The stream ended before `length` bytes arrived — a source
          // shorter than HEAD reported, or one that stalled. Whatever came
          // through is not a valid window for the algorithm, which requires
          // exactly 65536 bytes; report what's missing rather than pad it
          // with zeros and produce a hash for a file that does not exist.
          if (!settled) reject(new Error(`Expected ${length} bytes, got ${received}.`))
        })
        res.on('error', (error) => {
          if (!settled) reject(error)
        })
      }
    )
    req.on('error', reject)
    req.end()
  })
}

export interface StreamMovieHash {
  hash: string
  bytes: number
}

/**
 * Hashes whatever is playing right now, or resolves to null when it can't —
 * no stream, no known length, too small a file, a slow tail, or any I/O
 * error along the way. Every one of those is an ordinary, expected outcome
 * here, not a bug worth logging: see the file header.
 */
export async function computeActiveStreamHash(url: string): Promise<StreamMovieHash | null> {
  if (!url) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HASH_TIMEOUT_MS)
  try {
    const totalBytes = await head(url, controller.signal)
    if (totalBytes === null || totalBytes < MIN_HASHABLE_BYTES) return null
    const [first, last] = await Promise.all([
      readRange(url, 0, CHUNK_BYTES, controller.signal),
      readRange(url, totalBytes - CHUNK_BYTES, CHUNK_BYTES, controller.signal)
    ])
    return { hash: openSubtitlesHash(first, last, totalBytes), bytes: totalBytes }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
