import { ipcMain, safeStorage } from 'electron'
import Store from 'electron-store'
import {
  DEFAULT_SERVICE_SETTINGS,
  IPC_CHANNELS,
  ServiceConfig,
  ServiceSettings
} from '../../shared/ipc-types'
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

export function registerSettingsIpc(): void {
  ipcMain.handle(IPC_CHANNELS.settingsGet, (event) => {
    assertTrustedSender(event)
    return mapApiKeys(store.get('services'), decryptApiKey)
  })

  ipcMain.handle(IPC_CHANNELS.settingsSet, (event, next: ServiceSettings) => {
    assertTrustedSender(event)
    if (!isServiceSettings(next)) throw new Error('Invalid service settings.')
    store.set('services', mapApiKeys(next, encryptApiKey))
    return mapApiKeys(store.get('services'), decryptApiKey)
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
