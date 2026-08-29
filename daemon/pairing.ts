// Pairing: the one-time handshake that turns "a daemon on the network"
// into "MY daemon".
//
// The threat model is modest but real: anything on the LAN can see the
// mDNS announcement and reach the HTTP port, and a media cache that serves
// whoever asks — or accepts download jobs from whoever asks — is wrong.
// A 6-digit code displayed where the daemon runs proves the person at the
// app can see the daemon's console, which is exactly the authority that
// should grant access.
//
// A 6-digit space is brute-forceable at network speed, so the code is not
// enough on its own: attempts are throttled, and the code is REPLACED
// after a burst of failures or a success. Issued bearer tokens are
// long-lived and persisted (0600) — pairing is once per device, not per
// session.

import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

export interface PairedDevice {
  token: string
  deviceName: string
  createdAt: number
  /**
   * 'approved' — may use the server. 'pending' — holds a token and can do
   * nothing but ask whether it has been let in yet.
   *
   * ABSENT MEANS APPROVED, and this is the one place in this feature where
   * absence reads permissively rather than restrictively. Devices that
   * paired before approval existed did so by presenting the code off the
   * console, which was the authority at the time. Treating them as pending
   * would lock working devices out of a daemon their owner already runs —
   * a regression dressed as a security improvement.
   */
  status?: 'pending' | 'approved'
  approvedAt?: number
  /** Per-device allocation, set by the admin. Unset means the server-wide
   *  default applies — see A4; nothing enforces this yet. */
  quotaBytes?: number
}

/** Approval state, resolving the absent-means-approved rule in ONE place so
 *  no caller has to remember it. */
export function isApproved(device: PairedDevice): boolean {
  return device.status !== 'pending'
}

interface AuthFile {
  devices: PairedDevice[]
}

const MAX_ATTEMPTS_PER_MINUTE = 5
const FAILURES_BEFORE_NEW_CODE = 10

/** Stable, non-secret identity for a paired device — what credentials and
 *  jobs are keyed by. A hash of the bearer token rather than the token
 *  itself, so the id can appear in job records and logs without ever
 *  exposing the credential it derives from. */
export function deviceIdForToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16)
}

export interface Pairing {
  /** The code to print on the console / show on /api/ping'd displays.
   *  Regenerated after success or repeated failure — always read it fresh. */
  currentCode(): string
  /** Exchange a code for a bearer token, or null (wrong code / throttled). */
  tryPair(code: string, deviceName: string): Promise<string | null>
  isAuthorized(token: string | undefined): boolean
  /** The device id for a presented (already-authorized) token, or ''. */
  deviceIdFor(token: string | undefined): string
  listDevices(): PairedDevice[]
  /** The device behind a token regardless of approval — what a pending
   *  device needs in order to ask whether it has been let in yet. */
  findByToken(token: string | undefined): PairedDevice | null
  /** Registers a device awaiting approval and returns its token. The token
   *  is real and authorises NOTHING until an admin approves it. */
  requestPairing(deviceName: string): Promise<string>
  /** Admin actions, addressed by device id rather than by token — the admin
   *  never sees another device's credential. */
  setStatus(deviceId: string, status: 'approved' | 'pending'): Promise<boolean>
  setQuota(deviceId: string, quotaBytes: number | null): Promise<boolean>
  removeDevice(deviceId: string): Promise<boolean>
  revoke(token: string): Promise<void>
  /** Called once at startup to load persisted devices. */
  load(): Promise<void>
  /** Fires when the code changes, so the console banner can reprint it. */
  onCodeChange(listener: (code: string) => void): void
}

function newCode(): string {
  // crypto-random, zero-padded, never Math.random.
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
}

