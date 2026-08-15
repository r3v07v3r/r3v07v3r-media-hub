// New (not a port): the one place main narrates what it's doing while a
// title is being prepared, so the renderer's preparation card can say
// something more useful than "Preparing the stream" for the whole minute-
// plus that step can take on a big source (see PlaybackPrepareProgress).
//
// Its own tiny module rather than a helper inside playbackSession.ts
// because streamCache.ts reports from here too, and streamCache is
// deliberately below playbackSession in the import graph — routing these
// through playbackSession would create a cycle for a one-line send.

import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import type { PlaybackPrepareProgress } from '../../shared/media-hub/types'
import { sendToRenderer } from './rendererBridge'

/**
 * Fire-and-forget — sendToRenderer already no-ops when there's no live
 * window, and a progress line is never worth failing a playback start
 * over. Also fires during the ffmpeg restarts that a seek/track change
 * triggers mid-playback; the renderer simply ignores anything that arrives
 * while no preparation is in flight (see AppStateContext's subscriber).
 */
export function reportPreparation(
  step: PlaybackPrepareProgress['step'],
  message: string
): void {
  sendToRenderer(MEDIA_HUB_CHANNELS.playbackPrepareProgress, { step, message })
}

/** Whole MB below 10, one decimal above — "0.4 MB" / "12 MB" both read
 *  naturally in a progress line, "0.43 MB"/"12.4 MB" don't. */
export function formatMegabytes(bytes: number): string {
  const mb = Math.max(0, bytes) / (1024 * 1024)
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`
}
