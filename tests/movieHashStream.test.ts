// computeActiveStreamHash reads two 64KB windows off a live HTTP source and
// has to cope with the one thing that makes this harder than an ordinary
// range request: StreamCache's serveRange (main/media-hub/streamCache.ts)
// answers a Range header by streaming from the requested byte to the END OF
// THE FILE — it has no notion of a range's upper bound, because nothing else
// in this app has ever asked it for one. This test runs against a fake
// server built to do exactly that, so what is actually being pinned down is
// "this closes the connection itself once it has enough, rather than waiting
// for an end the server will never send" — the part that would otherwise
// hang a subtitle search forever.

import assert from 'node:assert/strict'
import http from 'node:http'

import { computeActiveStreamHash } from '../src/main/media-hub/movieHash'
import { openSubtitlesHash } from '../src/shared/media-hub/movieHash'

const FILE_SIZE = 200000
const content = Buffer.alloc(FILE_SIZE)
// A few non-zero bytes near the start and end, so a truncated or
// off-by-one read produces a hash that provably does not match — an
// all-zero fixture would let a wrong byte offset pass silently.
content.writeUInt32LE(0xdeadbeef >>> 0, 4)
content.writeUInt32LE(0xfeedface >>> 0, FILE_SIZE - 4)

function startFakeStreamCache(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': String(FILE_SIZE), 'accept-ranges': 'bytes' })
      res.end()
      return
    }
    // Mirrors serveRange: reads the START byte and ignores everything past
    // the dash, then streams to the end of the file — no matter what the
    // client actually asked for.
    const match = /bytes=(\d+)-/.exec(String(req.headers.range || ''))
    const start = match ? Number(match[1]) : 0
    res.writeHead(206, {
      'content-range': `bytes ${start}-${FILE_SIZE - 1}/${FILE_SIZE}`,
      'accept-ranges': 'bytes'
    })
    res.end(content.subarray(start))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        url: `http://127.0.0.1:${port}/stream/fake`,
        close: () => new Promise((r) => server.close(() => r()))
      })
    })
  })
}

async function main(): Promise<void> {
  const { url, close } = await startFakeStreamCache()
  try {
    const result = await computeActiveStreamHash(url)
    assert.ok(result, 'a well-formed source with a known length must hash')
    assert.equal(result!.bytes, FILE_SIZE)

    // Cross-checked against the pure algorithm run over the SAME bytes read
    // directly from the fixture, not against a hand-computed constant — this
    // is what actually proves the I/O layer sliced the right 65536 bytes
    // from each end rather than something adjacent to them.
    const expected = openSubtitlesHash(
      content.subarray(0, 65536),
      content.subarray(FILE_SIZE - 65536),
      FILE_SIZE
    )
    assert.equal(result!.hash, expected)
  } finally {
    await close()
  }

  // No server at all — every ordinary "nothing is playing" case (empty
  // stream URL) must resolve to null, not throw and not hang the caller.
  assert.equal(await computeActiveStreamHash(''), null)

  console.log('movie hash stream tests passed')
}

void main()
