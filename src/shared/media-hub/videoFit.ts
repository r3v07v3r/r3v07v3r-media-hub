// How the picture is fitted into the player window.
//
// The old <video>-based player got this for free from CSS `object-fit`. There
// is no CSS box around mpv's native surface, so the same three choices have to
// be expressed as mpv properties instead — which is what this module owns, so
// that the mapping lives in one place with a test rather than inline in an IPC
// switch.
//
// The mode names are the CSS ones because the IPC contract already spoke them
// (see PlayerCommand's set-fit-mode); the LABELS are what people actually call
// these, and are the words the player UI shows.

export type VideoFitMode = 'contain' | 'cover' | 'fill'

/** Cycle/menu order: whole picture, then no bars, then the distorting one last
 *  — worst-looking option furthest from an accidental click. */
export const VIDEO_FIT_MODES: readonly VideoFitMode[] = ['contain', 'cover', 'fill']

export const DEFAULT_VIDEO_FIT: VideoFitMode = 'contain'

export function normalizeVideoFit(value: unknown): VideoFitMode {
  return value === 'cover' || value === 'fill' ? value : DEFAULT_VIDEO_FIT
}

/** Menu labels. "Stretch" rather than "Fill" for `fill`, because `cover` is the
 *  one people mean by "fill the screen" — it fills it without distorting. */
export function videoFitLabel(mode: VideoFitMode): string {
  switch (mode) {
    case 'cover':
      return 'Fill'
    case 'fill':
      return 'Stretch'
    default:
      return 'Fit'
  }
}

export function videoFitDescription(mode: VideoFitMode): string {
  switch (mode) {
    case 'cover':
      return 'Crop to fill the screen'
    case 'fill':
      return 'Stretch to fill, ignoring aspect'
    default:
      return 'Whole picture, with bars'
  }
}

/**
 * mpv properties per mode. Both are runtime-settable, so switching applies to
 * the frame being displayed — nothing reloads and nothing reseeks.
 *
 * `keepaspect` false is the only one that distorts; `panscan` is a 0-1 zoom
 * that crops the overflowing axis, so 1 is exactly "cover". mpv ignores
 * panscan while keepaspect is off, but it is still written back to 0 so the
 * two properties never disagree with the mode this module claims is active.
 */
export function mpvPropertiesForFit(mode: VideoFitMode): {
  keepaspect: boolean
  panscan: number
} {
  switch (mode) {
    case 'cover':
      return { keepaspect: true, panscan: 1 }
    case 'fill':
      return { keepaspect: false, panscan: 0 }
    default:
      return { keepaspect: true, panscan: 0 }
  }
}
