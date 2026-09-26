// What `import ... from 'electron'` resolves to when src/main runs WITHOUT
// Electron — as the backend of the TV and phone apps, or as a server on a box
// with no display. scripts/build-headless.mjs aliases the module name to this
// file at bundle time, so not one line of the service layer changes: the same
// handlers register against this ipcMain, the same pushes go out through this
// webContents.send, the same settings file is sealed by this safeStorage.
//
// The bundler is the checklist. A name imported from 'electron' that is not
// exported here fails the BUILD ("No matching export"), so this file can never
// silently fall behind the code it stands in for.
//
// Three kinds of thing live here:
//   - real implementations of what a backend genuinely needs (app paths and
//     lifecycle, ipcMain, the window/webContents push path, safeStorage);
//   - honest refusals for what only a desktop has (dialog, Notification) —
//     they answer the way the real API answers "the user cancelled" or
//     "unsupported", which every caller already handles;
//   - inert placeholders for what a headless boot never reaches (protocol,
//     session, screen) — calling one throws, loudly, rather than pretending.

import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Host configuration — how the process that starts the backend tells it where
// it lives. Read on use, never at import, so import order cannot matter.
// ---------------------------------------------------------------------------

function userDataDir(): string {
  const dir = process.env.R3_USER_DATA
  if (!dir)
    throw new Error('R3_USER_DATA is not set: the headless backend has nowhere to keep its data.')
  return dir
}

/** What a backend does when asked to show a window, focus it, or otherwise
 *  act on a desktop it does not have. ONE named nothing rather than an empty
 *  body per method, so that an empty method anywhere else in this file is
 *  still the mistake the linter takes it for. */
// eslint-disable-next-line @typescript-eslint/no-empty-function
const nothing = (): void => {}

/** Stamped in by the bundler from package.json — see build-headless.mjs. */
const APP_VERSION = process.env.R3_APP_VERSION || '0.0.0-dev'

// ---------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------

class HeadlessApp extends EventEmitter {
  /** True: there is no dev server here, so nothing may take the dev branch
   *  (`is.dev` in @electron-toolkit/utils is `!app.isPackaged`). */
  readonly isPackaged = true

  getPath(name: string): string {
    const base = userDataDir()
    switch (name) {
      case 'userData':
      case 'sessionData':
        return base
      case 'logs':
        return path.join(base, 'logs')
      case 'temp':
        return path.join(base, 'tmp')
      // A desktop has a Pictures/Downloads folder of the user's; a backend has
      // only its own directory, so anything written "for the user" lands in a
      // named folder inside it rather than somewhere it has no business.
      default:
        return path.join(base, name)
    }
  }

  getVersion(): string {
    return APP_VERSION
  }

  getName(): string {
    return 'r3v07v3r-media-hub'
  }

  getAppPath(): string {
    return __dirname
  }

  getLocale(): string {
    return process.env.R3_LOCALE || 'en-US'
  }

  /** Already true: there is no browser process to wait for. */
  whenReady(): Promise<void> {
    return Promise.resolve()
  }

  isReady(): boolean {
    return true
  }

  setAppUserModelId = nothing

  /** The orderly way down — emits before-quit so the service layer's own
   *  teardown runs, exactly as it does on the desktop. */
  quit(): void {
    this.emit('before-quit', { preventDefault: nothing })
    this.emit('will-quit', { preventDefault: nothing })
    this.emit('quit', {}, 0)
  }
}

export const app = new HeadlessApp()

// ---------------------------------------------------------------------------
// ipcMain — the registry the bridge dispatches into.
// ---------------------------------------------------------------------------

type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown

class HeadlessIpcMain extends EventEmitter {
  private readonly handlers = new Map<string, InvokeHandler>()

  handle(channel: string, listener: InvokeHandler): void {
    if (this.handlers.has(channel)) {
      throw new Error(`Attempted to register a second handler for '${channel}'`)
    }
    this.handlers.set(channel, listener)
  }

  handleOnce(channel: string, listener: InvokeHandler): void {
    this.handle(channel, (event, ...args) => {
      this.handlers.delete(channel)
      return listener(event, ...args)
    })
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }

