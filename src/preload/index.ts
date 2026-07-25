import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import {
  IPC_CHANNELS,
  ProxyRequest,
  ProxyResponse,
  ServiceSettings,
  SystemSnapshot
} from '../shared/ipc-types'

// Custom APIs for renderer — a small typed surface rather than exposing
// ipcRenderer wholesale, so the renderer can't send/listen on arbitrary
// channels (see src/preload/index.d.ts for the matching type contract).
const api = {
  system: {
    getSnapshot: (): Promise<SystemSnapshot> => ipcRenderer.invoke(IPC_CHANNELS.systemSnapshot),
    subscribe: (onSnapshot: (snapshot: SystemSnapshot) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshot: SystemSnapshot): void =>
        onSnapshot(snapshot)
      ipcRenderer.on(IPC_CHANNELS.systemSnapshot, listener)
      ipcRenderer.send('system:subscribe')
      return () => {
        ipcRenderer.send('system:unsubscribe')
        ipcRenderer.removeListener(IPC_CHANNELS.systemSnapshot, listener)
      }
    }
  },
  settings: {
    get: (): Promise<ServiceSettings> => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
    set: (next: ServiceSettings): Promise<ServiceSettings> =>
      ipcRenderer.invoke(IPC_CHANNELS.settingsSet, next)
  },
  http: {
    request: <T = unknown>(req: ProxyRequest): Promise<ProxyResponse<T>> =>
      ipcRenderer.invoke(IPC_CHANNELS.httpRequest, req)
  }
}

export type Api = typeof api

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
