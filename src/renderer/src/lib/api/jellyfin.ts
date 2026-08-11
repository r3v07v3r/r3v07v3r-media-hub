import { ServiceConfig } from '@shared/ipc-types'
import { proxyFetch } from './proxyFetch'
import { ClientResult, ConnectionTestResult, isConfigured, normalizeBaseUrl } from './types'

// Real Jellyfin REST client scaffold (spec: "real Jellyfin/Sonarr/Radarr/
// qBittorrent backend wiring"). Every call is read-only and degrades to
// {live:false} rather than throwing when the service isn't configured —
// see ClientResult's doc comment. No Jellyfin instance exists in this dev
// sandbox to test against, so this has been exercised against the public
// API shape (documented at https://api.jellyfin.org) but not against a
// live server; treat the response typing as best-effort until validated
// against a real instance.

interface JellyfinSystemInfo {
  ServerName?: string
  Version?: string
  Id?: string
}

export interface JellyfinResumeItem {
  Id: string
  Name: string
  SeriesName?: string
  ParentIndexNumber?: number
  IndexNumber?: number
  UserData?: {
    PlaybackPositionTicks?: number
    PlayedPercentage?: number
  }
  RunTimeTicks?: number
}

function authHeaders(config: ServiceConfig): Record<string, string> {
  return config.apiKey ? { 'X-Emby-Token': config.apiKey } : {}
}

export async function testConnection(config: ServiceConfig): Promise<ConnectionTestResult> {
  if (!config.baseUrl.trim()) return { ok: false, message: 'Server URL is required' }
  if (!config.apiKey.trim()) return { ok: false, message: 'API Key is required' }
  const base = normalizeBaseUrl(config.baseUrl)
  // /System/Info/Public is deliberately unauthenticated (Jellyfin exposes it
  // so a login screen can show the server name pre-auth) — it returns 200
  // regardless of whether the API key is valid, so it can never actually
  // test the credential. /System/Info is the same shape but requires a
  // valid token, which is the whole point of a "Test connection" button.
  const res = await proxyFetch<JellyfinSystemInfo>({
    url: `${base}/System/Info`,
    method: 'GET',
    headers: authHeaders(config)
  })
  if (!res.ok)
    return { ok: false, message: res.error ?? `Server responded with status ${res.status}` }
  const name = res.data?.ServerName ?? 'Jellyfin server'
  const version = res.data?.Version ? ` (v${res.data.Version})` : ''
  return { ok: true, message: `Connected to ${name}${version}` }
}

/** Continue-watching items for a user — the real-data path Home's
 *  ContinueWatchingPanel would swap in for CONTINUE_WATCHING mock data
 *  once a userId is wired up (Jellyfin resume items are per-user, so a
 *  profile-selection flow is a prerequisite this scaffold doesn't
 *  implement yet). */
export async function getResumeItems(
  config: ServiceConfig,
  userId: string
): Promise<ClientResult<JellyfinResumeItem[]>> {
  if (!isConfigured(config)) return { ok: false, live: false, error: "Jellyfin isn't configured" }
  const base = normalizeBaseUrl(config.baseUrl)
  const res = await proxyFetch<{ Items: JellyfinResumeItem[] }>({
    url: `${base}/Users/${userId}/Items/Resume?Limit=12&Fields=UserData`,
    method: 'GET',
    headers: authHeaders(config)
  })
  if (!res.ok) return { ok: false, live: false, error: res.error ?? `Status ${res.status}` }
  return { ok: true, live: true, data: res.data?.Items ?? [] }
}
