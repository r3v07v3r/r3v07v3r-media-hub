// Pairing: how a device becomes one this daemon will answer.
//
// The threat model is modest but real: anything on the LAN can see the
// mDNS announcement and reach the port, and a media cache that serves
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
//     it is throttled (per source address AND overall) and the pending
//     queue is capped (overall AND per source), or anyone on the LAN could
//     fill an admin's screen and this file's disk, or spend the minute's
//     budget of the person actually joining from their own machine.
//   - a code was single-use, which bounded how many devices one glance at
//     the console could admit. Approval bounds that directly instead.
//
// Which daemon a device is talking to is proven by TLS (tlsIdentity.ts,
// pinned by the app) and the join's verification code
// (shared/lancache/pairingProof.ts), which is stored here so the
// administrator can compare it with the one the joining device shows.
//
// Tokens: stored only as SHA-256 hashes (auth.json never holds a usable
// credential), expire LANCACHE_TOKEN_LIFETIME_MS after issue, are renewed
// by the app while it is in use, and can be revoked — by the device itself
// when it leaves, by the administrator from the app, or by the operator at
// the console (`r3-cache --devices` / `--revoke <id|all>`).

import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

import {
  LANCACHE_TOKEN_LIFETIME_MS,
  joinVerificationCode
} from '../src/shared/lancache/pairingProof'

export interface PairedDevice {
  /** Stable, non-secret identity — what credentials, jobs, items and the
   *  admin role are keyed by. Derived once from the device's FIRST token
   *  (deviceIdForToken) and kept across renewals, so a renewed token is
   *  still the same household member. */
  deviceId: string
  /** sha256(token), hex. The token itself is never persisted. */
  tokenHash: string
  deviceName: string
  createdAt: number
  /** When the current token was issued (joining, or the last renewal). */
  issuedAt: number
  /** After this the token is refused, approved or not. */
  expiresAt: number
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
   *  default applies. */
  quotaBytes?: number
  /** The six-digit code this daemon computed for the join (its own
   *  certificate, the token it issued, the app's nonce). The joining device
   *  shows the code IT computed; the administrator compares the two before
   *  approving. Absent for a join made without a nonce. */
  verification?: string
  /** The address the join request came from — what the per-source pending
   *  cap counts, and something the administrator can recognise. */
  source?: string
}

/** Approval state, resolving the absent-means-approved rule in ONE place so
 *  no caller has to remember it. */
export function isApproved(device: PairedDevice): boolean {
  return device.status !== 'pending'
}

export function isExpired(device: PairedDevice, now = Date.now()): boolean {
  return device.expiresAt <= now
}

interface AuthFile {
  version: 2
  devices: PairedDevice[]
}

/** Requests per minute from anywhere. Joining is a once-per-device act, so
 *  ten is generous for somebody setting up a household in one sitting and
 *  still bounds a flood. */
const MAX_REQUESTS_PER_MINUTE = 10
/** Requests per minute from one address. Below the overall budget, so one
 *  LAN host asking over and over cannot spend the minute of the person
 *  joining from their own machine. */
export const MAX_REQUESTS_PER_SOURCE_PER_MINUTE = 5

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
/** How many of those one address may hold. Without it a single host fills
 *  the whole queue in two minutes and nobody else can ask at all until the
 *  administrator clears it. */
export const MAX_PENDING_PER_SOURCE = 3

/** Stable, non-secret identity for a newly issued token — a hash of it, so
 *  the id can appear in job records and logs without ever exposing the
 *  credential it derives from. Only ever used at issue (and to migrate a
 *  pre-hashing auth.json); after that the id is stored on the device. */
export function deviceIdForToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16)
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

const TOKEN_HASH_RE = /^[a-f0-9]{64}$/
const DEVICE_ID_RE = /^[a-f0-9]{16}$/

export interface RenewResult {
  token: string
  expiresAt: number
}

export interface PairingOptions {
  /** The daemon's certificate fingerprint, for verification codes. Left out
   *  (the CLI, some tests) the daemon simply computes none. */
  fingerprint?: string
  /** Token lifetime. Tests shorten it; nothing else should. */
  tokenLifetimeMs?: number
  /** Per-source limits. Tests that run every device from 127.0.0.1 raise
   *  them; nothing else should. */
  perSourcePerMinute?: number
  pendingPerSource?: number
}

