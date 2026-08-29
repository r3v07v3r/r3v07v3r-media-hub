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
// IPC: discovery, pairing, status — the Settings pane's surface.

interface DeviceActionPayload {
  id: string
  action: 'approve' | 'deny' | 'revoke' | 'quota'
  /** For 'quota' only. null clears it back to the server default. */
  quotaBytes?: number | null
}

interface PairPayload {
  url: string
  /** Optional. Present only while the console code still exists; without
   *  one the request asks to join and waits for an administrator. */
  code?: string
  /** The explicit opt-in: copy the TorBox token to the daemon so it can
   *  fetch overnight with no app running. Never implied. */
  shareTorboxToken?: boolean
}

export function registerLanCacheIpc(refreshTrustedHosts: () => void): void {
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
        // Identity check first: refuse to send a pairing code to something
        // that is not an r3-cache daemon at all.
        const ping = await fetchJson<LanCachePingResponse>(
          `${url}/api/ping`,
          {},
          { lane: 'lancache', label: 'cache server' }
        )
        if (ping.product !== 'r3-cache') {
          return { ok: false, message: 'That server is not an r3-cache daemon.' }
        }
        const code = String(payload?.code || '')
        const paired = await fetchJson<LanCachePairResponse>(
          `${url}/api/pair`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // The device NAME is sent either way: it is what the server's
            // administrator sees in the approval list, so an unnamed
            // request is one nobody can sensibly say yes to.
            body: JSON.stringify({ ...(code ? { code } : {}), deviceName: os.hostname() })
          },
          { lane: 'lancache', label: 'cache server' }
        )
        if (!paired.token) {
          return {
            ok: false,
            message: code
              ? 'The pairing code was not accepted.'
              : 'The cache server did not accept the request.'
          }
        }
        const pending = paired.status === 'pending'
        setLanCacheConnection({
          url,
          name: paired.serverName ?? ping.serverName,
          token: paired.token,
          ...(pending ? { pending: true } : {})
        })
        if (pending) {
          // Nothing is granted yet — not the trusted-host entry, and not
          // the TorBox copy below. Both wait for approval, which is the
          // point of asking.
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
    if (!connection.pending) return { state: 'approved' as const, name: connection.name }
    try {
      // Deliberately NOT through request(): this is the one call a pending
      // token is allowed to make, and routing it past the same guard that
      // refuses everything else keeps that exception visible.
      const answer = await fetchJson<{ status?: string; serverName?: string }>(
        `${connection.url}/api/pair/status`,
        { headers: { Authorization: `Bearer ${connection.token}` } },
        { lane: 'lancache', label: 'cache server' }
      )
      if (answer.status === 'approved') {
        setLanCacheConnection({
          url: connection.url,
          name: answer.serverName ?? connection.name,
          token: connection.token
        })
        // Approval is what actually grants the player access to this host,
        // so the trusted-host list is refreshed HERE rather than at the
        // pairing request — the same rule as before, moved to the moment
        // that now carries the authority.
        refreshTrustedHosts()
        return { state: 'approved' as const, name: answer.serverName ?? connection.name }
      }
      return { state: 'pending' as const, name: connection.name }
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
}
