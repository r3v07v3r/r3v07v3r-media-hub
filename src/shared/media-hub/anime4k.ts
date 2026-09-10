// Anime4K: GLSL restoration/upscaling shaders for anime, run by mpv on the GPU.
//
// Why this exists next to videoScaling.ts rather than inside it: the scaler
// presets there pick which of mpv's built-in resampling filters to use, which
// helps any content a little. Anime4K is a different kind of thing — a set of
// small neural-network shaders trained on line art, which restore lines and
// remove ringing before upscaling. It makes a visible difference on anime and
// is wrong for everything else, which is why it is a separate switch and why
// the player shows a live on/off toggle for it rather than a global default.
//
// The shaders are NOT bundled with the app. They are fetched on demand from
// the pinned upstream release (see main/media-hub/anime4kInstall.ts) when the
// person asks for them, and only the files the modes below reference are kept.
//
// Chains are upstream's "high-end GPU" recommendations from
// GLSL_Instructions_Advanced.md, verbatim and in order. The order matters:
// Clamp_Highlights must run first, and the AutoDownscalePre passes sit between
// the two upscales so a source already close to the screen size is not
// upscaled past it and then shrunk back.

export const ANIME4K_MODES = ['A', 'B', 'C', 'A+A', 'B+B', 'C+A'] as const
export type Anime4kMode = (typeof ANIME4K_MODES)[number]

export const DEFAULT_ANIME4K_MODE: Anime4kMode = 'A'

export function isAnime4kMode(value: unknown): value is Anime4kMode {
  return (ANIME4K_MODES as readonly unknown[]).includes(value)
}

/** Anything unrecognised is Mode A — the general-purpose one upstream
 *  recommends first, and the one a fresh install starts on. */
export function normalizeAnime4kMode(value: unknown): Anime4kMode {
  return isAnime4kMode(value) ? value : DEFAULT_ANIME4K_MODE
}

const CLAMP = 'Anime4K_Clamp_Highlights.glsl'
const RESTORE_VL = 'Anime4K_Restore_CNN_VL.glsl'
const RESTORE_M = 'Anime4K_Restore_CNN_M.glsl'
const RESTORE_SOFT_VL = 'Anime4K_Restore_CNN_Soft_VL.glsl'
const RESTORE_SOFT_M = 'Anime4K_Restore_CNN_Soft_M.glsl'
const UPSCALE_VL = 'Anime4K_Upscale_CNN_x2_VL.glsl'
const UPSCALE_M = 'Anime4K_Upscale_CNN_x2_M.glsl'
const UPSCALE_DENOISE_VL = 'Anime4K_Upscale_Denoise_CNN_x2_VL.glsl'
const DOWNSCALE_X2 = 'Anime4K_AutoDownscalePre_x2.glsl'
const DOWNSCALE_X4 = 'Anime4K_AutoDownscalePre_x4.glsl'

const CHAINS: Record<Anime4kMode, readonly string[]> = {
  A: [CLAMP, RESTORE_VL, UPSCALE_VL, DOWNSCALE_X2, DOWNSCALE_X4, UPSCALE_M],
  B: [CLAMP, RESTORE_SOFT_VL, UPSCALE_VL, DOWNSCALE_X2, DOWNSCALE_X4, UPSCALE_M],
  C: [CLAMP, UPSCALE_DENOISE_VL, DOWNSCALE_X2, DOWNSCALE_X4, UPSCALE_M],
  'A+A': [CLAMP, RESTORE_VL, UPSCALE_VL, RESTORE_M, DOWNSCALE_X2, DOWNSCALE_X4, UPSCALE_M],
  'B+B': [
    CLAMP,
    RESTORE_SOFT_VL,
    UPSCALE_VL,
    DOWNSCALE_X2,
    DOWNSCALE_X4,
    RESTORE_SOFT_M,
    UPSCALE_M
  ],
  'C+A': [CLAMP, UPSCALE_DENOISE_VL, DOWNSCALE_X2, DOWNSCALE_X4, RESTORE_M, UPSCALE_M]
}

/** Shader file names, in the order mpv must run them. */
export function anime4kShaderChain(mode: Anime4kMode): string[] {
  return [...CHAINS[mode]]
}

/** Every file any mode needs — the only ones the installer keeps. */
export const ANIME4K_REQUIRED_FILES: readonly string[] = Array.from(
  new Set(ANIME4K_MODES.flatMap((mode) => CHAINS[mode]))
)

export function anime4kModeLabel(mode: Anime4kMode): string {
  return `Mode ${mode}`
}

/** One line each, written for the person choosing — what it looks like,
 *  not what the network does. */
export function anime4kModeDescription(mode: Anime4kMode): string {
  switch (mode) {
    case 'A':
      return 'Restores lines and upscales. The right pick for most shows.'
    case 'B':
      return 'Softer restore. For sources that already ring or look over-sharpened.'
    case 'C':
      return 'Denoise and upscale, no line restore. For clean, high-bitrate sources.'
    case 'A+A':
      return 'Mode A with a second restore pass. Heaviest, cleanest lines.'
    case 'B+B':
      return 'Mode B with a second soft pass. Heavy, for very rough sources.'
    case 'C+A':
      return 'Denoise first, then restore. For noisy sources with soft lines.'
  }
}

/** What the installer reports while it works. Pushed to the renderer on
 *  `anime4kStatus` and returned from the status query, so the Settings
 *  pane sees one shape either way. */
export interface Anime4kStatus {
  state: 'not-installed' | 'installing' | 'installed' | 'error'
  message?: string
}

/** The persisted preference plus whether the files are actually on disk —
 *  the two together decide whether the player offers the toggle. */
export interface Anime4kSettings {
  installed: boolean
  enabled: boolean
  mode: Anime4kMode
}

/** What the player pushes to the overlay. `available` is installed AND
 *  enabled: the overlay shows the toggle only when there is something to
 *  toggle. `active` is the live switch, which survives title changes but
 *  not a restart. */
export interface Anime4kPlayerState {
  available: boolean
  active: boolean
  mode: Anime4kMode
}
