import { ipcMain } from 'electron'
import Store from 'electron-store'
import { DEFAULT_SERVICE_SETTINGS, IPC_CHANNELS, ServiceSettings } from '../../shared/ipc-types'

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
  ipcMain.handle(IPC_CHANNELS.settingsGet, () => {
    return store.get('services')
  })

  ipcMain.handle(IPC_CHANNELS.settingsSet, (_event, next: ServiceSettings) => {
    store.set('services', next)
    return store.get('services')
  })
}
