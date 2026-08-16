// Regression test for src/main/media-hub/vlc.ts's extractSubtitleTracksBatch.
// Run with: npx tsx tests/subtitleExtraction.test.ts
//
// The bug this pins down: the function spawns ffmpeg with stderr on a pipe
// and reads only the extra fds the WebVTT comes out of. With nobody draining
// stderr, ffmpeg blocks on write the moment the pipe buffer fills (Windows:
// 64KB) and never exits, so every extra pipe stays empty and the call sits
// there until the timeout kills it — surfacing in the player as "Extracting…
// this can take a while" for five minutes followed by "no subtitle data was
// found". Demuxing a whole feature-length container at `-loglevel warning`
// clears 64KB easily on a source that warns per packet.
//
// A stub child stands in for ffmpeg (via the spawnImpl seam the function
// already exposes for testing) so the test asserts the pipe plumbing itself
// rather than needing a real media file: same stdio layout, writes a large
// stderr burst first, then the subtitle text on fds 3 and 4.

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { extractSubtitleTracksBatch } from '../src/main/media-hub/vlc'

const SOURCE = 'https://media.example.com/movie.mkv'

/** Comfortably past the 64KB pipe buffer, so an undrained stderr deadlocks. */
const STDERR_BURST_BYTES = 256 * 1024

const FIRST = 'WEBVTT\n\n00:01.000 --> 00:03.000\nfirst track\n'
const SECOND = 'WEBVTT\n\n00:01.000 --> 00:03.000\nsecond track\n'

const CHILD = `
const fs = require('node:fs')
fs.writeSync(2, 'W'.repeat(${STDERR_BURST_BYTES}))
fs.writeSync(3, ${JSON.stringify(FIRST)})
fs.writeSync(4, ${JSON.stringify(SECOND)})
`

/** Runs the stub in place of ffmpeg, keeping the stdio layout under test. */
const spawnImpl = ((_command: string, _args: string[], options: { stdio: unknown }) =>
  spawn(process.execPath, ['-e', CHILD], options as never)) as unknown as (
  ...args: Parameters<typeof spawn>
) => ChildProcess

// Short on purpose: the deadlock's only exit is the timeout, so a
// regression here fails in seconds instead of hanging the suite.
const TIMEOUT_MS = 8000

async function main(): Promise<void> {
  const startedAt = Date.now()
  let loggedBytes = 0
  const results = await extractSubtitleTracksBatch(process.execPath, SOURCE, [0, 1], {
    spawnImpl,
    timeout: TIMEOUT_MS,
    onLog: (chunk) => {
      loggedBytes += chunk.length
    }
  })
  const elapsed = Date.now() - startedAt

  assert.equal(
    results.get(0),
    FIRST,
    'the first subtitle track survives a child that wrote a large stderr burst first'
  )
  assert.equal(results.get(1), SECOND, 'so does every further track sharing the same run')

  // The distinguishing assertion. Before the fix this timed out at
  // `timeout` and returned an empty map; the wall-clock is what separates
  // "worked" from "was killed and happened to be empty either way".
  assert.ok(
    elapsed < TIMEOUT_MS,
    `extraction must finish on its own, not be killed by the timeout (took ${elapsed}ms)`
  )

  assert.equal(
    loggedBytes,
    STDERR_BURST_BYTES,
    'stderr is drained in full (and forwarded, so the warnings still reach the log)'
  )

  // A logging callback that throws must not take the extraction down with
  // it — draining is load-bearing here, not best-effort bookkeeping.
  const despiteThrowingLogger = await extractSubtitleTracksBatch(process.execPath, SOURCE, [0], {
    spawnImpl,
    timeout: TIMEOUT_MS,
    onLog: () => {
      throw new Error('logger exploded')
    }
  })
  assert.equal(despiteThrowingLogger.get(0), FIRST, 'a throwing onLog cannot break the drain')

  // Unchanged guards: nothing to extract, and the SSRF boundary.
  assert.equal(
    (await extractSubtitleTracksBatch(process.execPath, SOURCE, [], { spawnImpl })).size,
    0,
    'no text tracks means no spawn at all'
  )
  assert.equal(
    (
      await extractSubtitleTracksBatch(process.execPath, 'http://127.0.0.1/movie.mkv', [0], {
        spawnImpl
      })
    ).size,
    0,
    'a source outside the allowed set is still refused before spawning'
  )

  console.log('subtitleExtraction tests passed')
}

void main()
