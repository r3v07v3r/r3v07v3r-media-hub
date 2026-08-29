// Ported from r3v07v3r-media-hub's src/preferences.cjs. Validation logic
// (theme id allowlist, update-channel normalization, and which fields are
// exposed to the renderer vs. cleared on logout) is preserved exactly from
// the original — this is a security/privacy boundary (logoutSettings in
// particular controls what survives an account logout), not a place for
// "improvements".

import type {
  CacheMode,
  MediaHubPublicSettings,
  SavedFilter,
  SourcePreference,
  Theme,
  UpdateChannel
} from '../../shared/media-hub/types'
import { normalizePlaybackBuffer } from '../../shared/media-hub/playbackBuffer'
import { normalizeVideoScaling } from '../../shared/media-hub/videoScaling'
import { normalizeOllamaBaseUrl, normalizeOllamaModel } from '../../shared/media-hub/ollama'
import { watchRegion } from './watchProviders'

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
    autoplayNextEnabled: settings.autoplayNextEnabled !== false,
    savedFilters: normalizeSavedFilters(settings.savedFilters),
    notificationsEnabled: settings.notificationsEnabled === true,
    watchRegion: watchRegion(),
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
    hideDislikedDefault: settings.hideDislikedDefault === true,
    // Re-normalized on the way out, not just on the way in: what's on disk
    // was written by some earlier version of this app, and the renderer
    // renders this straight into the Settings pane. These two are what was
    // SAVED; settings:get overwrites them with what is actually in use,
    // which also counts an instance found at the default address (see
    // appIpc.ts).
    ollamaBaseUrl: normalizeOllamaBaseUrl(settings.ollamaBaseUrl),
    ollamaModel: normalizeOllamaModel(settings.ollamaModel),
    ollamaAutoDetect: settings.ollamaAutoDetect !== false,
    sourcePreference: normalizeSourcePreference(settings.sourcePreference),
    cacheMode: effectiveCacheMode(settings),
    memoryCacheMaxMb: normalizeMemoryCacheMb(settings.memoryCacheMaxMb),
    // Absent means never asked, and the app has to behave as though the
    // answer were yes until somebody says otherwise — every existing
    // install predates the question and already stores.
    storeMedia: settings.storeMedia !== false
  }
}

/** Anything but an explicit 'memory' is the disk default — the safer of
 *  the two to fall back to, since it is what every existing install does. */
export function normalizeCacheMode(value: unknown): CacheMode {
  return value === 'memory' ? 'memory' : 'disk'
}

/**
 * The cache mode actually in force, which is not always the one saved.
 *
 * A person who answered "stream only" is promised that nothing lands on
 * their disk, and a promise the backend does not keep is theatre — hiding
 * the disk controls would leave the saved value still reading 'disk' and
 * streamCache still writing. So the policy WINS over the stored mode, here,
 * in the one function everything else reads, rather than being re-enforced
 * in each place that happens to care.
 *
 * The stored mode is deliberately left untouched underneath: turning storage
 * back on should restore the choice made before it, not a default.
 */
export function effectiveCacheMode(settings: {
  cacheMode?: unknown
  storeMedia?: boolean
}): CacheMode {
  if (settings.storeMedia === false) return 'memory'
  return normalizeCacheMode(settings.cacheMode)
}

/** Kept in step with streamCache.ts's own clamp so the Settings pane can
 *  never show a number the cache would not actually honour. */
export function normalizeMemoryCacheMb(value: unknown): number {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return 512
  return Math.min(4096, Math.max(256, Math.round(raw)))
}

/** An unknown or absent value is the balanced default — a settings file
 *  outlives the code that wrote it, and this is read on every snapshot. */
export function normalizeSourcePreference(value: unknown): SourcePreference {
  return value === 'prefer-local' || value === 'prefer-quality' || value === 'balanced'
    ? value
    : 'balanced'
}

/**
 * Narrower projection used on logout — only theme, update channel, and
 * playback buffering survive; every account/service-identifying field is
 * intentionally dropped. Playback buffering (and the UI-animations/video-
 * transcode toggles alongside it) is a device/connection preference, not
 * account data, so it belongs here too, as does the local Ollama address
 * and model.
 */
/**
 * Reads stored filters back into a usable shape.
 *
 * Every field is checked rather than trusted: this is the one setting whose
 * value is a list of objects, so a hand-edited or half-written file could
 * otherwise put an entry with no id into a chip row and produce a view nobody
 * can select or delete.
 */
