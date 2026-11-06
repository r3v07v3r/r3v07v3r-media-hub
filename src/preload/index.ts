// The desktop app's side of the bridge: builds `window.api` (see api.ts, where
// the whole typed surface lives) over Electron IPC and exposes it to the
// renderer. Everything Electron-specific about the preload is in this file,
// which is what keeps api.ts loadable by a renderer running outside the shell.

import { contextBridge, ipcRenderer } from 'electron'
import { createApi, type ApiTransport } from './api'

export type { Api } from './api'

// Deliberately not exposed: the renderer gets the typed surface built FROM
// this, never ipcRenderer itself, so it can't send/listen on arbitrary
// channels.
const transport: ApiTransport = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: <T>(channel: string, listener: (payload: T) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  },
  send: (channel, ...args) => ipcRenderer.send(channel, ...args)
}

const api = createApi(transport)

// Use `contextBridge` to expose the typed api to the renderer only if context
// isolation is enabled, otherwise just add it to the DOM global. Only `api`
// goes across. Nothing else is exposed on purpose: a raw ipcRenderer (which
// is what the old `window.electron` handed over) would let the page use any
// channel, which is what the transport above exists to avoid.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api
}
