// Pairing: how a device becomes one this daemon will answer.
//
// The threat model is modest but real: anything on the LAN can see the
// mDNS announcement and reach the HTTP port, and a media cache that serves
// whoever asks — or accepts download jobs from whoever asks — is wrong.
//
// THE SIX-DIGIT CODE IS GONE. It proved the person at the app could see
// the daemon's console, which was a real authority and a genuinely awkward
// one: it meant walking to the machine, or reading a log off a headless box
// nobody has a screen for. Approval replaces it with a better answer to the
// same question — the person who already owns this server says yes — and
// the code could only come out once approval was provably working, which is
// why this is the last stage of that work rather than the first.
//
// What replaces the code's protections:
//   - a 6-digit space was brute-forceable, so attempts were throttled and
//     the code rotated. Asking to join is no longer a guess, so there is
//     nothing to brute-force — but the REQUEST is now unauthenticated, so
//     it is throttled and the pending queue is capped, or anyone on the LAN
//     could fill an admin's screen and this file's disk.
//   - a code was single-use, which bounded how many devices one glance at
//     the console could admit. Approval bounds that directly instead.
//
// Issued bearer tokens are long-lived and persisted (0600) — joining is
// once per device, not per session.

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

/** Requests per minute from anywhere. Joining is a once-per-device act, so
 *  ten is generous for somebody setting up a household in one sitting and
 *  still bounds a flood. */
const MAX_REQUESTS_PER_MINUTE = 10

/** How many devices may sit unapproved at once. Past this the daemon says
 *  no until the administrator clears some: an unbounded queue is a way for
 *  anyone on the network to fill an admin's screen and this file's disk,
 *  and 'ask again later' is a much better failure than either.
 *
 *  Deliberately BELOW the per-minute allowance, so the two limits are
 *  independently reachable — a cap that could only be hit after the rate
 *  limit had already refused everything would be a rule nobody could
 *  observe, in either a test or the real world. */
const MAX_PENDING_DEVICES = 8

/** Stable, non-secret identity for a paired device — what credentials and
 *  jobs are keyed by. A hash of the bearer token rather than the token
 *  itself, so the id can appear in job records and logs without ever
 *  exposing the credential it derives from. */
export function deviceIdForToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16)
}

export interface Pairing {
  isAuthorized(token: string | undefined): boolean
  /** The device id for a presented (already-authorized) token, or ''. */
  deviceIdFor(token: string | undefined): string
  listDevices(): PairedDevice[]
  /** The device behind a token regardless of approval — what a pending
   *  device needs in order to ask whether it has been let in yet. */
  findByToken(token: string | undefined): PairedDevice | null
  /** Registers a device awaiting approval and returns its token, or null
   *  when the request is throttled or too many devices are already waiting.
   *  The token is real and authorises NOTHING until an admin approves it. */
  requestPairing(deviceName: string): Promise<string | null>
  /** Admin actions, addressed by device id rather than by token — the admin
   *  never sees another device's credential. */
  setStatus(deviceId: string, status: 'approved' | 'pending'): Promise<boolean>
  setQuota(deviceId: string, quotaBytes: number | null): Promise<boolean>
  removeDevice(deviceId: string): Promise<boolean>
  revoke(token: string): Promise<void>
  /** Called once at startup to load persisted devices. */
  load(): Promise<void>
}

export function createPairing(dataDir: string): Pairing {
  const authPath = path.join(dataDir, 'auth.json')
  let devices: PairedDevice[] = []
  let attemptTimestamps: number[] = []
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
      // The cap is checked first, and without spending an attempt: a device
      // arriving at a full queue was refused by the queue, and charging it
      // for the rate limit as well would make the two indistinguishable.
      if (devices.filter((device) => !isApproved(device)).length >= MAX_PENDING_DEVICES) {
        return null
      }
      const now = Date.now()
      attemptTimestamps = attemptTimestamps.filter((at) => now - at < 60_000)
      if (attemptTimestamps.length >= MAX_REQUESTS_PER_MINUTE) return null
      attemptTimestamps.push(now)
      const token = crypto.randomBytes(32).toString('hex')
      devices.push({
        token,
        deviceName: String(deviceName || 'unnamed device').slice(0, 64),
        createdAt: now,
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
    }
  }
}
