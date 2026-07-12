const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('mediaHub', {
  settingsStatus: () => ipcRenderer.invoke('settings:status'),
  saveTorBox: token => ipcRenderer.invoke('torbox:save', token),
  testTorBox: () => ipcRenderer.invoke('torbox:test')
});