export interface Pairing {
  isAuthorized(token: string | undefined): boolean
  /** The device id for a presented (already-authorized) token, or ''. */
  deviceIdFor(token: string | undefined): string
  listDevices(): PairedDevice[]
  deviceIds(): Set<string>
  /** The unexpired device behind a token regardless of approval — what a
   *  pending device needs in order to ask whether it has been let in yet. */
  findByToken(token: string | undefined): PairedDevice | null
  /** Registers a device awaiting approval and returns its token, or null
   *  when the request is throttled or too many devices are already waiting.
   *  The token is real and authorises NOTHING until an admin approves it.
   *  `source` is the caller's address (per-source limits); `clientNonce` is
   *  the app's join nonce, from which the verification code is computed. */
  requestPairing(
    deviceName: string,
    options?: { source?: string; clientNonce?: string }
  ): Promise<string | null>
  /** Admin actions, addressed by device id rather than by token — the admin
   *  never sees another device's credential. */
  setStatus(deviceId: string, status: 'approved' | 'pending'): Promise<boolean>
  setQuota(deviceId: string, quotaBytes: number | null): Promise<boolean>
  removeDevice(deviceId: string): Promise<boolean>
  revoke(token: string): Promise<void>
  revokeAll(): Promise<number>
  /** Replaces a valid (unexpired) token with a fresh one for the same
   *  device; the old token stops working at once. */
  renew(token: string | undefined): Promise<RenewResult | null>
  /** Loads persisted devices. A pre-hashing auth.json (plaintext tokens) is
   *  rewritten with hashes; the count is returned for the log. */
  load(): Promise<{ migrated: number }>
  /** Re-reads auth.json when another process (the --revoke CLI) changed it. */
  reloadIfChanged(): Promise<boolean>
}

