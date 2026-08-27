// The opt-in TorBox token — what lets the daemon mint fresh download links
// and keep fetching overnight with no app running.
//
// Stored as a 0600 file. Stated plainly rather than dressed up: a headless
// Linux box has no OS keychain, so file permissions ARE the protection
// here, and the app says so in the UI at the moment the person opts in.
// Revocation is deletion (POST an empty token), and the app can do it any
// time.

import fsp from 'node:fs/promises'
import path from 'node:path'

export interface Credentials {
  torboxToken(): string
  setTorboxToken(token: string): Promise<void>
  load(): Promise<void>
}

export function createCredentials(dataDir: string): Credentials {
  const credPath = path.join(dataDir, 'credentials.json')
  let torbox = ''

  return {
    torboxToken: () => torbox,
    async setTorboxToken(token) {
      torbox = String(token || '').trim()
      if (!torbox) {
        await fsp.rm(credPath, { force: true })
        return
      }
      const tmp = `${credPath}.tmp`
      await fsp.writeFile(tmp, JSON.stringify({ torboxToken: torbox }), { mode: 0o600 })
      await fsp.rename(tmp, credPath)
    },
    async load() {
      try {
        const parsed = JSON.parse(await fsp.readFile(credPath, 'utf8')) as {
          torboxToken?: string
        }
        torbox = typeof parsed.torboxToken === 'string' ? parsed.torboxToken : ''
      } catch {
        torbox = ''
      }
    }
  }
}
