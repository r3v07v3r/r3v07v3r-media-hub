import { ipcMain, safeStorage } from 'electron'
import Store from 'electron-store'
import {
  DEFAULT_SERVICE_CONFIG,
  DEFAULT_SERVICE_SETTINGS,
  IPC_CHANNELS,
  ServiceConfig,
  ServiceId,
  ServiceSettings,
  withServiceDefaults
} from '../../shared/ipc-types'
import { setTrustedMediaHosts } from '../media-hub/playback'
import { assertTrustedSender } from './trustedSender'

interface StoreSchema {
  services: ServiceSettings
}

// electron-store persists to a plain JSON file under the OS user-data dir —
// this is the one legitimate place server URLs/API keys live. Explicitly
// NOT localStorage/sessionStorage (unsupported/prohibited in the renderer);
// this file lives outside the renderer entirely, in the main process.
const store = new Store<StoreSchema>({
  name: 'r3-settings',
  defaults: {
    services: DEFAULT_SERVICE_SETTINGS
  }
})

// apiKey is encrypted at rest via safeStorage — this settings surface used
// to persist Jellyfin/Sonarr/Radarr/qBittorrent API keys as plain text,
// inconsistent with every other credential this app stores (TorBox/Simkl/
// MAL/OpenSubtitles all go through media-hub/settingsStore.ts's own
// safeStorage-backed encrypt()/decrypt()). Deliberately a small local pair
// rather than importing that module's encrypt()/decrypt() directly: those
// assume every stored value is already in one of their two known encodings
// and have no legacy-plaintext fallback, so reusing them here on a store
// that has been writing real plaintext API keys for every prior release
// would silently return '' for an existing key on first read post-upgrade
// (safeStorage.decryptString on non-ciphertext bytes throws) — a real
// account-lockout-shaped data-loss bug. The ENC_PREFIX tag lets read code
// tell "genuinely encrypted" apart from "legacy/unavailable plaintext" and
// migrates the latter forward transparently the next time it's saved,
// never discarding an existing key.
const ENC_PREFIX = 'enc:'

function encryptApiKey(value: string): string {
  if (!value || !safeStorage.isEncryptionAvailable()) return value
  return ENC_PREFIX + safeStorage.encryptString(value).toString('base64')
}

function decryptApiKey(value: string): string {
  if (!value || !value.startsWith(ENC_PREFIX)) return value
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), 'base64'))
  } catch {
    return ''
  }
}

function mapApiKeys(
  services: ServiceSettings,
  transform: (apiKey: string) => string
): ServiceSettings {
  return Object.fromEntries(
    Object.entries(services).map(([id, config]) => [
      id,
      { ...(config as ServiceConfig), apiKey: transform((config as ServiceConfig).apiKey) }
    ])
  ) as ServiceSettings
}

/**
 * Reads one service's config with its API key already decrypted.
 *
 * This is the deliberate bridge between the two credential stores this app
 * ended up with: server URLs/keys for Jellyfin/Sonarr/Radarr/qBittorrent
 * live in `r3-settings` (here), while TorBox/Simkl/MAL/OpenSubtitles live
 * in media-hub's own settingsStore.ts. Playback now needs to read across
 * that line. Exposing a reader is the cheap, safe direction — *migrating*
 * these keys is not, for exactly the legacy-plaintext reason documented on
 * ENC_PREFIX above.
 */
export function getServiceConfig(id: ServiceId): ServiceConfig {
  const services = store.get('services')
  const config = services?.[id] ?? DEFAULT_SERVICE_CONFIG
  return { ...config, apiKey: decryptApiKey(config.apiKey) }
}

/**
 * Publishes the media-server host to playback's SSRF allowlist.
 *
 * Only an *enabled* service with a parseable base URL is trusted, so
 * unticking "enabled" in Settings revokes LAN playback access on the spot.
 * setTrustedMediaHosts replaces the set wholesale rather than appending,
 * which is what makes removal work — see its comment in playback.ts.
 */
export function publishTrustedMediaHosts(): void {
  const jellyfin = store.get('services')?.jellyfin
  const trusted =
    jellyfin?.enabled && jellyfin.baseUrl.trim() ? [normalizeBaseUrl(jellyfin.baseUrl)] : []
  setTrustedMediaHosts(trusted)
}

/** Mirrors the renderer's normalizeBaseUrl (lib/api/types.ts) — a saved URL
 *  routinely has a trailing slash, and `new URL()` is fine with that, but
 *  keeping the two sides byte-identical avoids a class of "works in Test
 *  Connection, fails at playback" bug. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

export function registerSettingsIpc(): void {
  // Startup: a media server configured in a previous run must be trusted
  // before the first playback attempt, not only after the next save.
  publishTrustedMediaHosts()

  ipcMain.handle(IPC_CHANNELS.settingsGet, (event) => {
    assertTrustedSender(event)
    return mapApiKeys(withServiceDefaults(store.get('services')), decryptApiKey)
  })

  ipcMain.handle(IPC_CHANNELS.settingsSet, (event, next: ServiceSettings) => {
    assertTrustedSender(event)
    // Merged BEFORE validation: a renderer that has not reloaded since a new
    // service ID was added only knows the ones it started with, and saving
    // its (correct, for what it knows) change must not be rejected just
    // because a field it never saw is absent — the merge fills that field
    // from whatever is already stored, same as a read would.
    const merged = withServiceDefaults(next)
    if (!isServiceSettings(merged)) throw new Error('Invalid service settings.')
    store.set('services', mapApiKeys(merged, encryptApiKey))
    // The saved host is the authority for what playback may reach, so
    // refresh the allowlist in the same tick it changed.
    publishTrustedMediaHosts()
    return mapApiKeys(withServiceDefaults(store.get('services')), decryptApiKey)
  })
}

function isServiceSettings(value: unknown): value is ServiceSettings {
  if (!value || typeof value !== 'object') return false
  return Object.keys(DEFAULT_SERVICE_SETTINGS).every((id) => {
    const config = (value as Record<string, unknown>)[id]
    if (!config || typeof config !== 'object') return false
    const candidate = config as Record<string, unknown>
    return (
      typeof candidate.baseUrl === 'string' &&
      candidate.baseUrl.length <= 2048 &&
      typeof candidate.apiKey === 'string' &&
      candidate.apiKey.length <= 4096 &&
      typeof candidate.enabled === 'boolean'
    )
  })
}
