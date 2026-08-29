// Shared contract between main, preload, and renderer. Kept in one place so
// the preload bridge and the renderer's `window.api` typings can never drift
// apart from what main actually implements.

export interface SystemSnapshot {
  cpu: {
    loadPercent: number
    speedGHz: number | null
    cores: number
    temperatureC: number | null
  }
  gpu: {
    loadPercent: number | null
    vramUsedMB: number | null
    vramTotalMB: number | null
    model: string | null
    temperatureC: number | null
  } | null
  memory: {
    usedGB: number
    totalGB: number
    usedPercent: number
  }
  network: {
    downKbps: number
    upKbps: number
    interface: string | null
  }
  timestamp: number
}

// ---------------------------------------------------------------------------
// Media-server / download-client settings — persisted via electron-store in
// the main process (never localStorage; see spec section on settings
// persistence). Each service is independently optional/configurable; the
// renderer falls back to mock data whenever a service isn't configured or a
// live call fails, and always surfaces which mode it's in rather than
// silently faking a connection.
// ---------------------------------------------------------------------------
export interface ServiceConfig {
  baseUrl: string
  apiKey: string
  enabled: boolean
}

export type ServiceId = 'jellyfin' | 'sonarr' | 'radarr' | 'qbittorrent' | 'prowlarr' | 'bazarr'

export type ServiceSettings = Record<ServiceId, ServiceConfig>

export const DEFAULT_SERVICE_CONFIG: ServiceConfig = {
  baseUrl: '',
  apiKey: '',
  enabled: false
}

export const DEFAULT_SERVICE_SETTINGS: ServiceSettings = {
  jellyfin: { ...DEFAULT_SERVICE_CONFIG },
  sonarr: { ...DEFAULT_SERVICE_CONFIG },
  radarr: { ...DEFAULT_SERVICE_CONFIG },
  qbittorrent: { ...DEFAULT_SERVICE_CONFIG },
  prowlarr: { ...DEFAULT_SERVICE_CONFIG },
  bazarr: { ...DEFAULT_SERVICE_CONFIG }
}

/**
 * Fills in any service ID this app knows about that a stored/incoming
 * object is missing — the migration an upgraded install needs, because
 * electron-store's `defaults` only applies when the store KEY ITSELF
 * (`services`) is entirely absent, never when it exists but lacks a nested
 * field a later release added. An install that saved its settings before
 * `prowlarr` existed has a four-key object forever without this: reads
 * silently drop the new service (no card renders for it) and writes get
 * REJECTED outright by a shape check that requires every current ID to be
 * present — turning "a new service was added" into "nobody can change
 * their Jellyfin URL anymore" for every existing install.
 *
 * A present entry always wins over the default, whatever its own fields —
 * this only fills a wholesale-MISSING key. Pure and Electron-free on
 * purpose (see this file's own header): main/ipc/settings.ts, which pulls
 * in `electron-store`, is the only caller, and keeping the merge itself
 * here is what lets it be tested without an Electron harness.
 */
export function withServiceDefaults(stored: Partial<ServiceSettings> | undefined): ServiceSettings {
  const merged = { ...DEFAULT_SERVICE_SETTINGS } as ServiceSettings
  for (const id of Object.keys(DEFAULT_SERVICE_SETTINGS) as ServiceId[]) {
    if (stored?.[id]) merged[id] = stored[id] as ServiceConfig
  }
  return merged
}

// Generic outbound HTTP proxy — requests run in the main process (plain
// Node fetch, no browser CORS enforcement) since self-hosted media-server
// APIs frequently don't send CORS headers permitting a renderer-origin
// fetch. The renderer never talks to these hosts directly.
export interface ProxyRequest {
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  headers?: Record<string, string>
  /** Sent as application/x-www-form-urlencoded when set (qBittorrent's
   *  WebUI API expects form-encoded bodies, e.g. for /auth/login) —
   *  otherwise `body` is JSON-encoded. */
  formBody?: Record<string, string>
  body?: unknown
  timeoutMs?: number
}

export interface ProxyResponse<T = unknown> {
  ok: boolean
  status: number
  data?: T
  error?: string
  /** Set-Cookie value(s) from the response, joined with '; ' — qBittorrent's
   *  WebUI auth is cookie-based (no API-key auth without a plugin), so the
   *  qbittorrent client needs this to carry the SID cookie from
   *  /auth/login into subsequent requests. */
  setCookie?: string
}

export const IPC_CHANNELS = {
  systemSnapshot: 'system:snapshot',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  httpRequest: 'http:request'
} as const
