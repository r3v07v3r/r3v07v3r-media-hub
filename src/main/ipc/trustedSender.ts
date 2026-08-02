import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { is } from '@electron-toolkit/utils'
import { APP_SCHEME } from '../appProtocol'
import { isTrustedIpcSender } from '../media-hub/security'

function trustedRendererUrl(): string {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    return process.env['ELECTRON_RENDERER_URL']
  }
  return `${APP_SCHEME}://index.html/`
}

/** Reject IPC from subframes or any document other than this app's renderer. */
export function assertTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): void {
  if (
    event.senderFrame !== event.sender.mainFrame ||
    !isTrustedIpcSender(event.senderFrame?.url, trustedRendererUrl())
  ) {
    throw new Error('Unauthorized IPC sender.')
  }
}
