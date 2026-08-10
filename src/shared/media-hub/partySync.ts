// Follower-side clock for "where should I be right now?" in a watch party.
//
// The host broadcasts its absolute media position periodically. That value
// is ALREADY STALE when it lands: it describes where the host was one full
// hop ago (renderer -> IPC -> main -> encrypt -> websocket -> relay ->
// back down the same chain). Comparing it directly against the follower's
// CURRENT position — which is what the naive version did — bakes that hop
// in as a systematic backward bias on every correction, and leaves the
// follower completely uncorrected in between broadcasts.
//
// The fix is to treat each broadcast as a (position, time) FIX and
// extrapolate forward from it, so the follower always has an estimate of
// where the host is *now* rather than where it was.
//
// Note which clock that uses. The obvious design is for the host to send
// its own wall clock alongside the position, and for the follower to
// compute `hostMedia + (myClock - hostClock)`. That inherits the entire
// difference between two machines' clocks as a constant sync error, and
// unsynchronised consumer clocks routinely differ by seconds. Stamping
// ARRIVAL on the follower's own clock avoids the problem completely:
// both terms below come from the same monotonic clock on the same
// machine, so no cross-machine comparison ever happens. The only residual
// error is the one-way network delay, which is constant, tens of
// milliseconds, and imperceptible — and, unlike clock skew, it does not
// accumulate.

/** A host position broadcast, stamped with the LOCAL clock on arrival. */
export interface HostPositionSample {
  /** Absolute media position (seconds) the host reported. */
  mediaTime: number
  /** Local monotonic timestamp (performance.now()) when this arrived. */
  arrivedAt: number
  /** Whether the host was paused when it sent this. */
  paused: boolean
}

/** Beyond this, the last fix is too old to extrapolate from — the host may
 *  have died, paused without us hearing, or dropped off the network.
 *  Coasting on a stale fix would confidently correct toward a position
 *  nobody is at. */
export const SAMPLE_MAX_AGE_MS = 30_000

/** Errors below this are left alone. Tight enough that nobody perceives a
 *  gap, wide enough that ordinary timing jitter doesn't cause constant
 *  micro-adjustment. */
export const DEAD_ZONE_SECONDS = 0.15

/** Maximum speed differential used to close a gap. 8% is inaudible —
 *  Chromium preserves pitch across a playbackRate change — while still
 *  closing a one-second gap in about twelve seconds. */
export const MAX_RATE_DELTA = 0.08

/** Proportional gain: rate = 1 - error x GAIN, clamped. Chosen so a
 *  half-second error produces roughly a 4% correction and anything past
 *  one second saturates at MAX_RATE_DELTA. */
export const RATE_GAIN = 0.08

/** Past this, nudging the speed would take too long and a hard seek is
 *  the lesser evil. Compatibility mode's threshold is much wider on
 *  purpose: a seek there restarts the ffmpeg transcode from scratch, so
 *  it must be reserved for a genuine desync rather than spent on the
 *  couple of seconds of keyframe-snap difference that is expected when
 *  every member is streaming their own independently-resolved file. */
export const HARD_SEEK_SECONDS = { direct: 2, compatibility: 6 }

export type SyncCorrection =
  { action: 'none' } | { action: 'rate'; rate: number } | { action: 'seek'; position: number }

/** Where the host is right now, extrapolated from its last known fix.
 *  A paused host doesn't advance, so its reported position stands. */
export function expectedHostPosition(sample: HostPositionSample, now: number): number {
  if (!Number.isFinite(sample.mediaTime)) return 0
  if (!Number.isFinite(now) || !Number.isFinite(sample.arrivedAt)) return sample.mediaTime
  if (sample.paused) return sample.mediaTime
  // Guard against a non-monotonic or rewound clock producing a negative
  // elapsed time, which would predict the host moving backwards.
  const elapsedSeconds = Math.max(0, now - sample.arrivedAt) / 1000
  return sample.mediaTime + elapsedSeconds
}

/** True when a fix is recent enough to steer by. */
export function isSampleUsable(sample: HostPositionSample | null, now: number): boolean {
  if (
    !sample ||
    !Number.isFinite(now) ||
    !Number.isFinite(sample.arrivedAt) ||
    !Number.isFinite(sample.mediaTime)
  )
    return false
  const age = now - sample.arrivedAt
  // A negative age means the monotonic clock was reset (for example after
  // a renderer suspension/reload). Treat that sample as stale rather than
  // trusting it indefinitely until the new clock catches up.
  return age >= 0 && age <= SAMPLE_MAX_AGE_MS
}

/**
 * Decides what to do about the gap between where this member is and where
 * the host should be.
 *
 * `localPosition` and `expected` are both absolute media positions.
 * A POSITIVE error means this member is ahead and should slow down.
 *
 * Continuous and proportional, rather than the previous fixed 10%-for-4s
 * burst: a burst either overshoots a small gap or barely dents a large
 * one, and it can only ever run when a broadcast happens to arrive. This
 * converges smoothly and can be evaluated as often as we like, because
 * `expected` is extrapolated rather than waited for.
 */
export function syncCorrection(
  localPosition: number,
  expected: number,
  compatibility: boolean
): SyncCorrection {
  // Never let corrupt/partial wire data turn into playbackRate=NaN or a
  // seek to an invalid time. The next valid heartbeat will recover without
  // disturbing responsive local playback in the meantime.
  if (!Number.isFinite(localPosition) || !Number.isFinite(expected)) return { action: 'none' }
  const error = localPosition - expected
  const hardLimit = compatibility ? HARD_SEEK_SECONDS.compatibility : HARD_SEEK_SECONDS.direct
  if (Math.abs(error) > hardLimit) return { action: 'seek', position: expected }
  if (Math.abs(error) <= DEAD_ZONE_SECONDS) return { action: 'none' }
  const delta = Math.max(-MAX_RATE_DELTA, Math.min(MAX_RATE_DELTA, -error * RATE_GAIN))
  return { action: 'rate', rate: 1 + delta }
}
