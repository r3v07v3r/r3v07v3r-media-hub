import { ServiceConfig } from '@shared/ipc-types'
import { proxyFetch } from './proxyFetch'
import { ClientResult, ConnectionTestResult, isConfigured, normalizeBaseUrl } from './types'

// Shared client for Sonarr and Radarr — both are "Servarr" family apps and
// expose the same v3 REST shape (/api/v3/system/status, /api/v3/queue,
// X-Api-Key header auth), so one implementation covers both rather than
// duplicating it per service. Not exercised against a live instance (none
// exists in this sandbox); shaped from the public Servarr API docs
// (https://sonarr.tv/docs/api / https://radarr.video/docs/api).

export interface ServarrSystemStatus {
  version?: string
  appName?: string
}

export interface ServarrQueueItem {
  id: number
  title?: string
  series?: { title?: string }
  movie?: { title?: string }
  status?: string
  trackedDownloadStatus?: string
  sizeleft?: number
  size?: number
  timeleft?: string
}

function headers(config: ServiceConfig): Record<string, string> {
  return config.apiKey ? { 'X-Api-Key': config.apiKey } : {}
}

export function createServarrClient(kind: 'sonarr' | 'radarr') {
  const label = kind === 'sonarr' ? 'Sonarr' : 'Radarr'

  async function testConnection(config: ServiceConfig): Promise<ConnectionTestResult> {
    if (!config.baseUrl.trim()) return { ok: false, message: 'Server URL is required' }
    if (!config.apiKey.trim()) return { ok: false, message: 'API key is required' }
    const base = normalizeBaseUrl(config.baseUrl)
    const res = await proxyFetch<ServarrSystemStatus>({
      url: `${base}/api/v3/system/status`,
      method: 'GET',
      headers: headers(config)
    })
    if (!res.ok)
      return { ok: false, message: res.error ?? `Server responded with status ${res.status}` }
    const version = res.data?.version ? ` v${res.data.version}` : ''
    return { ok: true, message: `Connected to ${label}${version}` }
  }

  async function getQueue(config: ServiceConfig): Promise<ClientResult<ServarrQueueItem[]>> {
    if (!isConfigured(config)) return { ok: false, live: false, error: `${label} isn't configured` }
    const base = normalizeBaseUrl(config.baseUrl)
    const res = await proxyFetch<{ records: ServarrQueueItem[] }>({
      url: `${base}/api/v3/queue?pageSize=25`,
      method: 'GET',
      headers: headers(config)
    })
    if (!res.ok) return { ok: false, live: false, error: res.error ?? `Status ${res.status}` }
    return { ok: true, live: true, data: res.data?.records ?? [] }
  }

  return { testConnection, getQueue }
}

export const sonarrClient = createServarrClient('sonarr')
export const radarrClient = createServarrClient('radarr')
