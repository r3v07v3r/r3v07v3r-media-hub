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

interface PairedDevice {
  token: string
  deviceName: string
  createdAt: number
}

interface AuthFile {
  devices: PairedDevice[]
}

const MAX_ATTEMPTS_PER_MINUTE = 5
const FAILURES_BEFORE_NEW_CODE = 10

export interface Pairing {
  /** The code to print on the console / show on /api/ping'd displays.
   *  Regenerated after success or repeated failure — always read it fresh. */
  currentCode(): string
  /** Exchange a code for a bearer token, or null (wrong code / throttled). */
  tryPair(code: string, deviceName: string): Promise<string | null>
  isAuthorized(token: string | undefined): boolean
  listDevices(): PairedDevice[]
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
      if (!token) return false
      return devices.some(
        (device) =>
          device.token.length === token.length &&
          crypto.timingSafeEqual(Buffer.from(device.token), Buffer.from(token))
      )
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
