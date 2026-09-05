// What resolution a candidate actually is, and whether that is far enough
// below what the person allowed to be worth telling them about.
//
// Shared rather than living in main/media-hub/core.ts (which imports nothing
// from electron but is a main-process module by convention) because BOTH
// sides need the same answer from the same code: main ranks and gates on it,
// and the renderer decides whether to warn before playing. Two
// implementations of "is this 1080p" would eventually disagree, and the way
// they would disagree is that the warning fires on a title that played fine.

import type { StreamCandidate } from './types'

export function streamText(stream: StreamCandidate): string {
  return `${stream.name || ''} ${stream.title || ''} ${stream.description || ''}`.toLowerCase()
}

/**
 * The one line that actually NAMES the release — the torrent or file name
 * — as opposed to everything the add-on said about it.
 *
 * The add-ons disagree on where it lives: Torrentio puts it as `title`'s
 * first line (`name` is "Torrentio\n1080p"), Comet leaves `title` unset and
 * puts it in `description` (`name` is "[TORRENT] Comet 2160p"), a media
 * server or a cache candidate has only `name`. Anything that reads a fact
 * off the release name — its group, what the Info panel shows — must go
 * through here, and through the SAME function on both sides of a
 * comparison: streamText above starts with the add-on's own label, which
 * is how a "[TORRENT] Comet" candidate once parsed as release group
 * "torrent".
 */
export function streamReleaseName(stream: StreamCandidate): string {
  const text = stream.title || (stream.description as string | undefined) || stream.name || ''
  return String(text).split('\n')[0].trim()
}

/**
 * The resolution a release advertises.
 *
 * Read from the release text first because that is where the scrapers put it
 * — `StreamCandidate.resolution` is mostly unset on torrent candidates, and
 * an unset value passes a quality check unconditionally. The numeric field is
 * the fallback for media-server and cache candidates, which set it properly.
 *
 * 0 means "could not tell", which every caller must treat as unknown rather
 * than as bad: refusing, or warning about, a copy whose metadata is merely
 * thin would be worse than playing it.
 */
export function streamResolution(stream: StreamCandidate): number {
  const text = streamText(stream)
  if (/2160|4k/.test(text)) return 2160
  if (/1080/.test(text)) return 1080
  if (/720/.test(text)) return 720
  return stream.resolution || 0
}

/** The quality steps the app reasons in, ascending — the same ladder the
 *  Settings dropdown offers. */
export const RESOLUTION_STEPS = [480, 720, 1080, 1440, 2160] as const

export function resolutionLabel(resolution: number): string {
  return resolution >= 2160 ? '4K' : `${resolution}p`
}

/**
 * Whether what we got is far enough below what was allowed to be worth
 * interrupting somebody over.
 *
 * TWO STEPS, not any shortfall. One step down is the ordinary case and does
 * not deserve a dialog — capped at 4K and handed 1440p, or at 1080p and
 * handed 720p, is what a ceiling is for. Two steps is where somebody would be
 * surprised: 480p when they allowed 1080p, or 720p when they allowed 4K.
 * Warning on every small gap would train people to dismiss the question
 * without reading it, which is worse than not asking at all.
 *
 * Returns false whenever there is nothing meaningful to say: no ceiling set
 * ("Any" — the person expressed no preference to fall short of), an unknown
 * resolution, or a copy that met the ceiling.
 */
export function isNoticeablyBelowCeiling(resolution: number, ceiling: number): boolean {
  if (!ceiling || !resolution) return false
  if (resolution >= ceiling) return false
  const ceilingIndex = RESOLUTION_STEPS.findIndex((step) => step >= ceiling)
  const gotIndex = RESOLUTION_STEPS.findIndex((step) => step >= resolution)
  if (ceilingIndex < 0 || gotIndex < 0) return false
  return ceilingIndex - gotIndex >= 2
}
