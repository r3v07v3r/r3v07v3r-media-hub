// Compact picture controls for the native mpv player.
//
// mpv names these properties directly, but the UI should not need to know that
// detail or accept an arbitrary property name across IPC. Keeping the allowed
// controls here makes the small, intentional set visible in one place.

export const VIDEO_PICTURE_CONTROLS = [
  { control: 'brightness', label: 'Brightness' },
  { control: 'contrast', label: 'Contrast' },
  { control: 'saturation', label: 'Saturation' },
  { control: 'gamma', label: 'Gamma' }
] as const

export type VideoPictureControl = (typeof VIDEO_PICTURE_CONTROLS)[number]['control']

export type VideoPictureSettings = Record<VideoPictureControl, number>

/** mpv exposes each of these as an integer offset in the inclusive -100–100
 * range. Zero is its unadjusted picture. */
export const VIDEO_PICTURE_MIN = -100
export const VIDEO_PICTURE_MAX = 100

export const DEFAULT_VIDEO_PICTURE: VideoPictureSettings = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  gamma: 0
}

export function isVideoPictureControl(value: unknown): value is VideoPictureControl {
  return VIDEO_PICTURE_CONTROLS.some(({ control }) => control === value)
}
