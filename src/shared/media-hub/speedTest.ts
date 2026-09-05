// The connection-speed measurement, kept free of any electron import so the
// escalation policy stays unit-testable — the same split jellyfin.ts and
// trakt.ts already use, and the reason network.ts (which registers IPC, and so
// must import ipcGuard) cannot hold this itself.

/**
 * How the downstream figure is measured, and why it is not one fixed download.
 *
 * This used to fetch a flat 1 MiB and divide by the wall time around the whole
 * `fetch()`. That is fine on a slow link and close to meaningless on a fast
 * one, for two compounding reasons:
 *
 *  - CONNECTION SETUP WAS IN THE DIVISOR. DNS, the TCP handshake and TLS all
 *    landed inside the measured window. On a 12 Mbps line 1 MiB takes ~700ms
 *    and ~200ms of setup is a 22% under-read; on a 200 Mbps line the transfer
 *    is ~40ms and the setup is most of what got measured.
 *  - TCP SLOW-START HAD NOT FINISHED. The congestion window needs several
 *    round trips to open. 1 MiB on a fast line is consumed entirely inside
 *    that ramp, so the number describes the ramp, not the line.
 *
 * So: time from the first byte rather than from the call, and keep sampling
 * until a sample is long enough to mean something. The escalation is
 * SELF-LIMITING, which is the property that makes it safe to leave on by
 * default — a connection slow enough for 1 MiB to take longer than
 * MIN_SAMPLE_SECONDS never escalates at all, so a metered or rural line still
 * downloads exactly the 1 MiB it always did. Only a link fast enough to make
 * the first sample worthless pulls more, and by definition it can afford to.
 * The escalated request reuses the same keep-alive connection, so the second
 * sample starts with the window already open rather than paying the ramp
 * twice.
 */

/** The first sample, and on a slow line the only one. */
export const FIRST_SAMPLE_BYTES = 1024 * 1024

/**
 * Under this, a sample is treated as a measurement of TCP slow-start rather
 * than of the connection, and is escalated instead of believed.
 *
 * Set from how long slow-start actually lasts, not from a target speed. The
 * congestion window doubles each round trip, so at a typical 20-50ms RTT half
 * a second is 10-25 round trips — comfortably past the ramp for any line up to
 * roughly 100 Mbps. Faster than that and the 1 MiB is gone in well under half
 * a second anyway, which is exactly the case this escalates.
 *
 * The consequence worth stating plainly: the boundary lands near 16 Mbps
 * (1 MiB of timed transfer in 0.5s). A rural or metered link — the 12 Mbps
 * wireless this was calibrated against — therefore takes ONE 1 MiB sample and
 * stops, which is both accurate at that speed and the whole point of keeping
 * the escalation self-limiting.
 */
export const MIN_SAMPLE_SECONDS = 0.5

/** What an escalated sample aims to spend on the wire — long enough to be
 *  clear of slow-start and to average over wifi jitter. */
const TARGET_SAMPLE_SECONDS = 2.5

/** Ceiling on any single sample, so a very fast line cannot turn a settings
 *  button into a hundreds-of-megabytes download. A sample this size is
 *  already past slow-start on any connection that could finish it quickly. */
export const MAX_SAMPLE_BYTES = 64 * 1024 * 1024

/** Two rounds is enough to go 1 MiB -> a real sample even from a bad first
 *  estimate, without turning a stalled link into a long sequence of retries. */
const MAX_ESCALATIONS = 2

export const OVERALL_BUDGET_MS = 20000

export interface Sample {
  /** Bytes that arrived strictly AFTER the first chunk — the ones whose
   *  transfer time is actually inside the timed window. */
  timedBytes: number
  /** Seconds from first byte to last byte. */
  seconds: number
  /** Everything the request pulled, for reporting what the test cost. */
  totalBytes: number
}

export type SampleDownloader = (bytes: number) => Promise<Sample>

export async function downloadSample(bytes: number, signal: AbortSignal): Promise<Sample> {
  const response = await fetch(`https://speed.cloudflare.com/__down?bytes=${bytes}`, {
    cache: 'no-store',
    signal
  })
  if (!response.ok) throw new Error(`Speed test failed (${response.status}).`)

  const reader = response.body?.getReader()
  if (!reader) {
    // No readable stream to time against. Fall back to the whole-response
    // timing this function replaced rather than failing the test outright.
    const started = performance.now()
    const total = (await response.arrayBuffer()).byteLength
    return {
      timedBytes: total,
      seconds: Math.max((performance.now() - started) / 1000, 0.001),
      totalBytes: total
    }
  }

  let totalBytes = 0
  let timedBytes = 0
  let firstByteAt = 0
  let lastByteAt = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value?.byteLength) continue
    totalBytes += value.byteLength
    const now = performance.now()
    if (!firstByteAt) {
      // The first chunk's arrival is when setup finished, so it starts the
      // clock and its own bytes are deliberately not counted — they were in
      // flight before the window opened.
      firstByteAt = now
      continue
    }
    timedBytes += value.byteLength
    lastByteAt = now
  }

  // A body delivered in a single chunk leaves nothing inside the window.
  const seconds = firstByteAt && lastByteAt ? (lastByteAt - firstByteAt) / 1000 : 0
  return { timedBytes, seconds, totalBytes }
}

function sampleMbps(sample: Sample): number {
  if (sample.seconds <= 0 || sample.timedBytes <= 0) return 0
  return (sample.timedBytes * 8) / sample.seconds / 1_000_000
}

/** The escalation loop, with the download injected so the policy can be
 *  tested without a network — see tests/speedTest.test.ts. */
export async function measureDownstream(
  download: SampleDownloader
): Promise<{ speedMbps: number; totalBytes: number }> {
  let request = FIRST_SAMPLE_BYTES
  let totalBytes = 0
  let best = 0

  for (let round = 0; round <= MAX_ESCALATIONS; round++) {
    const sample = await download(request)
    totalBytes += sample.totalBytes
    const mbps = sampleMbps(sample)
    // Every sample is a LOWER bound on the line — nothing here can make a
    // connection look faster than it is, so the largest reading wins rather
    // than the last one. That also means a sample ruined by a momentary stall
    // cannot drag the final answer down below an earlier, cleaner one.
    if (mbps > best) best = mbps

    const longEnough = sample.seconds >= MIN_SAMPLE_SECONDS
    const atCeiling = request >= MAX_SAMPLE_BYTES
    if (longEnough || atCeiling || round === MAX_ESCALATIONS) break

    // Size the next sample from what was just observed. An unmeasurable
    // sample (everything in one chunk) has no rate to extrapolate from, so it
    // jumps straight to the ceiling instead of guessing.
    const next = mbps > 0 ? (mbps * 1_000_000 * TARGET_SAMPLE_SECONDS) / 8 : MAX_SAMPLE_BYTES
    request = Math.min(MAX_SAMPLE_BYTES, Math.max(request * 2, Math.round(next)))
  }

  if (best <= 0) throw new Error('The connection could not be measured.')
  return { speedMbps: Math.round(best * 10) / 10, totalBytes }
}
