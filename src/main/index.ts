import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerTelemetryIpc } from './ipc/telemetry'
import { registerSettingsIpc } from './ipc/settings'
import { registerHttpProxyIpc } from './ipc/httpProxy'
import { registerMediaHubIpc } from './ipc/mediaHub'
import { APP_SCHEME, registerAppSchemeAsPrivileged, registerAppSchemeHandler } from './appProtocol'
import { createDatabase } from './media-hub/database'
import { getDatabase, setDatabase } from './media-hub/dbState'
import { setActiveWindow, sendToRenderer } from './media-hub/rendererBridge'
import { isAllowedExternalUrl } from './media-hub/security'
import { setupAutoUpdater } from './media-hub/autoUpdate'
import { installDownloadGuard } from './media-hub/downloadGuard'
import { closeParty } from './media-hub/watchParty'
import { stopPlayback } from './media-hub/playbackSession'
import { shutdownPlayer } from './media-hub/playerBridge'
import { MEDIA_HUB_CHANNELS } from '../shared/media-hub/ipc-channels'

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
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Lets the renderer's playback fullscreen button reflect the window's
  // real state even when it changes from something other than that button
  // (OS-level exit via Escape/F11, etc.) — without this, the renderer's
  // own local toggle-tracking state would drift out of sync with reality.
  mainWindow.on('enter-full-screen', () => {
    sendToRenderer(MEDIA_HUB_CHANNELS.windowFullscreenChanged, { fullScreen: true })
  })
  mainWindow.on('leave-full-screen', () => {
    sendToRenderer(MEDIA_HUB_CHANNELS.windowFullscreenChanged, { fullScreen: false })
  })

  // media-hub integration: only ever open an external browser window for a
  // host on the media-hub security allowlist (TorBox/Simkl/GitHub/TMDB/MAL/
  // OpenSubtitles) — see security.ts's isAllowedExternalUrl. Everything
  // else is denied outright rather than silently opened, since this
  // handler now also covers links the media-hub-backed dashboard content
  // can trigger (catalog pages, watch-party invites, etc.), not just this
  // shell's own UI.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isAllowedExternalUrl(details.url)) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Block the main window itself from ever navigating away from its own
  // renderer origin (dev server URL, or the app:// scheme in production) —
  // ported from the original media-hub app's `will-navigate` guard, which
  // blocked any URL not local, adapted here for this project's custom
  // app:// scheme instead of file://.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isOwnOrigin =
      is.dev && process.env['ELECTRON_RENDERER_URL']
        ? url.startsWith(process.env['ELECTRON_RENDERER_URL'])
        : // Chromium normalizes this custom standard scheme's empty-authority
          // loadURL(`${APP_SCHEME}:///index.html`) into a real host at
          // runtime — the actual URL is `app://index.html/...` (two
          // slashes), not `app:///...` (three, empty host). Confirmed live
          // via a remote-debugging probe (Runtime.evaluate('location.href')
          // against a packaged build — see ipcGuard.ts's
          // trustedRendererOrigin() for the same fix and fuller context).
          // The three-slash prefix here never matched, so this guard was
          // silently blocking every same-origin navigation it was meant to
          // allow, not just rejecting external ones.
          url.startsWith(`${APP_SCHEME}://`)
    if (!isOwnOrigin) event.preventDefault()
  })

  // Deny every permission request (camera/mic/notifications/etc.) by
  // default — ported from the original media-hub app; nothing this
  // dashboard does needs any of these.
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  )

  // Trailer playback (CatalogItem.trailers) embeds YouTube — YouTube
  // requires a youtube-nocookie.com Referer on these hosts or embedded
  // playback is refused. Ported from the original media-hub app verbatim.
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
    {
      urls: [
        '*://*.youtube.com/*',
        '*://*.youtube-nocookie.com/*',
        '*://*.ytimg.com/*',
        '*://*.googlevideo.com/*'
      ]
    },
    (details, callback) => {
      details.requestHeaders.Referer = 'https://www.youtube-nocookie.com/'
      callback({ requestHeaders: details.requestHeaders })
    }
  )

  setActiveWindow(mainWindow)
  mainWindow.on('closed', () => setActiveWindow(null))

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    // app:/// rather than loadFile()'s file:// — see appProtocol.ts.
    mainWindow.loadURL(`${APP_SCHEME}:///index.html`)
  }

  setupAutoUpdater(mainWindow)
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  registerAppSchemeHandler()

  // Before any window exists, so there is no window-shaped gap at startup
  // during which a download could slip through unguarded.
  installDownloadGuard()

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerTelemetryIpc()
  registerSettingsIpc()
  registerHttpProxyIpc()

  // media-hub's own SQLite store (tracked items/watch history/catalog
  // cache) — must exist before registerMediaHubIpc()'s handlers can ever
  // be invoked, though since ipcMain.handle registration itself is
  // synchronous and handlers only actually run once the renderer calls
  // them (well after this whole block completes), the ordering here is
  // for clarity more than strict necessity.
  setDatabase(createDatabase(join(app.getPath('userData'), 'media-hub.sqlite')))
  registerMediaHubIpc()

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// media-hub cleanup: stop any in-flight playback (closes StreamCache +
// kills a running ffmpeg transcoder), leave/close any active Watch Party,
// and close the SQLite handle. Ported from the original app's `before-quit`
// handler. deleteCache=true here (unlike an ordinary close mid-session,
// which leaves the cache for a likely near-term resume — see
// playbackSession.ts's stopPlayback): there's no future session left to
// resume into once the app has actually quit.
app.on('before-quit', () => {
  stopPlayback(true).catch(() => {})
  // mpv is a child process that outlives any single title deliberately (see
  // playerBridge.ts) — quitting the app is the one point it must actually be
  // torn down, or it survives as an orphan holding the window handle it was
  // embedded into.
  shutdownPlayer().catch(() => {})
  closeParty()
  try {
    getDatabase().close()
  } catch {
    // best-effort close only — if the DB was never initialized (e.g. quit
    // during startup before app.whenReady() finished), there's nothing to
    // close.
  }
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
