// Ported from r3v07v3r-media-hub's src/preferences.cjs. Validation logic
// (theme id allowlist, update-channel normalization, and which fields are
// exposed to the renderer vs. cleared on logout) is preserved exactly from
// the original — this is a security/privacy boundary (logoutSettings in
// particular controls what survives an account logout), not a place for
// "improvements".

import type { MediaHubPublicSettings, Theme, UpdateChannel } from '../../shared/media-hub/types'
import { normalizePlaybackBuffer } from '../../shared/media-hub/playbackBuffer'
import { normalizeVideoScaling } from '../../shared/media-hub/videoScaling'

export const THEMES: Theme[] = [
  { id: 'neon', name: 'Neon Noir', description: 'Signature magenta command center' },
  { id: 'midnight', name: 'Midnight Gold', description: 'Deep black with warm gold highlights' },
  { id: 'ocean', name: 'Abyssal Ocean', description: 'Navy glass with electric cyan' },
  { id: 'ember', name: 'Ember Protocol', description: 'Carbon black with molten orange' },
  { id: 'terminal', name: 'Ghost Terminal', description: 'Tactical graphite and phosphor green' }
]

const THEME_IDS = new Set(THEMES.map((theme) => theme.id))

/** Falls back to the default 'neon' theme for any unrecognized/untrusted value. */
export function normalizeTheme(value: unknown): string {
  return THEME_IDS.has(value as string) ? (value as string) : 'neon'
}

/** Only 'preview' is ever passed through; every other value (including missing/invalid) becomes 'stable'. */
export function normalizeUpdateChannel(value: unknown): UpdateChannel {
  return value === 'preview' ? 'preview' : 'stable'
}

/**
 * Projects the raw persisted settings object down to the fields safe to
 * expose to the renderer. `settings` is the raw settings-store record
 * (shape defined by settingsStore.ts), loosely typed here since untrusted/
 * partial data must be tolerated exactly as the original did with `{}`.
 */
export function publicSettings(settings: Record<string, unknown> = {}): MediaHubPublicSettings {
  return {
    theme: normalizeTheme(settings.theme),
    simklClientId: String(settings.simklClientId || ''),
    subtitleLanguage: String(settings.subtitleLanguage || 'en'),
    audioLanguage: String(settings.audioLanguage || 'en'),
    partySyncUrl: String(settings.partySyncUrl || ''),
    partyDisplayName: String(settings.partyDisplayName || ''),
    updateChannel: normalizeUpdateChannel(settings.updateChannel),
    playbackBuffer: normalizePlaybackBuffer(settings.playbackBuffer),
    videoScaling: normalizeVideoScaling(settings.videoScaling),
    autoSubtitlesEnabled: settings.autoSubtitlesEnabled !== false,
    uiAnimationsEnabled: settings.uiAnimationsEnabled !== false,
    performancePanelVisible: settings.performancePanelVisible !== false,
    maxStreamResolution: Number(settings.maxStreamResolution) || 0,
    maxStreamSizeGb: Number(settings.maxStreamSizeGb) || 0,
    // Deliberately NOT `Number(x) || 0`: that coerces "never configured"
    // (undefined) to the same 0 as "explicitly set to unbounded", and the
    // renderer displays 0 as "Unlimited" — a real, confirmed bug where an
    // unconfigured install showed "Unlimited" while the backend was
    // actually enforcing its true 10GB default (resolveStreamCacheMaxBytes
    // in playbackSession.ts, which reads the same raw settings directly
    // and treats undefined/0 as genuinely different cases). Preserving
    // undefined here lets the renderer's own `?? 10` fallback show the
    // real default instead of a wrong one.
    streamCacheMaxGb:
      typeof settings.streamCacheMaxGb === 'number' && Number.isFinite(settings.streamCacheMaxGb)
        ? settings.streamCacheMaxGb
        : undefined,
    streamCacheDir:
      typeof settings.streamCacheDir === 'string' ? settings.streamCacheDir : undefined,
    connectionSpeedMbps:
      Number(settings.connectionSpeedMbps) > 0 ? Number(settings.connectionSpeedMbps) : undefined,
    hideWatchedDefault: settings.hideWatchedDefault === true,
    hideCompletedDefault: settings.hideCompletedDefault === true,
    hideDislikedDefault: settings.hideDislikedDefault === true
  }
}

/**
 * Narrower projection used on logout — only theme, update channel, and
 * playback buffering survive; every account/service-identifying field is
 * intentionally dropped. Playback buffering (and the UI-animations/video-
 * transcode toggles alongside it) is a device/connection preference, not
 * account data, so it belongs here too.
 */
export function logoutSettings(
  settings: Record<string, unknown> = {}
): Pick<
  MediaHubPublicSettings,
  | 'theme'
  | 'updateChannel'
  | 'playbackBuffer'
  | 'videoScaling'
  | 'autoSubtitlesEnabled'
  | 'uiAnimationsEnabled'
  | 'performancePanelVisible'
  | 'maxStreamResolution'
  | 'maxStreamSizeGb'
  | 'streamCacheMaxGb'
  | 'streamCacheDir'
  | 'connectionSpeedMbps'
  | 'hideWatchedDefault'
  | 'hideCompletedDefault'
  | 'hideDislikedDefault'
> {
  return {
    theme: normalizeTheme(settings.theme),
    updateChannel: normalizeUpdateChannel(settings.updateChannel),
    playbackBuffer: normalizePlaybackBuffer(settings.playbackBuffer),
    videoScaling: normalizeVideoScaling(settings.videoScaling),
    autoSubtitlesEnabled: settings.autoSubtitlesEnabled !== false,
    uiAnimationsEnabled: settings.uiAnimationsEnabled !== false,
    performancePanelVisible: settings.performancePanelVisible !== false,
    maxStreamResolution: Number(settings.maxStreamResolution) || 0,
    maxStreamSizeGb: Number(settings.maxStreamSizeGb) || 0,
    // Deliberately NOT `Number(x) || 0`: that coerces "never configured"
    // (undefined) to the same 0 as "explicitly set to unbounded", and the
    // renderer displays 0 as "Unlimited" — a real, confirmed bug where an
    // unconfigured install showed "Unlimited" while the backend was
    // actually enforcing its true 10GB default (resolveStreamCacheMaxBytes
    // in playbackSession.ts, which reads the same raw settings directly
    // and treats undefined/0 as genuinely different cases). Preserving
    // undefined here lets the renderer's own `?? 10` fallback show the
    // real default instead of a wrong one.
    streamCacheMaxGb:
      typeof settings.streamCacheMaxGb === 'number' && Number.isFinite(settings.streamCacheMaxGb)
        ? settings.streamCacheMaxGb
        : undefined,
    streamCacheDir:
      typeof settings.streamCacheDir === 'string' ? settings.streamCacheDir : undefined,
    connectionSpeedMbps:
      Number(settings.connectionSpeedMbps) > 0 ? Number(settings.connectionSpeedMbps) : undefined,
    hideWatchedDefault: settings.hideWatchedDefault === true,
    hideCompletedDefault: settings.hideCompletedDefault === true,
    hideDislikedDefault: settings.hideDislikedDefault === true
  }
}
