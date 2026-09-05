// Unit tests for streamCache.ts's pure retention-window math
// (computeRetainedChunkIndices/chunkIndexForByte) — the one part of that
// module that doesn't need a real filesystem/HTTP server/Electron `app`,
// and the part most worth pinning down: which chunks survive eviction
// directly determines both "can I rewind/keep buffering ahead" and "does
// this stay a single connection" (see streamCache.ts's own header comment).
// Run with: npx tsx tests/streamCache.test.ts   (or npm.cmd test)

import assert from 'node:assert'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  cacheContentKey,
  chunkIndexForByte,
  computeRetainedChunkIndices,
  createMemoryChunkStore,
  fillBudgetBytes,
  inspectRangeReply,
  shouldAdoptAsPlayhead,
  findReusableSession
} from '../src/main/media-hub/streamCache'

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

// What a range fetch's reply has to look like before its body is allowed
// to become chunk files — the check whose absence let a debrid link's
// error page, or a whole-file reply to a mid-file request, be written to
// disk as if it were the requested bytes and decoded as corrupt picture.
console.log('inspectRangeReply')
check('a 206 covering the requested start is the bytes asked for', () => {
  const verdict = inspectRangeReply(206, 'bytes 8388608-99999999/100000000', 8388608, null)
  assert.equal(verdict.problem, null)
  assert.equal(verdict.total, 100000000, 'learns the file length from the reply')
})
check('a 206 for a different start is refused', () => {
  const verdict = inspectRangeReply(206, 'bytes 0-99999999/100000000', 8388608, null)
  assert.ok(verdict.problem, 'must be refused')
  assert.match(verdict.problem ?? '', /from 0 when 8388608/)
})
check('a 206 whose total disagrees with the known length is refused', () => {
  const verdict = inspectRangeReply(206, 'bytes 8388608-999/1000', 8388608, 100000000)
  assert.ok(verdict.problem, 'a different-length file is a different file')
})
check('a 206 without a usable content-range is refused', () => {
  assert.ok(inspectRangeReply(206, null, 4096, null).problem)
  assert.ok(inspectRangeReply(206, 'bytes */100', 4096, null).problem)
})
check('an unknown total in the content-range is tolerated', () => {
  const verdict = inspectRangeReply(206, 'bytes 4096-8191/*', 4096, null)
  assert.equal(verdict.problem, null)
  assert.equal(verdict.total, null)
})
check('a whole-file 200 is only the right bytes from byte zero', () => {
  assert.equal(inspectRangeReply(200, null, 0, null).problem, null)
  assert.ok(
    inspectRangeReply(200, null, CHUNK, null).problem,
    'from mid-file a 200 is the wrong bytes'
  )
})
check('an error status is never written as data', () => {
  for (const status of [403, 404, 410, 416, 500, 502, 503]) {
    assert.ok(inspectRangeReply(status, null, 0, null).problem, `HTTP ${status} must be refused`)
  }
})

console.log('computeRetainedChunkIndices')

check('fullRetention returns exactly the present set, ignoring every other param', () => {
  const present = [0, 5, 9, 100]
  const retained = computeRetainedChunkIndices({
    presentChunkIndices: present,
    fullRetention: true,
    totalBytes: 1,
    centerBytes: [0],
    behindSeconds: 30,
    aheadSeconds: 300,
    bytesPerSecond: undefined,
    headBytes: HEAD,
    tailBytes: TAIL,
    chunkBytes: CHUNK
  })
  assert.deepEqual(
    [...retained].sort((a, b) => a - b),
    present
  )
})

check('head region (chunks 0..3 at 16MB/4MB) is always retained regardless of playhead', () => {
  const totalBytes = CHUNK * 1000 // far larger than head+tail so they don't overlap the window
  const retained = computeRetainedChunkIndices({
    presentChunkIndices: [],
    fullRetention: false,
    totalBytes,
    centerBytes: [CHUNK * 500], // playhead in the middle, nowhere near the head
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
    centerBytes: [CHUNK * 10], // playhead near the start, nowhere near the tail
    behindSeconds: 30,
    aheadSeconds: 300,
    bytesPerSecond: CHUNK,
    headBytes: HEAD,
    tailBytes: TAIL,
    chunkBytes: CHUNK
  })
  assert.ok(retained.has(totalChunks - 1), 'last chunk should be retained as the tail')
})

