// Who administers this cache server.
//
// One device holds it. The admin configures sharing, the disk budget and
// each person's allocation — and, once device approval replaces the pairing
// code, decides who may join at all.
//
// WHAT ADMIN IS NOT. It is not a key to other people's libraries. The admin
// also has a shell on this box and can read every file on it, so an
// interface implying they cannot would simply be lying. Admin gets service
// settings, aggregate usage, the device list and the ability to revoke a
// device. There is deliberately no "browse everyone's items" capability
// here, and adding one later should be an argued decision, not a
// convenience.
//
// THE CLAIM BOUND. Pure first-come is the obvious design and the wrong one:
// this daemon is advertised over mDNS and built to run at boot on a box
// nobody looks at, so "the first person to connect" a week after install is
// not necessarily the person who installed it. So claiming is open only
// while unclaimed, the daemon says loudly that it is unclaimed, and the
// console — the one authority that cannot be taken remotely on a box you
// physically control — can always reopen it.

import fsp from 'node:fs/promises'
import path from 'node:path'

interface AdminFile {
  /** Device id (see pairing's deviceIdForToken) that claimed this server,
   *  or '' while unclaimed. Not the token: this file is read to answer
   *  "are you the admin", and it should never hold a credential. */
  adminDeviceId: string
  claimedAt: number
  /** Set by --claim-admin. Lets the next claim through even though one has
   *  already happened, then clears itself, so recovery is a deliberate act
   *  at the console rather than a standing hole. */
  reopened?: boolean
}

export interface Admin {
  /** True while nobody has claimed this server — what /api/ping reports so
   *  an app that discovers the daemon can offer the button prominently. */
  isUnclaimed(): boolean
  isAdmin(deviceId: string): boolean
  /** The claiming device, or '' while unclaimed. */
  adminDeviceId(): string
  /** Claims the server for a device. Succeeds only while unclaimed (or
   *  while the console has reopened claiming), and is the ONLY way to
   *  become admin over the network. */
  claim(deviceId: string): Promise<boolean>
  /** Console recovery: allows one further claim. */
  reopen(): Promise<void>
  load(): Promise<void>
}

export function createAdmin(dataDir: string): Admin {
  const adminPath = path.join(dataDir, 'admin.json')
  let state: AdminFile = { adminDeviceId: '', claimedAt: 0 }

  async function persist(): Promise<void> {
    // 0600 and atomic, matching pairing.ts — this decides who administers
    // the box, so it should not be world-readable and must never be
    // observed half-written.
    const tmp = `${adminPath}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(state), { mode: 0o600 })
    await fsp.rename(tmp, adminPath)
  }

  return {
    isUnclaimed() {
      return !state.adminDeviceId || state.reopened === true
    },
    isAdmin(deviceId) {
      // An empty deviceId is what deviceIdFor returns for an unknown token.
      // Without this guard an unclaimed server would call every stranger its
      // administrator, which is the opposite of the intended default.
      if (!deviceId) return false
      return state.adminDeviceId === deviceId
    },
    adminDeviceId() {
      return state.adminDeviceId
    },
    async claim(deviceId) {
      if (!deviceId) return false
      // Re-claiming by the device that already holds it is a no-op success,
      // so a retried request cannot fail confusingly.
      if (state.adminDeviceId === deviceId) return true
      if (state.adminDeviceId && state.reopened !== true) return false
      state = { adminDeviceId: deviceId, claimedAt: Date.now() }
      await persist()
      return true
    },
    async reopen() {
      state = { ...state, reopened: true }
      await persist()
    },
    async load() {
      try {
        const parsed = JSON.parse(await fsp.readFile(adminPath, 'utf8')) as AdminFile
        state = {
          adminDeviceId: String(parsed.adminDeviceId ?? ''),
          claimedAt: Number(parsed.claimedAt) || 0,
          ...(parsed.reopened === true ? { reopened: true } : {})
        }
      } catch {
        // No file yet: unclaimed, which is the correct starting state for a
        // freshly installed daemon.
      }
    }
  }
}
