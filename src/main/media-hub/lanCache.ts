// The app's client for a paired r3-cache daemon — tier 2 of the source
// order, between "already on this disk" and "on the Jellyfin server".
//
// Every call is best-effort by the same contract as mediaSources.ts: a
// daemon that is off, unreachable or mid-update degrades to "the tier
// contributes nothing", never to a playback error. The daemon is an
// optimisation the household added, not a dependency the app acquired.

import os from 'node:os'

import type {
  LanCacheCatalogResponse,
  LanCacheDevicesResponse,
  LanCacheOwnItem,
  LanCachePairResponse,
  LanCachePingResponse,
  LanCacheJobPayload,
  LanCacheStatusResponse
} from '../../shared/lancache/protocol'
import type { StreamCandidate } from '../../shared/media-hub/types'
import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import { fetchJson } from './httpClient'
import { handle } from './ipcGuard'
import { logError } from './logger'
import {
  clearLanCacheConnection,
  getLanCacheConnection,
  getTorBoxToken,
  setLanCacheConnection
} from './settingsStore'
import { discoverLanCaches } from './lanCacheDiscovery'

function request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const connection = getLanCacheConnection()
  if (!connection) throw new Error('No cache server is paired.')
  return fetchJson<T>(
    `${connection.url}${pathname}`,
    {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${connection.token}`
      }
    },
    { lane: 'lancache', label: 'cache server' }
  )
}

/**
 * Whether there is a cache server this app may actually USE.
 *
 * A pending connection is deliberately false here. Its token is real but
 * authorises nothing until the server's administrator approves it, so
 * every source lookup and stream through it would 401 — and a tier that
 * fails on every call is worse than a tier that is switched off, because
 * it costs a round-trip per playback to learn the same thing.
 */
export function isLanCacheConnected(): boolean {
  const connection = getLanCacheConnection()
  return Boolean(connection && !connection.pending)
}

/** For resolve-cache keys — same rationale as jellyfinFingerprint: the URL
 *  is enough to invalidate on re-pointing, and the token never lands in a
 *  persisted key. */
export function lanCacheFingerprint(): string {
  return getLanCacheConnection()?.url ?? 'off'
}

/**
 * Tier 2 lookup: does the paired daemon hold this title, complete?
 *
 * One LAN round-trip; in-flight and tombstoned items deliberately do NOT
 * produce a candidate — a half-fetched file cannot be played (the daemon
 * 404s incomplete items on /stream), and playback has other tiers.
 */
export async function findLanCacheCandidate(contentKey: string): Promise<StreamCandidate | null> {
  if (!contentKey || !isLanCacheConnected()) return null
  try {
    const catalog = await request<LanCacheCatalogResponse>(
      `/api/catalog?keys=${encodeURIComponent(contentKey)}`
    )
    const item = catalog.items.find((entry) => entry.contentKey === contentKey && entry.complete)
    if (!item) return null
    return {
      source: 'lancache',
      infoHash: item.infoHash,
      name: item.title,
      title: item.title,
      resolution: item.resolution,
      sizeBytes: item.sizeBytes,
      cached: true,
      compatible: true,
      exact: true
    }
  } catch {
    // Unreachable daemon = tier contributes nothing.
    return null
  }
}

/** The URL the player opens. Token in the query — mpv cannot send headers;
 *  identical pattern (and identical logging caution) to Jellyfin's api_key. */
export function lanCacheStreamUrl(candidate: StreamCandidate): string | null {
  const connection = getLanCacheConnection()
  if (!connection || candidate.source !== 'lancache' || !candidate.infoHash) return null
  return `${connection.url}/stream/${candidate.infoHash}?token=${encodeURIComponent(connection.token)}`
}

export async function queueLanCacheJob(payload: LanCacheJobPayload): Promise<boolean> {
  try {
    await request('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return true
  } catch (error) {
    logError('lancache:queue', error)
    return false
  }
}

export async function lanCacheCatalog(keys: string[]): Promise<LanCacheCatalogResponse | null> {
  if (!isLanCacheConnected()) return null
  try {
    const query = keys.length ? `?keys=${encodeURIComponent(keys.join(','))}` : ''
    return await request<LanCacheCatalogResponse>(`/api/catalog${query}`)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Waiting to be let in.
//
// Approval happens on somebody else's machine, at a time nobody here
// controls, and the thing it unblocks is the whole cache TIER — not a piece
// of UI. So the wait is owned by the main process rather than by whichever
// panel happens to be on screen.
//
// It used to be owned by the control centre's Caching section, which meant
// approval was only ever noticed while that section was open: a person who
// asked to join from Settings and closed the panel stayed pending forever,
// with a cache server that had already said yes.

/** How often the main process asks. Slower than the panel's own poll, which
 *  exists to make the transition feel immediate while somebody is watching
 *  it; this one is the part that has to work when nobody is. */
const APPROVAL_POLL_MS = 30_000

let approvalTimer: NodeJS.Timeout | null = null

/**
 * Asks whether a pending device has been approved, and promotes it if so.
 *
 * The single place that transition happens — the timer below and the
 * renderer's own poll both come through here, so the two cannot promote a
 * connection differently.
 */
async function promoteIfApproved(): Promise<'none' | 'pending' | 'approved'> {
  const connection = getLanCacheConnection()
  if (!connection) return 'none'
  if (!connection.pending) return 'approved'
  // Deliberately NOT through request(): this is the one call a pending token
  // is allowed to make, and routing it past the guard that refuses
  // everything else keeps that exception visible.
  const answer = await fetchJson<{ status?: string; serverName?: string }>(
    `${connection.url}/api/pair/status`,
    { headers: { Authorization: `Bearer ${connection.token}` } },
    { lane: 'lancache', label: 'cache server' }
  )
  if (answer.status !== 'approved') return 'pending'

  setLanCacheConnection({
    url: connection.url,
    name: answer.serverName ?? connection.name,
    token: connection.token
  })
  // Approval is what actually grants the player access to this LAN host, so
  // the trusted-host list is refreshed HERE — the moment that now carries
  // the authority pairing used to.
  refreshTrustedHostsRef?.()

  // And the opt-in the person made when they asked, which could not be
  // honoured then because a pending token authorises nothing. Sent once;
  // the flag is already gone from the connection written above, so a later
  // call cannot re-send it.
  if (connection.shareTorbox) {
    const torboxToken = getTorBoxToken()
    if (torboxToken) {
      await request('/api/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ torboxToken })
      }).catch((error) => logError('lancache:credentials', error))
    }
  }
  return 'approved'
}

/** Runs the wait while, and only while, there is something to wait for. */
function syncApprovalPolling(): void {
  const connection = getLanCacheConnection()
  const wanted = Boolean(connection?.pending)
  if (wanted && !approvalTimer) {
    approvalTimer = setInterval(() => {
      void promoteIfApproved()
        .then((state) => {
          if (state !== 'pending') syncApprovalPolling()
        })
        // A daemon that is off or unreachable is the ordinary case while
        // waiting — somebody has to walk to it. Keep asking.
        .catch(() => {})
    }, APPROVAL_POLL_MS)
    // Never a reason to hold the process open.
    approvalTimer.unref?.()
  } else if (!wanted && approvalTimer) {
    clearInterval(approvalTimer)
    approvalTimer = null
  }
}

/** Set once at registration. Module-level because promoteIfApproved runs
 *  from a timer, outside any IPC call that could carry it. */
let refreshTrustedHostsRef: (() => void) | null = null

// ---------------------------------------------------------------------------
// IPC: discovery, pairing, status — the Settings pane's surface.

interface DeviceActionPayload {
  id: string
  action: 'approve' | 'deny' | 'revoke' | 'quota'
  /** For 'quota' only. null clears it back to the server default. */
  quotaBytes?: number | null
}

interface PairPayload {
  url: string

  /** The explicit opt-in: copy the TorBox token to the daemon so it can
   *  fetch overnight with no app running. Never implied. */
  shareTorboxToken?: boolean
}

export function registerLanCacheIpc(refreshTrustedHosts: () => void): void {
  refreshTrustedHostsRef = refreshTrustedHosts
  // A device can be left waiting across a restart, so the wait resumes at
  // startup rather than only after somebody opens the panel again.
  syncApprovalPolling()

  handle(MEDIA_HUB_CHANNELS.lanCacheDiscover, async () => {
    const found = await discoverLanCaches()
    return { daemons: found, paired: getLanCacheConnection()?.url ?? null }
  })

  handle<PairPayload, { ok: boolean; message: string; pending?: boolean }>(
    MEDIA_HUB_CHANNELS.lanCachePair,
    async (_event, payload) => {
      const url = String(payload?.url || '')
        .trim()
        .replace(/\/+$/, '')
      if (!/^https?:\/\//.test(url)) return { ok: false, message: 'Enter the server URL.' }
      try {
        // Identity check first: refuse to ask to join something
        // that is not an r3-cache daemon at all.
        const ping = await fetchJson<LanCachePingResponse>(
          `${url}/api/ping`,
          {},
          { lane: 'lancache', label: 'cache server' }
        )
        if (ping.product !== 'r3-cache') {
          return { ok: false, message: 'That server is not an r3-cache daemon.' }
        }
        const paired = await fetchJson<LanCachePairResponse>(
          `${url}/api/pair`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // The device NAME is sent either way: it is what the server's
            // administrator sees in the approval list, so an unnamed
            // request is one nobody can sensibly say yes to.
            body: JSON.stringify({ deviceName: os.hostname() })
          },
          { lane: 'lancache', label: 'cache server' }
        )
        if (!paired.token) {
          // The daemon refuses a request when too many devices are already
          // waiting, or when they are arriving too fast. Both are temporary
          // and neither is about this device, so the wording says to try
          // again rather than suggesting something is wrong here.
          return {
            ok: false,
            message: 'The cache server is not taking requests right now. Try again shortly.'
          }
        }
        const pending = paired.status === 'pending'
        setLanCacheConnection({
          url,
          name: paired.serverName ?? ping.serverName,
          token: paired.token,
          ...(pending ? { pending: true } : {}),
          // The opt-in is KEPT rather than acted on while pending: a pending
          // token authorises nothing, so posting the credential now would
          // simply be refused. promoteIfApproved sends it the moment
          // approval lands.
          ...(pending && payload?.shareTorboxToken ? { shareTorbox: true } : {})
        })
        if (pending) {
          // Nothing is granted yet — not the trusted-host entry, and not the
          // TorBox copy below. Both wait for approval, which is the point of
          // asking. The wait itself belongs to the main process, so it runs
          // whether or not any panel is open to watch it.
          syncApprovalPolling()
          return {
            ok: true,
            pending: true,
            message: `Waiting for ${paired.serverName ?? 'the cache server'}'s administrator to approve this device.`
          }
        }
        // Pairing is what grants the player access to this LAN host.
        refreshTrustedHosts()

        if (payload?.shareTorboxToken) {
          const torboxToken = getTorBoxToken()
          if (torboxToken) {
            await request('/api/credentials', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ torboxToken })
            }).catch((error) => logError('lancache:credentials', error))
          }
        }
        return { ok: true, message: `Paired with ${paired.serverName ?? 'the cache server'}.` }
      } catch (error) {
        return { ok: false, message: (error as Error).message }
      }
    }
  )

  handle(MEDIA_HUB_CHANNELS.lanCacheUnpair, async () => {
    // Best-effort credential revocation on the daemon before forgetting it.
    if (isLanCacheConnected()) {
      await request('/api/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ torboxToken: '' })
      }).catch(() => {})
    }
    clearLanCacheConnection()
    refreshTrustedHosts()
    // Nothing left to wait for.
    syncApprovalPolling()
    return { ok: true }
  })

  handle(MEDIA_HUB_CHANNELS.lanCacheStatus, async () => {
    if (!isLanCacheConnected()) return { connected: false as const }
    try {
      const status = await request<LanCacheStatusResponse>('/api/status')
      return { connected: true as const, status }
    } catch (error) {
      return { connected: true as const, error: (error as Error).message }
    }
  })

  // --- pending pairing, and the server's own administration ---------------
  //
  // Pairing no longer necessarily ends in access. A codeless request gets a
  // real token that authorises nothing until the server's administrator
  // approves it, so the app stores the connection as PENDING and polls.
  // Everything below is the surface a control centre needs to run that.

  handle(MEDIA_HUB_CHANNELS.lanCachePairStatus, async () => {
    const connection = getLanCacheConnection()
    if (!connection) return { state: 'none' as const }
    try {
      // Through the same promotion path the timer uses, so a panel watching
      // this cannot end up with a connection promoted differently from one
      // the background wait promoted.
      const state = await promoteIfApproved()
      syncApprovalPolling()
      return { state, name: getLanCacheConnection()?.name ?? connection.name }
    } catch (error) {
      return { state: 'pending' as const, name: connection.name, error: (error as Error).message }
    }
  })

  handle<void, { ok: boolean; message: string }>(MEDIA_HUB_CHANNELS.lanCacheClaim, async () => {
    if (!isLanCacheConnected()) return { ok: false, message: 'No cache server is paired.' }
    try {
      await request('/api/admin/claim', { method: 'POST' })
      return { ok: true, message: 'You administer this cache server.' }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  })

  handle(MEDIA_HUB_CHANNELS.lanCacheDevices, async () => {
    if (!isLanCacheConnected()) return { ok: false as const, message: 'No cache server is paired.' }
    try {
      return { ok: true as const, ...(await request<LanCacheDevicesResponse>('/api/admin/devices')) }
    } catch (error) {
      return { ok: false as const, message: (error as Error).message }
    }
  })

  handle<DeviceActionPayload, { ok: boolean; message?: string }>(
    MEDIA_HUB_CHANNELS.lanCacheDeviceAction,
    async (_event, payload) => {
      // Validated here rather than passed through: the renderer is the least
      // trusted caller in this process, and the daemon's route is addressed
      // by an id that goes straight into a URL.
      const id = String(payload?.id ?? '')
      if (!/^[a-f0-9]{16}$/.test(id)) return { ok: false, message: 'Unknown device.' }
      const action = payload?.action
      if (action !== 'approve' && action !== 'deny' && action !== 'revoke' && action !== 'quota') {
        return { ok: false, message: 'Unknown action.' }
      }
      try {
        await request(`/api/admin/devices/${id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action,
            ...(action === 'quota'
              ? { quotaBytes: payload?.quotaBytes ?? null }
              : {})
          })
        })
        return { ok: true }
      } catch (error) {
        return { ok: false, message: (error as Error).message }
      }
    }
  )

  handle<{ openJoin?: boolean; defaultQuotaPercent?: number }, { ok: boolean; message?: string }>(
    MEDIA_HUB_CHANNELS.lanCacheAdminSettings,
    async (_event, payload) => {
      try {
        await request('/api/admin/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(typeof payload?.openJoin === 'boolean' ? { openJoin: payload.openJoin } : {}),
            ...(typeof payload?.defaultQuotaPercent === 'number'
              ? { defaultQuotaPercent: payload.defaultQuotaPercent }
              : {})
          })
        })
        return { ok: true }
      } catch (error) {
        return { ok: false, message: (error as Error).message }
      }
    }
  )

  handle(MEDIA_HUB_CHANNELS.lanCacheMyItems, async () => {
    if (!isLanCacheConnected()) return { ok: false as const, items: [] }
    try {
      const answer = await request<{ items: LanCacheOwnItem[] }>('/api/items/mine')
      return { ok: true as const, items: answer.items ?? [] }
    } catch {
      // An older daemon has no such route. Empty rather than an error: the
      // section already tells people their server predates this work, and a
      // second failure message about it would be noise.
      return { ok: false as const, items: [] }
    }
  })

  handle<{ infoHash?: string; visibility?: string }, { ok: boolean; message?: string }>(
    MEDIA_HUB_CHANNELS.lanCacheSetSharing,
    async (_event, payload) => {
      // Validated here, not passed through: the hash goes straight into a
      // URL and the renderer is the least trusted caller in this process.
      const infoHash = String(payload?.infoHash ?? '')
      if (!/^[a-f0-9]{40}$/.test(infoHash)) return { ok: false, message: 'Unknown item.' }
      const visibility = payload?.visibility === 'shared' ? 'shared' : 'private'
      try {
        await request(`/api/items/${infoHash}/sharing`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ visibility })
        })
        return { ok: true }
      } catch (error) {
        return { ok: false, message: (error as Error).message }
      }
    }
  )
}