check(
  'window follows the playhead: behind/ahead convert seconds to bytes via bytesPerSecond',
  () => {
    const totalBytes = CHUNK * 1000
    const centerByte = CHUNK * 500
    const retained = computeRetainedChunkIndices({
      presentChunkIndices: [],
      fullRetention: false,
      totalBytes,
      centerBytes: [centerByte],
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
  }
)

check(
  'shrinking aheadSeconds shrinks the ahead edge but never the behind edge or pinned regions',
  () => {
    const totalBytes = CHUNK * 1000
    const centerByte = CHUNK * 500
    const wide = computeRetainedChunkIndices({
      presentChunkIndices: [],
      fullRetention: false,
      totalBytes,
      centerBytes: [centerByte],
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
      centerBytes: [centerByte],
      behindSeconds: 30, // unchanged — squeezeForPressure never touches this
      aheadSeconds: 5, // squeezed under pressure
      bytesPerSecond: CHUNK,
      headBytes: HEAD,
      tailBytes: TAIL,
      chunkBytes: CHUNK
    })
    assert.ok(wide.has(centerByte / CHUNK + 300), 'wide window reaches 300 chunks ahead')
    assert.ok(!squeezed.has(centerByte / CHUNK + 300), 'squeezed window no longer reaches that far')
    assert.ok(
      squeezed.has(centerByte / CHUNK - 30),
      'behind edge is identical after squeezing ahead only'
    )
    for (let i = 0; i < 4; i++)
      assert.ok(squeezed.has(i), `head chunk ${i} still retained after squeezing`)
  }
)

check('no known bitrate falls back to a fixed chunk-count window instead of an empty one', () => {
  const retained = computeRetainedChunkIndices({
    presentChunkIndices: [],
    fullRetention: false,
    totalBytes: null,
    centerBytes: [CHUNK * 50],
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
    centerBytes: [CHUNK * 9],
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

// The regression this whole multi-centre shape exists for — see
// streamCache.ts's module header. Every MKV demux does one incidental read
// near EOF (Cues/SeekHead); with a single forward-only centre that read
// permanently moved the retention window to the end of the file and the
// chunks around the real playhead were evicted as fast as they arrived,
// killing playback a few seconds in.
check('a concurrent tail probe never evicts the playhead window', () => {
  const totalChunks = 1000
  const totalBytes = CHUNK * totalChunks
  const playhead = CHUNK * 40 // past the pinned 16MB head
  const tailProbe = CHUNK * (totalChunks - 2) // ffmpeg reading Matroska Cues
  const retained = computeRetainedChunkIndices({
    presentChunkIndices: [],
    fullRetention: false,
    totalBytes,
    centerBytes: [playhead, tailProbe],
    behindSeconds: 30,
    aheadSeconds: 300,
    bytesPerSecond: CHUNK, // 1 chunk/sec
    headBytes: HEAD,
    tailBytes: TAIL,
    chunkBytes: CHUNK
  })
  assert.ok(retained.has(40), 'the playhead chunk itself survives the tail probe')
  assert.ok(retained.has(41), 'so does the chunk playback is about to need')
  assert.ok(retained.has(70), 'and the ahead-window in front of the playhead')
  assert.ok(retained.has(totalChunks - 2), "the probe's own position is retained too")
})

check('each centre gets its own window rather than one spanning window between them', () => {
  const totalBytes = CHUNK * 1000
  const retained = computeRetainedChunkIndices({
    presentChunkIndices: [],
    fullRetention: false,
    totalBytes,
    centerBytes: [CHUNK * 100, CHUNK * 800],
    behindSeconds: 10,
    aheadSeconds: 20,
    bytesPerSecond: CHUNK,
    headBytes: HEAD,
    tailBytes: TAIL,
    chunkBytes: CHUNK
  })
  assert.ok(retained.has(100) && retained.has(800), 'both centres are retained')
  assert.ok(!retained.has(450), 'the gap between them is not retained')
})

// --- Which fills may keep the one connection -----------------------------
// Retention decides what survives on disk; this decides who the single
// upstream connection is currently working FOR. Same distinction (playhead
// vs incidental probe), different consequence — and the consequence here is
// the one that stalls playback: a captured failure had a tail probe pull
// 340MB to EOF while the playhead sat at 33 seconds with nothing queued.

console.log('fillBudgetBytes')

const TOLERANCE = CHUNK * 8

check('the byte the playhead needs next is unbounded', () => {
  assert.equal(fillBudgetBytes({ targetByte: CHUNK * 26, playheadFillByte: CHUNK * 26 }), null)
})

check('a demuxer reading a little in front of it is still the playhead fill', () => {
  assert.equal(fillBudgetBytes({ targetByte: CHUNK * 30, playheadFillByte: CHUNK * 26 }), null)
})

check('one chunk of slack behind, for a mid-chunk read', () => {
  assert.equal(
    fillBudgetBytes({ targetByte: CHUNK * 26, playheadFillByte: CHUNK * 26 + 1000 }),
    null
  )
})

check('a tail probe far past the playhead is a bounded excursion', () => {
  // The captured stall: playhead needs chunk 26, ffmpeg reads Cues at 2416.
  assert.equal(
    fillBudgetBytes({ targetByte: CHUNK * 2416, playheadFillByte: CHUNK * 26 }),
    CHUNK * 4
  )
})

check('a probe inside the 300s ahead-window is still bounded', () => {
  // Regression guard: classifying against the retention ahead-window (~224
  // chunks at a 4K bitrate) let a probe this close read as the playhead's
  // own fill and run to EOF while the playhead drained.
  assert.equal(
    fillBudgetBytes({ targetByte: CHUNK * 200, playheadFillByte: CHUNK * 26 }),
    CHUNK * 4
  )
})

check('a probe behind the playhead is bounded too', () => {
  assert.equal(fillBudgetBytes({ targetByte: 0, playheadFillByte: CHUNK * 800 }), CHUNK * 4)
})

check('the tolerance edge is inclusive, one byte past it is not', () => {
  const playheadFillByte = CHUNK * 10
  assert.equal(
    fillBudgetBytes({ targetByte: playheadFillByte + TOLERANCE, playheadFillByte }),
    null
  )
  assert.equal(
    fillBudgetBytes({ targetByte: playheadFillByte + TOLERANCE + 1, playheadFillByte }),
    CHUNK * 4
  )
})

check('a fresh session (playhead needs byte 0) fills from the start unbounded', () => {
  assert.equal(fillBudgetBytes({ targetByte: 0, playheadFillByte: 0 }), null)
})

check('a fully-buffered playhead makes every fill an excursion', () => {
  // null = the playhead needs nothing right now, so nobody's playhead is
  // waiting on this fetch and it must not get to run to EOF.
  assert.equal(fillBudgetBytes({ targetByte: CHUNK * 500, playheadFillByte: null }), CHUNK * 4)
})

// --- Who is allowed to become the playhead ---------------------------------
// The invariant that has broken twice: a reader being served a detour must
// never be adopted as the retention centre every fill is then classified
// against. The 8MB adoption bar sits inside a 16MB excursion budget, so
// byte count alone cannot carry this.

console.log('shouldAdoptAsPlayhead')

const MIN_SERVED = CHUNK * 2

check('a connection that streamed enough becomes the playhead', () => {
  assert.equal(shouldAdoptAsPlayhead({ servedBytes: MIN_SERVED, servingExcursion: false }), true)
})

check('a short metadata probe does not', () => {
  assert.equal(
    shouldAdoptAsPlayhead({ servedBytes: MIN_SERVED - 1, servingExcursion: false }),
    false
  )
})

check('a reader being served an excursion never does, however much it reads', () => {
  // A full 16MB excursion budget is twice the 8MB bar — without this the
  // probe becomes the playhead and its next miss retakes the connection.
  assert.equal(shouldAdoptAsPlayhead({ servedBytes: CHUNK * 4, servingExcursion: true }), false)
  assert.equal(shouldAdoptAsPlayhead({ servedBytes: CHUNK * 500, servingExcursion: true }), false)
})

check('clearing the excursion flag lets a genuine playhead be adopted again', () => {
  // A seek moves the playhead first, so that reader's next miss classifies
  // as the playhead's own fill and the flag goes back to false.
  assert.equal(shouldAdoptAsPlayhead({ servedBytes: CHUNK * 4, servingExcursion: false }), true)
})

console.log(`\n${pass} passed`)

// --- Reusing an existing cache -------------------------------------------
// Replaying a title used to download a second full copy while the first sat on
// disk beside it: stopPlayback keeps the cache for a later resume, and nothing
// ever read it back. Adoption is what closes that, and its failure mode is the
// dangerous kind — serving one film's bytes believing they are another's — so
// what is pinned here is mostly what must NOT be adopted.

async function withTempRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-cache-test-'))
  try {
    await fn(root)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
}

const TOKEN_A = 'a'.repeat(64)
const TOKEN_B = 'b'.repeat(64)

async function writeSession(
  root: string,
  token: string,
  meta: Record<string, unknown>
): Promise<void> {
  await fsp.mkdir(path.join(root, token), { recursive: true })
  await fsp.writeFile(path.join(root, token, 'meta.json'), JSON.stringify(meta))
}

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}
      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

check('content key ignores the remote URL, which changes every play', () => {
  // TorBox mints a fresh requestdl link each time, so the key must come from
  // catalog identity instead.
  assert.equal(cacheContentKey({ title: 'Dune', catalogId: 'tt1160419' }), 'tt1160419::')
  assert.equal(
    cacheContentKey({ title: 'Show', catalogId: 'tt1', seasonNumber: 2, episodeNumber: 5 }),
    'tt1:2:5'
  )
  // Falls back to title for sessions written before catalogId was recorded.
  assert.equal(cacheContentKey({ title: 'Dune' }), 'dune::')
  // Nothing identifiable means never reusable.
  assert.equal(cacheContentKey({ title: '' }), '')
  assert.equal(cacheContentKey(undefined), '')
})

check('an episode never matches a different episode of the same show', () => {
  const s2e5 = cacheContentKey({ title: 'S', catalogId: 'tt1', seasonNumber: 2, episodeNumber: 5 })
  const s2e6 = cacheContentKey({ title: 'S', catalogId: 'tt1', seasonNumber: 2, episodeNumber: 6 })
  assert.notEqual(s2e5, s2e6)
})

// --- memory-only store ("never store media on this machine") --------------

check('the memory store round-trips a chunk', () => {
  const store = createMemoryChunkStore()
  assert.equal(store.persistent, false, 'memory chunks must not claim to outlive the process')
  void store.write('/unused', 'tok', 0, Buffer.from('hello'))
})

async function memoryStoreChecks(): Promise<void> {
  await checkAsync('reads back exactly what was written', async () => {
    const store = createMemoryChunkStore()
    await store.write('/unused', 'tok', 3, Buffer.from('abcdef'))
    assert.equal((await store.read('/unused', 'tok', 3)).toString(), 'abcdef')
  })

  await checkAsync('copies the chunk instead of retaining the caller buffer', async () => {
    // runFill hands write() a subarray of its rolling buffer and then keeps
    // mutating it. Storing the view would both corrupt the chunk and pin
    // the whole parent ArrayBuffer, blowing past the configured cap.
    const store = createMemoryChunkStore()
    const rolling = Buffer.from('ORIGINAL')
    await store.write('/unused', 'tok', 0, rolling.subarray(0, 8))
    rolling.write('OVERWRIT', 0)
    assert.equal((await store.read('/unused', 'tok', 0)).toString(), 'ORIGINAL')
  })

  await checkAsync('a missing chunk rejects rather than resolving empty', async () => {
    const store = createMemoryChunkStore()
    await assert.rejects(() => store.read('/unused', 'tok', 9))
  })

  await checkAsync('remove drops one chunk, clear drops one session', async () => {
    const store = createMemoryChunkStore()
    await store.write('/unused', 'a', 0, Buffer.from('a0'))
    await store.write('/unused', 'a', 1, Buffer.from('a1'))
    await store.write('/unused', 'b', 0, Buffer.from('b0'))

    await store.remove('/unused', 'a', 0)
    await assert.rejects(() => store.read('/unused', 'a', 0), 'the removed chunk is gone')
    assert.equal((await store.read('/unused', 'a', 1)).toString(), 'a1', 'its sibling survives')

    store.clear('a')
    await assert.rejects(() => store.read('/unused', 'a', 1), 'clear drops the whole session')
    assert.equal((await store.read('/unused', 'b', 0)).toString(), 'b0', 'other sessions untouched')
  })

  await checkAsync('writes nothing to the filesystem', async () => {
    // The whole point of the mode: a real cache root is handed in and must
    // come back untouched.
    await withTempRoot(async (root) => {
      const store = createMemoryChunkStore()
      await store.write(root, 'tok', 0, Buffer.from('secret bytes'))
      await store.write(root, 'tok', 1, Buffer.from('more secret bytes'))
      await store.read(root, 'tok', 0)
      assert.deepEqual(await fsp.readdir(root), [], 'the cache root must stay empty')
    })
  })
}

async function main(): Promise<void> {
  await memoryStoreChecks()

  await checkAsync('adopts a session with the same content AND the same length', async () => {
    await withTempRoot(async (root) => {
      await writeSession(root, TOKEN_A, { title: 'Dune', catalogId: 'tt1', totalBytes: 5000 })
      const found = await findReusableSession(root, { title: 'Dune', catalogId: 'tt1' }, 5000)
      assert.equal(found, TOKEN_A)
    })
  })

  await checkAsync('refuses a different release of the same title', async () => {
    await withTempRoot(async (root) => {
      // Same film, different encode: the length differs, so the cached bytes
      // are not the bytes now being streamed. This is the check that keeps
      // reuse from silently corrupting playback.
      await writeSession(root, TOKEN_A, { title: 'Dune', catalogId: 'tt1', totalBytes: 5000 })
      const found = await findReusableSession(root, { title: 'Dune', catalogId: 'tt1' }, 9999)
      assert.equal(found, '')
    })
  })

  await checkAsync('refuses a different title that happens to be the same length', async () => {
    await withTempRoot(async (root) => {
      await writeSession(root, TOKEN_A, { title: 'Dune', catalogId: 'tt1', totalBytes: 5000 })
      const found = await findReusableSession(root, { title: 'Arrival', catalogId: 'tt2' }, 5000)
      assert.equal(found, '')
    })
  })

  await checkAsync('refuses when the remote length is unknown', async () => {
    await withTempRoot(async (root) => {
      await writeSession(root, TOKEN_A, { title: 'Dune', catalogId: 'tt1', totalBytes: 5000 })
      assert.equal(await findReusableSession(root, { title: 'Dune', catalogId: 'tt1' }, null), '')
    })
  })

  await checkAsync('skips the session currently being started', async () => {
    await withTempRoot(async (root) => {
      await writeSession(root, TOKEN_A, { title: 'Dune', catalogId: 'tt1', totalBytes: 5000 })
      assert.equal(
        await findReusableSession(root, { title: 'Dune', catalogId: 'tt1' }, 5000, TOKEN_A),
        ''
      )
    })
  })

  await checkAsync('ignores unreadable meta and non-session directories', async () => {
    await withTempRoot(async (root) => {
      await fsp.mkdir(path.join(root, 'not-a-session'), { recursive: true })
      await fsp.mkdir(path.join(root, TOKEN_B), { recursive: true })
      await fsp.writeFile(path.join(root, TOKEN_B, 'meta.json'), 'not json')
      assert.equal(await findReusableSession(root, { title: 'Dune', catalogId: 'tt1' }, 5000), '')
    })
  })

  await checkAsync('a missing cache root is not an error', async () => {
    const missing = path.join(os.tmpdir(), 'r3-cache-does-not-exist-' + String(fs.constants.F_OK))
    assert.equal(await findReusableSession(missing, { title: 'D', catalogId: 't' }, 1), '')
  })

  console.log(`
${pass} passed`)
}

void main()
