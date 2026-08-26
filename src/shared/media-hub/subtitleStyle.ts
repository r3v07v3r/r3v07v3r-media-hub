// How subtitles look, as four things people actually change.
//
// mpv exposes dozens of subtitle properties. Almost all of them are for
// getting a specific look out of a specific ASS track; the reasons people
// reach for a subtitle menu in a media player are narrower than that — the
// text is too small, it sits over the picture, it is hard to read against a
// bright scene, or a white-on-white subtitle has become invisible. These four
// cover all of it and nothing else.
//
// Deliberately NOT a colour picker. A picker in a video overlay is a fiddly
// control for a decision nobody wants to make precisely, and the useful
// answers are a short list: the default white, a yellow that reads over pale
// scenes, and a cyan that is easy to pick out without being harsh.

export interface SubtitleStyle {
  /** Multiplier on mpv's own default size. 1 is untouched. */
  scale: number
  /** mpv's `sub-pos`: 100 is the bottom of the frame, lower moves it up. */
  position: number
  /** Whether to draw a translucent box behind the text. */
  background: boolean
  color: SubtitleColor
}

export type SubtitleColor = 'white' | 'yellow' | 'cyan'

export const SUBTITLE_COLORS: readonly { value: SubtitleColor; label: string; hex: string }[] = [
  { value: 'white', label: 'White', hex: '#FFFFFF' },
  { value: 'yellow', label: 'Yellow', hex: '#F4CB45' },
  { value: 'cyan', label: 'Cyan', hex: '#38E5FF' }
]

export const SUBTITLE_SCALE_MIN = 0.5
export const SUBTITLE_SCALE_MAX = 2
export const SUBTITLE_SCALE_STEP = 0.1

/** mpv's own range. Below ~50 the text is in the middle of the picture, which
 *  is a legitimate choice for a badly cropped source and a strange default. */
export const SUBTITLE_POSITION_MIN = 50
export const SUBTITLE_POSITION_MAX = 100

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  scale: 1,
  position: 100,
  background: false,
  color: 'white'
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * Reads an arbitrary stored or received value into a usable style.
 *
 * Every field falls back to the default independently, so a settings file
 * written by an older build — or a malformed one from the IPC boundary —
 * produces a style rather than an error or a half-applied mess.
 */
export function normalizeSubtitleStyle(value: unknown): SubtitleStyle {
  const input = (value ?? {}) as Partial<SubtitleStyle>
  const color = SUBTITLE_COLORS.some((option) => option.value === input.color)
    ? (input.color as SubtitleColor)
    : DEFAULT_SUBTITLE_STYLE.color
  return {
    scale: clamp(
      Number(input.scale ?? DEFAULT_SUBTITLE_STYLE.scale),
      SUBTITLE_SCALE_MIN,
      SUBTITLE_SCALE_MAX
    ),
    position: Math.round(
      clamp(
        Number(input.position ?? DEFAULT_SUBTITLE_STYLE.position),
        SUBTITLE_POSITION_MIN,
        SUBTITLE_POSITION_MAX
      )
    ),
    background: input.background === true,
    color
  }
}

/** True when the style differs from mpv's untouched rendering — drives the
 *  "modified" dot on the menu button and whether Reset does anything. */
export function isSubtitleStyleDefault(style: SubtitleStyle): boolean {
  return (
    style.scale === DEFAULT_SUBTITLE_STYLE.scale &&
    style.position === DEFAULT_SUBTITLE_STYLE.position &&
    style.background === DEFAULT_SUBTITLE_STYLE.background &&
    style.color === DEFAULT_SUBTITLE_STYLE.color
  )
}

/** The mpv properties one style maps to. Kept here rather than in the bridge
 *  so the mapping is beside the meaning of each field. */
export function subtitleStyleProperties(style: SubtitleStyle): Record<string, string | number> {
  const hex = SUBTITLE_COLORS.find((option) => option.value === style.color)?.hex ?? '#FFFFFF'
  return {
    'sub-scale': style.scale,
    'sub-pos': style.position,
    'sub-color': hex,
    // mpv takes #AARRGGBB here. Fully transparent is how "no box" is
    // expressed — there is no separate switch for it.
    'sub-back-color': style.background ? '#80000000' : '#00000000'
  }
}
