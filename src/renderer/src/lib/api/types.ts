import { ServiceConfig, ServiceId } from '@shared/ipc-types'

export interface ConnectionTestResult {
  ok: boolean
  message: string
}

export interface ClientResult<T> {
  ok: boolean
  data?: T
  error?: string
  /** True when this result came from the live service; false when the
   *  caller should treat `data` as mock/placeholder (or absent) because
   *  the service isn't configured/enabled or the call failed. UI surfaces
   *  are expected to read this and label themselves accordingly rather
   *  than silently presenting mock data as if it were live. */
  live: boolean
}

export const SERVICE_LABELS: Record<ServiceId, string> = {
  jellyfin: 'Jellyfin',
  sonarr: 'Sonarr',
  radarr: 'Radarr',
  qbittorrent: 'qBittorrent'
}

export function isConfigured(config: ServiceConfig | undefined): config is ServiceConfig {
  return !!config && config.enabled && config.baseUrl.trim().length > 0
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}
