// Per-device TorBox tokens — the multi-user rule made concrete.
//
// One daemon serves a household, but a download bills SOMEBODY's debrid
// account, so every credential is keyed by the paired device that opted it
// in, and a job is always fetched with its OWNER's token — never "whatever
// token the daemon happens to hold". A person who never ticks the checkbox
// contributes no credential and their jobs simply wait (or complete when
// the same title is wanted by someone who did).
//
// Stored as a 0600 file. Stated plainly rather than dressed up: a headless
// Linux box has no OS keychain, so file permissions ARE the protection
// here, and the app says so in the UI at the moment the person opts in.
// Revocation is deletion (POST an empty token) and happens automatically
// on unpair.

import fsp from 'node:fs/promises'
import path from 'node:path'

export interface Credentials {
  /** The TorBox token the given device shared, or ''. */
  tokenForDevice(deviceId: string): string
  setTokenForDevice(deviceId: string, token: string): Promise<void>
  /** Whether ANY device has shared a credential — status/display only;
   *  fetching always goes through tokenForDevice. */
  linkedDeviceCount(): number
  load(): Promise<void>
}

interface CredentialsFile {
  /** deviceId -> TorBox token. The id is a hash of the pairing token
   *  (pairing.ts's deviceIdForToken), so this file never maps one secret
   *  to another secret's plain value. */
  byDevice: Record<string, string>
}

export function createCredentials(dataDir: string): Credentials {
  const credPath = path.join(dataDir, 'credentials.json')
  let byDevice: Record<string, string> = {}

  async function persist(): Promise<void> {
    if (!Object.keys(byDevice).length) {
      await fsp.rm(credPath, { force: true })
      return
    }
    const payload: CredentialsFile = { byDevice }
    const tmp = `${credPath}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(payload), { mode: 0o600 })
    await fsp.rename(tmp, credPath)
  }

  return {
    tokenForDevice(deviceId) {
      return deviceId ? (byDevice[deviceId] ?? '') : ''
    },
    async setTokenForDevice(deviceId, token) {
      if (!deviceId) return
      const trimmed = String(token || '').trim()
      if (trimmed) byDevice[deviceId] = trimmed
      else delete byDevice[deviceId]
      await persist()
    },
    linkedDeviceCount() {
      return Object.keys(byDevice).length
    },
    async load() {
      try {
        const parsed = JSON.parse(await fsp.readFile(credPath, 'utf8')) as Partial<CredentialsFile>
        byDevice =
          parsed.byDevice && typeof parsed.byDevice === 'object'
            ? Object.fromEntries(
                Object.entries(parsed.byDevice).filter(
                  ([, value]) => typeof value === 'string' && value
                )
              )
            : {}
        // A pre-multi-user file ({torboxToken: ...}) has no owner to
        // attribute the credential to, so it is deliberately NOT migrated:
        // guessing an owner would bill the wrong account. The person
        // re-ticks the checkbox once.
      } catch {
        byDevice = {}
      }
    }
  }
}
