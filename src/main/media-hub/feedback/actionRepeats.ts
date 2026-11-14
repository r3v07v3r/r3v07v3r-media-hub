// The main process's half of repeated-action detection: the same request
// for the same thing, again and again — Play on one episode, a subtitle
// search, a sync. The renderer watches clicks; this watches what those
// clicks asked for, which catches the retry however it was made.
//
// Only channels that are deliberate actions are listed. Reads and polls
// repeat all the time and mean nothing.

import crypto from 'node:crypto'
import { MEDIA_HUB_CHANNELS, type MediaHubChannel } from '../../../shared/media-hub/ipc-channels'
import { RepeatDetector } from '../../../shared/feedback/repeatDetector'
import { reportProblem } from './reporter'

const WATCHED: Partial<Record<MediaHubChannel, string>> = {
  [MEDIA_HUB_CHANNELS.playStream]: 'Play',
  [MEDIA_HUB_CHANNELS.streamRejectCurrent]: 'Wrong copy',
  [MEDIA_HUB_CHANNELS.subtitlesSearch]: 'Subtitle search',
  [MEDIA_HUB_CHANNELS.trackingPlannedSync]: 'Sync watchlists now'
}

// Wider than the renderer's: a play that fails takes a while to fail.
const detector = new RepeatDetector({ windowMs: 3 * 60_000 })

/** Notes one call; reports a run of identical ones. Never throws. */
export function noteAction(channel: MediaHubChannel, payload: unknown): void {
  const label = WATCHED[channel]
  if (!label) return
  try {
    // The payload is hashed, never sent: it says "the same thing", not what.
    const same = crypto
      .createHash('sha256')
      .update(JSON.stringify(payload ?? null))
      .digest('hex')
      .slice(0, 12)
    const finding = detector.note(`${channel}|${same}`, Date.now())
    if (!finding) return
    reportProblem({
      kind: 'friction',
      title: `${label} asked for ${finding.count} times for the same thing`,
      fingerprint: `friction:${channel}`,
      context: {
        action: label,
        pattern: finding.pattern,
        count: finding.count,
        seconds: Math.round(finding.spanMs / 1000)
      },
      withLog: true
    })
  } catch {
    // Detection is a nicety.
  }
}
