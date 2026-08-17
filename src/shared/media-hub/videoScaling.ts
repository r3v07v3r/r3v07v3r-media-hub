// GPU scaling quality for the embedded player.
//
// This replaces the old "upscale" feature, which was a different thing wearing
// the same name: it re-encoded video through a hardware H.264 encoder to a
// larger frame size, needed a working encoder on the machine, restarted the
// stream to apply, and capped out at what a real-time encode could keep up
// with. mpv scales on the GPU during playback, so there is nothing to encode,
// nothing to restart, and no resolution ceiling — only a choice of how good the
// scaling filter is.
//
// Deliberately three plain choices rather than mpv's ~40 scaler names. The
// difference between neighbouring high-end filters is invisible in motion; the
// difference between "cheap" and "good" is not.

export type VideoScalingPreset = 'auto' | 'high' | 'sharp'

export function normalizeVideoScaling(value: unknown): VideoScalingPreset {
  return value === 'high' || value === 'sharp' ? value : 'auto'
}

/**
 * mpv scaler properties per preset. All are runtime-settable, so a change
 * applies to the next title without restarting anything.
 *
 * `scale` is upscaling, `dscale` downscaling, `cscale` chroma. Pairing them
 * matters: a sharp luma filter with a soft chroma filter is what actually looks
 * clean, whereas sharpening chroma mostly amplifies compression artefacts.
 */
export function scalerPropertiesFor(preset: VideoScalingPreset): Record<string, string> {
  switch (preset) {
    case 'high':
      // mpv's own high-quality defaults. Costs a little GPU, no visible
      // artefacts, safe on any hardware that can already decode the file.
      return { scale: 'spline36', dscale: 'mitchell', cscale: 'spline36' }
    case 'sharp':
      // Noticeably crisper on upscaled sub-1080p content, which is where the
      // old feature was aimed. ewa_lanczossharp can ring slightly on very noisy
      // sources, which is why it is not the default.
      return { scale: 'ewa_lanczossharp', dscale: 'mitchell', cscale: 'ewa_lanczossoft' }
    default:
      // mpv's stock scalers.
      return { scale: 'lanczos', dscale: 'mitchell', cscale: 'lanczos' }
  }
}