  /** Bridge-facing: what `ipcRenderer.invoke` does on the far side. */
  async dispatchInvoke(event: unknown, channel: string, args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error(`No handler registered for '${channel}'`)
    return handler(event, ...args)
  }

  /** Bridge-facing: what `ipcRenderer.send` does on the far side. */
  dispatchSend(event: unknown, channel: string, args: unknown[]): void {
    this.emit(channel, event, ...args)
  }

  /** Every request channel the service layer registered. */
  channels(): string[] {
    return [...this.handlers.keys()]
  }
}

export const ipcMain = new HeadlessIpcMain()

// ---------------------------------------------------------------------------
// BrowserWindow / webContents — not a window, a NAME for one end of the
// bridge. The service layer pushes to "the main window" and "the player
// overlay"; here each of those is whichever bridge connections claimed that
// scope, and `send` is handed to whoever is listening for it.
// ---------------------------------------------------------------------------

/** The document the desktop renderer is loaded from. The service layer's
 *  sender check (ipc/trustedSender.ts) compares against exactly this, and it
 *  is the bridge — not this string — that decides who may connect at all. */
export const HEADLESS_RENDERER_URL = 'app://index.html/'

export type PushSink = (channel: string, payload: unknown) => void

export class HeadlessWebContents extends EventEmitter {
  readonly mainFrame = { url: HEADLESS_RENDERER_URL }
  readonly session = session.defaultSession
  private sink: PushSink | null = null

  constructor(readonly id: number) {
    super()
  }

  /** Bridge-facing: where pushes for this window go. */
  setPushSink(sink: PushSink | null): void {
    this.sink = sink
  }

  send(channel: string, payload?: unknown): void {
    this.sink?.(channel, payload)
  }

  getURL(): string {
    return HEADLESS_RENDERER_URL
  }

  isDestroyed(): boolean {
    return false
  }

  setWindowOpenHandler = nothing
}

let nextWindowId = 1
const openWindows = new Set<BrowserWindow>()

export class BrowserWindow extends EventEmitter {
  readonly id = nextWindowId++
  readonly webContents = new HeadlessWebContents(this.id)
  private destroyed = false

  constructor() {
    super()
    openWindows.add(this)
  }

  static getAllWindows(): BrowserWindow[] {
    return [...openWindows]
  }

  static getFocusedWindow(): BrowserWindow | null {
    return null
  }

  static fromWebContents(contents: unknown): BrowserWindow | null {
    for (const win of openWindows) if (win.webContents === contents) return win
    return null
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  destroy(): void {
    this.destroyed = true
    openWindows.delete(this)
    this.emit('closed')
  }

  close(): void {
    this.destroy()
  }

  // A backend has no window to show, size, focus or make fullscreen. These
  // answer as a window that is simply there and unremarkable.
  show = nothing
  hide = nothing
  focus = nothing
  isVisible(): boolean {
    return true
  }
  isFocused(): boolean {
    return false
  }
  isMinimized(): boolean {
    return false
  }
  isFullScreen(): boolean {
    return false
  }
  setFullScreen = nothing
  getBounds(): { x: number; y: number; width: number; height: number } {
    return { x: 0, y: 0, width: 1920, height: 1080 }
  }
  getContentBounds(): { x: number; y: number; width: number; height: number } {
    return this.getBounds()
  }
  getNativeWindowHandle(): Buffer {
    return Buffer.alloc(8)
  }
  loadURL(): Promise<void> {
    return Promise.resolve()
  }
}

// ---------------------------------------------------------------------------
// safeStorage — the settings file is sealed with a key the HOST supplies.
//
// On the desktop this is DPAPI/Keychain. Here the host process hands over a
// 32-byte key in R3_MASTER_KEY (on Android it is unwrapped from the hardware
// Keystore for exactly this purpose and never written down); with no key
// given, a server on someone's own box keeps one beside its data, owner-only
// — the same footing as the cache daemon's token file.
// ---------------------------------------------------------------------------

const SEAL_VERSION = Buffer.from('r3h1')

let cachedKey: Buffer | null | undefined

function masterKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey
  cachedKey = null
  try {
    const given = process.env.R3_MASTER_KEY
    if (given) {
      const key = Buffer.from(given, 'base64')
      if (key.length !== 32) throw new Error('R3_MASTER_KEY must be 32 bytes, base64-encoded.')
      cachedKey = key
      return cachedKey
    }
    const file = path.join(userDataDir(), 'master.key')
    if (fs.existsSync(file)) {
      const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64')
      if (key.length === 32) cachedKey = key
      return cachedKey
    }
    const key = crypto.randomBytes(32)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, key.toString('base64'), { mode: 0o600 })
    cachedKey = key
  } catch (error) {
    console.error('[headless] no key to seal settings with:', (error as Error).message)
  }
  return cachedKey
}

