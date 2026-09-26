// `electron-updater` for a backend that is not an Electron app: it has no
// installer to fetch and nothing to swap itself for — its host (an APK, a
// service manager) owns that. The updater module is still imported by the
// service layer, so it needs SOMETHING by this name; this is an updater that
// never finds anything, which is the truth.

import { EventEmitter } from 'node:events'

class InertUpdater extends EventEmitter {
  autoDownload = false
  autoInstallOnAppQuit = false
  allowPrerelease = false

  async checkForUpdates(): Promise<null> {
    return null
  }

  /** There is nothing to install, and nothing to quit into. */
  quitAndInstall(): void {
    return
  }
}

export const autoUpdater = new InertUpdater()