export function createPairing(dataDir: string, options: PairingOptions = {}): Pairing {
  const authPath = path.join(dataDir, 'auth.json')
  const lifetime = options.tokenLifetimeMs ?? LANCACHE_TOKEN_LIFETIME_MS
  const perSourcePerMinute = options.perSourcePerMinute ?? MAX_REQUESTS_PER_SOURCE_PER_MINUTE
  const pendingPerSource = options.pendingPerSource ?? MAX_PENDING_PER_SOURCE
  let devices: PairedDevice[] = []
  let attemptTimestamps: number[] = []
  const attemptsBySource = new Map<string, number[]>()
  /** auth.json's mtime as of our last read or write, for reloadIfChanged. */
  let knownMtimeMs = 0

  async function persist(): Promise<void> {
    const payload: AuthFile = { version: 2, devices }
    const tmp = `${authPath}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(payload), { mode: 0o600 })
    await fsp.rename(tmp, authPath)
    knownMtimeMs = await fsp
      .stat(authPath)
      .then((stat) => stat.mtimeMs)
      .catch(() => 0)
  }

  /** False when this attempt is over either the per-source or the overall
   *  per-minute budget. Records the attempt when it is allowed. */
  function admit(source: string, now: number): boolean {
    attemptTimestamps = attemptTimestamps.filter((at) => now - at < 60_000)
    for (const [key, times] of attemptsBySource) {
      const recent = times.filter((at) => now - at < 60_000)
      if (recent.length) attemptsBySource.set(key, recent)
      else attemptsBySource.delete(key)
    }
    const mine = attemptsBySource.get(source) ?? []
    if (mine.length >= perSourcePerMinute) return false
    if (attemptTimestamps.length >= MAX_REQUESTS_PER_MINUTE) return false
    mine.push(now)
    attemptsBySource.set(source, mine)
    attemptTimestamps.push(now)
    return true
  }

  /** Constant-time token lookup over the stored hashes. Factored out so
   *  every caller compares a credential the same way — a plain === here
   *  would be a timing oracle on the one secret this daemon has. Expired
   *  tokens match nothing. */
  function matchDevice(token: string | undefined): PairedDevice | null {
    if (!token || typeof token !== 'string') return null
    const presented = Buffer.from(hashToken(token), 'hex')
    let found: PairedDevice | null = null
    for (const device of devices) {
      const stored = Buffer.from(device.tokenHash, 'hex')
      if (stored.length !== presented.length) continue
      if (crypto.timingSafeEqual(stored, presented)) found = device
    }
    return found && !isExpired(found) ? found : null
  }

  function findById(deviceId: string): PairedDevice | undefined {
    if (!deviceId) return undefined
    return devices.find((device) => device.deviceId === deviceId)
  }

  /** One persisted record, or null when it is unusable. Accepts the
   *  pre-hashing shape ({token}) and converts it, keeping the device id the
   *  rest of the daemon already knows it by. */
  function normalize(
    raw: unknown,
    now: number
  ): { device: PairedDevice; migrated: boolean } | null {
    if (!raw || typeof raw !== 'object') return null
    const record = raw as Record<string, unknown>
    const base = {
      deviceName: String(record.deviceName ?? 'unnamed device').slice(0, 64),
      createdAt: Number(record.createdAt) || now,
      ...(record.status === 'pending' || record.status === 'approved'
        ? { status: record.status as 'pending' | 'approved' }
        : {}),
      ...(Number(record.approvedAt) > 0 ? { approvedAt: Number(record.approvedAt) } : {}),
      ...(typeof record.quotaBytes === 'number' && record.quotaBytes >= 0
        ? { quotaBytes: Math.floor(record.quotaBytes) }
        : {}),
      ...(typeof record.verification === 'string' && /^\d{6}$/.test(record.verification)
        ? { verification: record.verification }
        : {}),
      ...(typeof record.source === 'string' ? { source: record.source.slice(0, 64) } : {})
    }
    if (typeof record.tokenHash === 'string' && TOKEN_HASH_RE.test(record.tokenHash)) {
      const deviceId = String(record.deviceId ?? '')
      if (!DEVICE_ID_RE.test(deviceId)) return null
      return {
        device: {
          ...base,
          deviceId,
          tokenHash: record.tokenHash,
          issuedAt: Number(record.issuedAt) || base.createdAt,
          expiresAt: Number(record.expiresAt) || 0
        },
        migrated: false
      }
    }
    // Pre-hashing record: a plaintext token. Converted rather than dropped,
    // because dropping it would also strip the administrator of the role
    // and every member of their items. It gets a full lifetime from now.
    if (typeof record.token === 'string' && /^[a-f0-9]{64}$/.test(record.token)) {
      return {
        device: {
          ...base,
          deviceId: deviceIdForToken(record.token),
          tokenHash: hashToken(record.token),
          issuedAt: now,
          expiresAt: now + lifetime
        },
        migrated: true
      }
    }
    return null
  }

  async function readFromDisk(): Promise<{ migrated: number }> {
    const now = Date.now()
    let migrated = 0
    try {
      const [text, stat] = await Promise.all([fsp.readFile(authPath, 'utf8'), fsp.stat(authPath)])
      knownMtimeMs = stat.mtimeMs
      const parsed = JSON.parse(text) as { devices?: unknown }
      const next: PairedDevice[] = []
      if (Array.isArray(parsed.devices)) {
        for (const raw of parsed.devices) {
          const result = normalize(raw, now)
          if (!result) continue
          if (result.migrated) migrated++
          next.push(result.device)
        }
      }
      devices = next
    } catch {
      // First run — no devices yet.
      devices = []
    }
    // Never leave plaintext tokens on disk once they have been read.
    if (migrated) await persist()
    return { migrated }
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
      return matchDevice(token)?.deviceId ?? ''
    },
    async requestPairing(deviceName, requestOptions = {}) {
      const source = String(requestOptions.source ?? '').slice(0, 64)
      // The caps are checked first, and without spending an attempt: a
      // device arriving at a full queue was refused by the queue, and
      // charging it for the rate limit as well would make the two
      // indistinguishable.
      const waiting = devices.filter((device) => !isApproved(device))
      if (waiting.length >= MAX_PENDING_DEVICES) return null
      const waitingHere = waiting.filter((device) => (device.source ?? '') === source).length
      if (waitingHere >= pendingPerSource) return null
      const now = Date.now()
      if (!admit(source, now)) return null
      const token = crypto.randomBytes(32).toString('hex')
      const verification = joinVerificationCode(
        options.fingerprint ?? '',
        token,
        String(requestOptions.clientNonce ?? '')
      )
      devices.push({
        deviceId: deviceIdForToken(token),
        tokenHash: hashToken(token),
        deviceName: String(deviceName || 'unnamed device').slice(0, 64),
        createdAt: now,
        issuedAt: now,
        expiresAt: now + lifetime,
        status: 'pending',
        ...(verification ? { verification } : {}),
        ...(source ? { source } : {})
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
      devices = devices.filter((device) => device.deviceId !== deviceId)
      if (devices.length === before) return false
      await persist()
      return true
    },
    listDevices: () => [...devices],
    deviceIds: () => new Set(devices.map((device) => device.deviceId)),
    async revoke(token) {
      const device = matchDevice(token)
      if (!device) return
      devices = devices.filter((candidate) => candidate !== device)
      await persist()
    },
    async revokeAll() {
      const count = devices.length
      devices = []
      await persist()
      return count
    },
    async renew(token) {
      const device = matchDevice(token)
      if (!device) return null
      const fresh = crypto.randomBytes(32).toString('hex')
      const now = Date.now()
      device.tokenHash = hashToken(fresh)
      device.issuedAt = now
      device.expiresAt = now + lifetime
      await persist()
      return { token: fresh, expiresAt: device.expiresAt }
    },
    load: readFromDisk,
    async reloadIfChanged() {
      const mtime = await fsp
        .stat(authPath)
        .then((stat) => stat.mtimeMs)
        .catch(() => 0)
      if (mtime === knownMtimeMs) return false
      await readFromDisk()
      return true
    }
  }
}
