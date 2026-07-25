// Ported from r3v07v3r-media-hub's src/main.cjs (the `handle` wrapper around
// ipcMain.handle). Every media-hub IPC channel is registered through this
// so every one of them gets, uniformly: (1) a sender-frame trust check
// (rejects anything not loaded from this app's own renderer — see
// security.ts's isTrustedIpcSender) and (2) errors logged to
// media-hub.log before being rethrown to the renderer.
//
// The trusted origin differs from the original app (which only ever loaded
// a packaged file://index.html): this project's renderer loads from the
// Vite dev server URL in development and from the app:// custom scheme in
// production (see appProtocol.ts) — trustedRendererOrigin() picks whichever
// applies at runtime, exactly mirroring how src/main/index.ts itself
// chooses which URL to load.

import { ipcMain, IpcMainInvokeEvent } from 'electron'
import { is } from '@electron-toolkit/utils'
import { APP_SCHEME } from '../appProtocol'
import { isTrustedIpcSender } from './security'
import { logError } from './logger'
import type { MediaHubChannel } from '../../shared/media-hub/ipc-channels'

function trustedRendererOrigin(): string {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    return process.env['ELECTRON_RENDERER_URL']
  }
  return `${APP_SCHEME}:///index.html`
}

type Listener<TArgs, TResult> = (
  event: IpcMainInvokeEvent,
  payload: TArgs
) => Promise<TResult> | TResult

/** Registers a trust-checked, error-logged ipcMain.handle for one media-hub channel. `payload` is `undefined` for handlers invoked with no argument. */
export function handle<TArgs = undefined, TResult = unknown>(
  channel: MediaHubChannel,
  listener: Listener<TArgs, TResult>
): void {
  ipcMain.handle(channel, async (event, payload?: TArgs) => {
    if (!isTrustedIpcSender(event.senderFrame?.url, trustedRendererOrigin())) {
      throw new Error('Unauthorized IPC sender.')
    }
    try {
      return await listener(event, payload as TArgs)
    } catch (error) {
      logError(channel, error)
      throw error
    }
  })
}
