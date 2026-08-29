import assert from 'node:assert/strict'
import { measureDownstream, type SampleDownloader } from '../src/shared/media-hub/speedTest'

const MiB = 1024 * 1024

/** A link of a fixed speed, with a fixed per-request setup cost that the
 *  measurement is supposed to exclude. Records what was asked for. */
function link(mbps: number, setupSeconds = 0.2): { download: SampleDownloader; asked: number[] } {
  const asked: number[] = []
  const download: SampleDownloader = async (bytes) => {
    asked.push(bytes)
    const seconds = (bytes * 8) / (mbps * 1_000_000)
    // The first chunk carries the setup cost and is excluded from the timed
    // window, exactly as downloadSample does with a real body.
    const chunk = Math.min(bytes, 64 * 1024)
    return {
      timedBytes: bytes - chunk,
      seconds: seconds * ((bytes - chunk) / bytes),
      totalBytes: bytes
    }
  }
  void setupSeconds
  return { download, asked }
}

async function main(): Promise<void> {
  // --- self-limiting: a slow line must never escalate ----------------------
  // This is the property that makes escalation safe to leave on by default.
  // 12 Mbps is the farm-wireless case the threshold was calibrated against.
  for (const mbps of [1, 3, 5, 8, 12, 15]) {
    const { download, asked } = link(mbps)
    const result = await measureDownstream(download)
    assert.equal(asked.length, 1, `${mbps} Mbps must take exactly one sample`)
    assert.equal(asked[0], MiB, `${mbps} Mbps must download exactly 1 MiB`)
    assert.ok(
      Math.abs(result.speedMbps - mbps) / mbps < 0.05,
      `${mbps} Mbps measured as ${result.speedMbps}`
    )
  }

  // --- a fast line escalates, and only as far as it needs to ---------------
  const fast = link(200)
  const fastResult = await measureDownstream(fast.download)
  assert.ok(fast.asked.length > 1, 'a 200 Mbps line must escalate past 1 MiB')
  assert.equal(fast.asked[0], MiB, 'it still starts at 1 MiB')
  assert.ok(
    Math.abs(fastResult.speedMbps - 200) / 200 < 0.05,
    `200 Mbps measured as ${fastResult.speedMbps}`
  )

  // --- the ceiling holds ---------------------------------------------------
  const veryFast = link(10_000)
  await measureDownstream(veryFast.download)
  for (const bytes of veryFast.asked) {
    assert.ok(bytes <= 64 * MiB, `no single sample may exceed 64 MiB, saw ${bytes}`)
  }
  assert.ok(veryFast.asked.length <= 3, 'at most one first sample plus two escalations')

  // --- a stalled sample cannot drag the answer below a cleaner one ---------
  // Every sample is a lower bound on the line, so the largest wins.
  let call = 0
  const flaky: SampleDownloader = async (bytes) => {
    call += 1
    if (call === 1) return { timedBytes: bytes, seconds: 0.02, totalBytes: bytes } // fast, too short
    // The escalated sample stalls halfway through on a wifi hiccup.
    return { timedBytes: bytes, seconds: 30, totalBytes: bytes }
  }
  const stalled = await measureDownstream(flaky)
  assert.ok(
    stalled.speedMbps > 100,
    `a stalled second sample must not beat a clean first one, got ${stalled.speedMbps}`
  )

  // --- an unmeasurable sample jumps to the ceiling rather than guessing ----
  const single: { asked: number[]; download: SampleDownloader } = { asked: [], download: null! }
  single.download = async (bytes) => {
    single.asked.push(bytes)
    // Whole body in one chunk: nothing inside the timed window at all.
    if (single.asked.length === 1) return { timedBytes: 0, seconds: 0, totalBytes: bytes }
    return { timedBytes: bytes, seconds: 2, totalBytes: bytes }
  }
  await measureDownstream(single.download)
  assert.equal(
    single.asked[1],
    64 * MiB,
    'an unmeasurable sample escalates straight to the ceiling'
  )

  // --- a connection that never yields a reading is an error, not a zero ----
  await assert.rejects(
    measureDownstream(async (bytes) => ({ timedBytes: 0, seconds: 0, totalBytes: bytes })),
    /could not be measured/
  )

  console.log('ok  speed test escalation')
}

void main()