export function createPairing(dataDir: string): Pairing {
  const authPath = path.join(dataDir, 'auth.json')
  let devices: PairedDevice[] = []
  let code = newCode()
  let failures = 0
  let attemptTimestamps: number[] = []
  const listeners: Array<(code: string) => void> = []

  function rotateCode(): void {
    code = newCode()
    failures = 0
    for (const listener of listeners) listener(code)
  }

  async function persist(): Promise<void> {
    const payload: AuthFile = { devices }
    const tmp = `${authPath}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(payload), { mode: 0o600 })
    await fsp.rename(tmp, authPath)
  }

  /** Constant-time token lookup. Factored out so every caller compares a
   *  credential the same way — a plain === here would be a timing oracle on
   *  the one secret this daemon has. */
  function matchDevice(token: string | undefined): PairedDevice | null {
    if (!token) return null
    for (const device of devices) {
      if (device.token.length !== token.length) continue
      if (crypto.timingSafeEqual(Buffer.from(device.token), Buffer.from(token))) return device
    }
    return null
  }

  function findById(deviceId: string): PairedDevice | undefined {
    if (!deviceId) return undefined
    return devices.find((device) => deviceIdForToken(device.token) === deviceId)
  }

  return {
    currentCode: () => code,
    async tryPair(candidate, deviceName) {
      const now = Date.now()
      attemptTimestamps = attemptTimestamps.filter((at) => now - at < 60_000)
      if (attemptTimestamps.length >= MAX_ATTEMPTS_PER_MINUTE) return null
      attemptTimestamps.push(now)

      // timingSafeEqual over same-length buffers — a 6-digit code is small
      // enough that a comparison-time oracle would actually help a guesser.
      const a = Buffer.from(String(candidate).padStart(6, '0'))
      const b = Buffer.from(code)
      const match = a.length === b.length && crypto.timingSafeEqual(a, b)
      if (!match) {
        failures += 1
        if (failures >= FAILURES_BEFORE_NEW_CODE) rotateCode()
        return null
      }

      const token = crypto.randomBytes(32).toString('hex')
      devices.push({
        token,
        deviceName: String(deviceName || 'unnamed device').slice(0, 64),
        createdAt: now
      })
      await persist()
      // A code is single-use: pairing succeeded, so the next pairing needs
      // a fresh one read off the console again.
      rotateCode()
      return token
    },
    isAuthorized(token) {
      // A PENDING device holds a real token and is not authorised for
      // anything. Holding a token is the result of asking to join; being
      // approved is the result of somebody saying yes.
      const device = matchDevice(token)
      return Boolean(device && isApproved(device))
    },
    findByToken(token) {
      return matchDevice(token)
    },
    deviceIdFor(token) {
      const matched = matchDevice(token)
      return matched ? deviceIdForToken(matched.token) : ''
    },
    async requestPairing(deviceName) {
      const token = crypto.randomBytes(32).toString('hex')
      devices.push({
        token,
        deviceName: String(deviceName || 'unnamed device').slice(0, 64),
        createdAt: Date.now(),
        status: 'pending'
      })
      await persist()
      return token
    },
    async setStatus(deviceId, status) {
      const device = findById(deviceId)
      if (!device) return false
      device.status = status
      if (status === 'approved') device.approvedAt = Date.now()
      await persist()
      return true
    },
    async setQuota(deviceId, quotaBytes) {
      const device = findById(deviceId)
      if (!device) return false
      // null clears it back to the server default rather than storing a
      // zero, which would read as 'allowed nothing'.
      if (quotaBytes === null) delete device.quotaBytes
      else device.quotaBytes = Math.max(0, Math.floor(quotaBytes))
      await persist()
      return true
    },
    async removeDevice(deviceId) {
      const before = devices.length
      devices = devices.filter((device) => deviceIdForToken(device.token) !== deviceId)
      if (devices.length === before) return false
      await persist()
      return true
    },
    listDevices: () => [...devices],
    async revoke(token) {
      devices = devices.filter((device) => device.token !== token)
      await persist()
    },
    async load() {
      try {
        const parsed = JSON.parse(await fsp.readFile(authPath, 'utf8')) as AuthFile
        if (Array.isArray(parsed.devices)) {
          devices = parsed.devices.filter(
            (device) => typeof device.token === 'string' && device.token.length === 64
          )
        }
      } catch {
        // First run — no devices yet.
      }
    },
    onCodeChange(listener) {
      listeners.push(listener)
    }
  }
}