function normalizeSavedFilters(value: unknown): SavedFilter[] {
  if (!Array.isArray(value)) return []
  const kinds = new Set(['movie', 'series', 'anime'])
  return value
    .filter(
      (entry): entry is SavedFilter =>
        Boolean(entry) &&
        typeof (entry as SavedFilter).id === 'string' &&
        (entry as SavedFilter).id.length > 0 &&
        typeof (entry as SavedFilter).name === 'string' &&
        typeof (entry as SavedFilter).query === 'string' &&
        kinds.has(String((entry as SavedFilter).kind))
    )
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      query: entry.query
    }))
}

export function logoutSettings(settings: Record<string, unknown> = {}): Pick<
  MediaHubPublicSettings,
  | 'theme'
  | 'updateChannel'
  | 'playbackBuffer'
  | 'videoScaling'
  | 'autoSubtitlesEnabled'
  | 'autoplayNextEnabled'
  | 'savedFilters'
  | 'notificationsEnabled'
  | 'watchRegion'
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
  | 'ollamaBaseUrl'
  | 'ollamaModel'
  | 'ollamaAutoDetect'
  | 'sourcePreference'
  | 'cacheMode'
  | 'memoryCacheMaxMb'
  // Optional, and it has to be: the answer is a THREE-state value on disk
  // (yes / no / never asked) and only the first two may be written back.
> &
  Partial<Pick<MediaHubPublicSettings, 'storeMedia'>> {
  return {
    theme: normalizeTheme(settings.theme),
    updateChannel: normalizeUpdateChannel(settings.updateChannel),
    playbackBuffer: normalizePlaybackBuffer(settings.playbackBuffer),
    videoScaling: normalizeVideoScaling(settings.videoScaling),
    autoSubtitlesEnabled: settings.autoSubtitlesEnabled !== false,
    autoplayNextEnabled: settings.autoplayNextEnabled !== false,
    savedFilters: normalizeSavedFilters(settings.savedFilters),
    notificationsEnabled: settings.notificationsEnabled === true,
    watchRegion: watchRegion(),
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
    hideDislikedDefault: settings.hideDislikedDefault === true,
    // Survives logout with the other device preferences: which machine on
    // your own network runs your own models has nothing to do with which
    // TorBox/Simkl account was signed in. Having turned local AI off is the
    // same kind of fact, and dropping it here would have logging out
    // silently switch it back on.
    ollamaBaseUrl: normalizeOllamaBaseUrl(settings.ollamaBaseUrl),
    ollamaModel: normalizeOllamaModel(settings.ollamaModel),
    ollamaAutoDetect: settings.ollamaAutoDetect !== false,
    // Also a device preference, for the same reason: whether there is a
    // media server on this network, and how much you want it preferred,
    // is a fact about the machine and the connection — not about which
    // account was signed in.
    sourcePreference: normalizeSourcePreference(settings.sourcePreference),
    // Device preferences too: how fast this connection is and whether
    // media may touch this disk are facts about the machine.
    //
    // The RAW mode, not the effective one. Writing the effective mode back
    // would resolve the policy into the stored value: a person who chose
    // stream-only would have their saved 'disk' overwritten with 'memory'
    // and could not get it back by turning storage on again, which is the
    // one thing effectiveCacheMode's own comment promises not to do.
    cacheMode: normalizeCacheMode(settings.cacheMode),
    memoryCacheMaxMb: normalizeMemoryCacheMb(settings.memoryCacheMaxMb),
    // The ANSWER itself is kept, not just its consequence. Dropping it puts
    // storeMedia back to undefined, which the snapshot reads as "never
    // asked" — so signing out would raise the first-run storage dialog
    // again at somebody who already answered it, and that dialog cannot be
    // dismissed. Whether media may touch this disk is a fact about the
    // machine, like the rest of this block, not about who was signed in.
    //
    // Carried only when it is genuinely an answer. Writing `!== false` here
    // would turn "never asked" into "yes" and the question would never be
    // put to a new install that happened to sign out first — the mirror of
    // the bug above, and the reason this is spread rather than assigned.
    ...(typeof settings.storeMedia === 'boolean' ? { storeMedia: settings.storeMedia } : {})
  }
}
