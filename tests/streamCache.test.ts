// Unit tests for streamCache.ts's pure retention-window math
// (computeRetainedChunkIndices/chunkIndexForByte) — the one part of that
// module that doesn't need a real filesystem/HTTP server/Electron `app`,
// and the part most worth pinning down: which chunks survive eviction
// directly determines both "can I rewind/keep buffering ahead" and "does
// this stay a single connection" (see streamCache.ts's own header comment).
// Run with: npx tsx tests/streamCache.test.ts   (or npm.cmd test)

import assert from 'node:assert'
import { chunkIndexForByte, computeRetainedChunkIndices } from '../src/main/media-hub/streamCache'

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

const CHUNK = 4 * 1024 * 1024
const HEAD = 16 * 1024 * 1024 // 4 chunks
const TAIL = 4 * 1024 * 1024 // 1 chunk

console.log('chunkIndexForByte')
check('floors to the chunk boundary', () => {
  assert.equal(chunkIndexForByte(0, CHUNK), 0)
  assert.equal(chunkIndexForByte(CHUNK - 1, CHUNK), 0)
  assert.equal(chunkIndexForByte(CHUNK, CHUNK), 1)
  assert.equal(chunkIndexForByte(CHUNK * 3 + 100, CHUNK), 3)
})

console.log('computeRetainedChunkIndices')

check('fullRetention returns exactly the present set, ignoring every other param', () => {
  const present = [0, 5, 9, 100]
  const retained = computeRetainedChunkIndices({
    presentChunkIndices: present,
    fullRetention: true,
    totalBytes: 1,
    centerByte: 0,
    behindSeconds: 30,
    aheadSeconds: 300,
    bytesPerSecond: undefined,
    headBytes: HEAD,
    tailBytes: TAIL,
    chunkBytes: CHUNK
  })
  assert.deepEqual([...retained].sort((a, b) => a - b), present)
})

check('head region (chunks 0..3 at 16MB/4MB) is always retained regardless of playhead', () => {
  const totalBytes = CHUNK * 1000 // far larger than head+tail so they don't overlap the window
  const retained = computeRetainedChunkIndices({
    presentChunkIndices: [],
    fullRetention: false,
    totalBytes,
    centerByte: CHUNK * 500, // playhead in the middle, nowhere near the head
    behindSeconds: 30,
    aheadSeconds: 300,
    bytesPerSecond: CHUNK, // 1 chunk/sec, so behind=30 chunks, ahead=300 chunks — won't reach chunk 0..3 from 500
    headBytes: HEAD,
    tailBytes: TAIL,
    chunkBytes: CHUNK
  })
  for (let i = 0; i < 4; i++) assert.ok(retained.has(i), `head chunk ${i} should be retained`)
})

check('tail region (last 4MB) is always retained regardless of playhead', () => {
  const totalChunks = 1000
  const totalBytes = CHUNK * totalChunks
  const retained = computeRetainedChunkIndices({
    presentChunkIndices: [],
    fullRetention: false,
    totalBytes,
    centerByte: CHUNK * 10, // playhead near the start, nowhere near the tail
    behindSeconds: 30,
    aheadSeconds: 300,
    bytesPerSecond: CHUNK,
    headBytes: HEAD,
    tailBytes: TAIL,
    chunkBytes: CHUNK
  })
  assert.ok(retained.has(totalChunks - 1), 'last chunk should be retained as the tail')
})

check('window follows the playhead: behind/ahead convert seconds to bytes via bytesPerSecond', () => {
  const totalBytes = CHUNK * 1000
  const centerByte = CHUNK * 500
  const retained = computeRetainedChunkIndices({
    presentChunkIndices: [],
    fullRetention: false,
    totalBytes,
    centerByte,
    behindSeconds: 10,
    aheadSeconds: 20,
    bytesPerSecond: CHUNK, // 1 chunk/sec — 10 chunks behind, 20 ahead
    headBytes: HEAD,
    tailBytes: TAIL,
    chunkBytes: CHUNK
  })
  assert.ok(retained.has(490), 'exactly 10 chunks behind the playhead should be retained')
  assert.ok(retained.has(520), 'exactly 20 chunks ahead of the playhead should be retained')
  assert.ok(!retained.has(478), 'well beyond the behind-window should not be retained')
  assert.ok(!retained.has(530), 'well beyond the ahead-window should not be retained')
})

check('shrinking aheadSeconds shrinks the ahead edge but never the behind edge or pinned regions', () => {
  const totalBytes = CHUNK * 1000
  const centerByte = CHUNK * 500
  const wide = computeRetainedChunkIndices({
    presentChunkIndices: [],
    fullRetention: false,
    totalBytes,
    centerByte,
    behindSeconds: 30,
    aheadSeconds: 300,
    bytesPerSecond: CHUNK,
    headBytes: HEAD,
    tailBytes: TAIL,
    chunkBytes: CHUNK
  })
  const squeezed = computeRetainedChunkIndices({
    presentChunkIndices: [],
    fullRetention: false,
    totalBytes,
    centerByte,
    behindSeconds: 30, // unchanged — squeezeForPressure never touches this
    aheadSeconds: 5, // squeezed under pressure
    bytesPerSecond: CHUNK,
    headBytes: HEAD,
    tailBytes: TAIL,
    chunkBytes: CHUNK
  })
  assert.ok(wide.has(centerByte / CHUNK + 300), 'wide window reaches 300 chunks ahead')
  assert.ok(!squeezed.has(centerByte / CHUNK + 300), 'squeezed window no longer reaches that far')
  assert.ok(squeezed.has(centerByte / CHUNK - 30), 'behind edge is identical after squeezing ahead only')
  for (let i = 0; i < 4; i++) assert.ok(squeezed.has(i), `head chunk ${i} still retained after squeezing`)
})

check('no known bitrate falls back to a fixed chunk-count window instead of an empty one', () => {
  const retained = computeRetainedChunkIndices({
    presentChunkIndices: [],
    fullRetention: false,
    totalBytes: null,
    centerByte: CHUNK * 50,
    behindSeconds: 30,
    aheadSeconds: 300,
    bytesPerSecond: undefined,
    headBytes: HEAD,
    tailBytes: TAIL,
    chunkBytes: CHUNK
  })
  assert.ok(retained.has(50), 'the playhead chunk itself is always retained')
  assert.ok(retained.size > 4, 'falls back to a real window, not just the pinned head region')
})

check('window never reads past totalBytes when known', () => {
  const totalBytes = CHUNK * 10 + 100 // just over 10 chunks
  const retained = computeRetainedChunkIndices({
    presentChunkIndices: [],
    fullRetention: false,
    totalBytes,
    centerByte: CHUNK * 9,
    behindSeconds: 30,
    aheadSeconds: 300, // would reach far past EOF if not clamped
    bytesPerSecond: CHUNK,
    headBytes: HEAD,
    tailBytes: TAIL,
    chunkBytes: CHUNK
  })
  assert.ok(retained.has(10), 'the last real chunk is retained')
  assert.ok(!retained.has(50), 'nothing past the file end is ever retained')
})

console.log(`\n${pass} passed`)
