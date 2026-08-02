import { ipcMain } from 'electron'
import Store from 'electron-store'
import { DEFAULT_SERVICE_SETTINGS, IPC_CHANNELS, ServiceSettings } from '../../shared/ipc-types'
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

export function registerSettingsIpc(): void {
  ipcMain.handle(IPC_CHANNELS.settingsGet, (event) => {
    assertTrustedSender(event)
    return store.get('services')
  })

  ipcMain.handle(IPC_CHANNELS.settingsSet, (event, next: ServiceSettings) => {
    assertTrustedSender(event)
    if (!isServiceSettings(next)) throw new Error('Invalid service settings.')
    store.set('services', next)
    return store.get('services')
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