export const safeStorage = {
  isEncryptionAvailable(): boolean {
    return masterKey() !== null
  },

  encryptString(plainText: string): Buffer {
    const key = masterKey()
    if (!key) throw new Error('Encryption is not available.')
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const body = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
    return Buffer.concat([SEAL_VERSION, iv, cipher.getAuthTag(), body])
  },

  decryptString(encrypted: Buffer): string {
    const key = masterKey()
    if (!key) throw new Error('Encryption is not available.')
    if (!encrypted.subarray(0, 4).equals(SEAL_VERSION)) {
      throw new Error('Not sealed by this backend.')
    }
    const iv = encrypted.subarray(4, 16)
    const tag = encrypted.subarray(16, 32)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(encrypted.subarray(32)), decipher.final()]).toString(
      'utf8'
    )
  }
}

// ---------------------------------------------------------------------------
// shell / clipboard — things that happen on the DEVICE, which only the host
// can do. It registers how; until it has, they are refused rather than faked.
// ---------------------------------------------------------------------------

export interface HostActions {
  openExternal?: (url: string) => Promise<void> | void
  writeClipboard?: (text: string) => void
}

let host: HostActions = {}

/** Host-facing: how this device opens a link and writes its clipboard. */
export function setHostActions(actions: HostActions): void {
  host = actions
}

export const shell = {
  async openExternal(url: string): Promise<void> {
    if (!host.openExternal) throw new Error('This device cannot open links.')
    await host.openExternal(url)
  },
  showItemInFolder: nothing,
  async openPath(): Promise<string> {
    return 'Not supported on this device.'
  }
}

export const clipboard = {
  writeText(text: string): void {
    host.writeClipboard?.(text)
  },
  readText(): string {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Desktop-only surfaces.
// ---------------------------------------------------------------------------

/** Native pickers: every one answers "cancelled", which each caller already
 *  treats as "the user changed their mind" and returns null for. */
export const dialog = {
  async showOpenDialog(): Promise<{ canceled: true; filePaths: string[] }> {
    return { canceled: true, filePaths: [] }
  },
  async showSaveDialog(): Promise<{ canceled: true; filePath: undefined }> {
    return { canceled: true, filePath: undefined }
  },
  async showMessageBox(): Promise<{ response: number; checkboxChecked: false }> {
    return { response: 0, checkboxChecked: false }
  },
  showErrorBox: nothing
}

export class Notification extends EventEmitter {
  static isSupported(): boolean {
    return false
  }
  show = nothing
  close = nothing
}

function unreachable(what: string): never {
  throw new Error(`${what} does not exist without Electron — a headless boot must not reach it.`)
}

const inertSession = {
  setPermissionRequestHandler: nothing,
  on: nothing,
  off: nothing,
  webRequest: { onBeforeSendHeaders: nothing }
}

export const session = {
  defaultSession: inertSession,
  fromPartition: (): typeof inertSession => inertSession
}

export const screen = {
  getPrimaryDisplay: (): never => unreachable('screen.getPrimaryDisplay'),
  getDisplayMatching: (): never => unreachable('screen.getDisplayMatching'),
  dipToScreenRect: (): never => unreachable('screen.dipToScreenRect')
}

export const desktopCapturer = {
  getSources: (): never => unreachable('desktopCapturer.getSources')
}

export const protocol = {
  registerSchemesAsPrivileged: nothing,
  handle: (): never => unreachable('protocol.handle')
}

export const net = {
  fetch: (): never => unreachable('net.fetch')
}

export const ipcRenderer = undefined
export const contextBridge = undefined

export default {
  app,
  ipcMain,
  BrowserWindow,
  safeStorage,
  shell,
  clipboard,
  dialog,
  Notification,
  session,
  screen,
  desktopCapturer,
  protocol,
  net
}
