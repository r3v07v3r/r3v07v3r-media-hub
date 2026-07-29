// How long to let a stream buffer ahead before playback starts — the fix
// for "let it buffer for a while on a bad connection instead of stuttering
// immediately." Shared between main (vlc.ts's compatibility-mode transcoder
// head start) and renderer (PlaybackOverlay's client-side buffered-ahead
// gate, which applies to BOTH playback modes) so the same preset always
// means the same number of seconds in both places.

export type PlaybackBufferPreset = 'auto' | 'extra' | 'maximum'

export const PLAYBACK_BUFFER_SECONDS: Record<PlaybackBufferPreset, number> = {
  auto: 3,
  extra: 8,
  maximum: 15
}

export function normalizePlaybackBuffer(value: unknown): PlaybackBufferPreset {
  return value === 'extra' || value === 'maximum' ? value : 'auto'
}

export function getPlaybackBufferSeconds(value: unknown): number {
  return PLAYBACK_BUFFER_SECONDS[normalizePlaybackBuffer(value)]
}
