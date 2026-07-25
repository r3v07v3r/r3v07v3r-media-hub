import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerTelemetryIpc } from './ipc/telemetry'
import { registerSettingsIpc } from './ipc/settings'
import { registerHttpProxyIpc } from './ipc/httpProxy'
import { APP_SCHEME, registerAppSchemeAsPrivileged, registerAppSchemeHandler } from './appProtocol'

// Fixed 1920x1080 design canvas (spec section 1) — the composition is built
// pixel-for-pixel at this resolution first; responsive scaling is a later
// concern layered on top, not the starting point.
const DESIGN_WIDTH = 1920
const DESIGN_HEIGHT = 1080

// Must run before app 'ready' (Electron requirement for privileged scheme
// registration) — see appProtocol.ts for why production loads over this
// custom scheme instead of file://.
registerAppSchemeAsPrivileged()

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: DESIGN_WIDTH,
    height: DESIGN_HEIGHT,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#02060b',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    // app:/// rather than loadFile()'s file:// — see appProtocol.ts.
    mainWindow.loadURL(`${APP_SCHEME}:///index.html`)
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  registerAppSchemeHandler()

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  registerTelemetryIpc()
  registerSettingsIpc()
  registerHttpProxyIpc()

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
