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

export function isLanCacheConnected(): boolean {
  return Boolean(getLanCacheConnection())
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

interface PairPayload {
  url: string
  code: string
  /** The explicit opt-in: copy the TorBox token to the daemon so it can
   *  fetch overnight with no app running. Never implied. */
  shareTorboxToken?: boolean
}

export function registerLanCacheIpc(refreshTrustedHosts: () => void): void {
  handle(MEDIA_HUB_CHANNELS.lanCacheDiscover, async () => {
    const found = await discoverLanCaches()
    return { daemons: found, paired: getLanCacheConnection()?.url ?? null }
  })

  handle<PairPayload, { ok: boolean; message: string }>(
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
        const paired = await fetchJson<{ token?: string; serverName?: string }>(
          `${url}/api/pair`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: String(payload?.code || ''), deviceName: os.hostname() })
          },
          { lane: 'lancache', label: 'cache server' }
        )
        if (!paired.token) return { ok: false, message: 'The pairing code was not accepted.' }
        setLanCacheConnection({
          url,
          name: paired.serverName ?? ping.serverName,
          token: paired.token
        })
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
}
