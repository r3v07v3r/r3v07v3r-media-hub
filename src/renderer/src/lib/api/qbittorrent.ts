import { ServiceConfig } from '@shared/ipc-types'
import { proxyFetch } from './proxyFetch'
import { ClientResult, ConnectionTestResult, isConfigured, normalizeBaseUrl } from './types'

// qBittorrent's WebUI API is cookie-based (POST /api/v2/auth/login with a
// username+password, then an SID cookie on every subsequent request) —
// there's no API-key auth without a third-party plugin, unlike the other
// three services. ServiceConfig's `apiKey` field is repurposed here as
// "username:password" (colon-separated) rather than a real API key; the
// Settings UI labels this field accordingly for qBittorrent specifically.
// Not exercised against a live instance — shaped from the documented
// WebUI API (https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-(qBittorrent-4.1)).

export interface QbTorrent {
  hash: string
  name: string
  progress: number
  state: string
  dlspeed: number
  upspeed: number
  size: number
  eta: number
}

function parseCredentials(apiKey: string): { username: string; password: string } | null {
  const idx = apiKey.indexOf(':')
  if (idx === -1) return null
  return { username: apiKey.slice(0, idx), password: apiKey.slice(idx + 1) }
}

async function login(
  config: ServiceConfig
): Promise<{ ok: boolean; cookie?: string; error?: string }> {
  const base = normalizeBaseUrl(config.baseUrl)
  const creds = parseCredentials(config.apiKey)
  if (!creds) return { ok: false, error: 'Credentials must be "username:password"' }

  const res = await proxyFetch<string>({
    url: `${base}/api/v2/auth/login`,
    method: 'POST',
    formBody: { username: creds.username, password: creds.password }
  })
  if (!res.ok) return { ok: false, error: res.error ?? `Login failed with status ${res.status}` }
  // qBittorrent responds 200 with body "Fails." on bad credentials rather
  // than a non-2xx status, so the body has to be checked too.
  if (typeof res.data === 'string' && res.data.toLowerCase().includes('fail')) {
    return { ok: false, error: 'Invalid username or password' }
  }
  return { ok: true, cookie: res.setCookie }
}

export async function testConnection(config: ServiceConfig): Promise<ConnectionTestResult> {
  if (!config.baseUrl.trim()) return { ok: false, message: 'Server URL is required' }
  const loginResult = await login(config)
  if (!loginResult.ok) return { ok: false, message: loginResult.error ?? 'Login failed' }
  const base = normalizeBaseUrl(config.baseUrl)
  const res = await proxyFetch<string>({
    url: `${base}/api/v2/app/version`,
    method: 'GET',
    headers: loginResult.cookie ? { Cookie: loginResult.cookie } : undefined
  })
  if (!res.ok) return { ok: false, message: res.error ?? `Status ${res.status}` }
  return { ok: true, message: `Connected — qBittorrent ${res.data ?? ''}`.trim() }
}

export async function getTorrents(config: ServiceConfig): Promise<ClientResult<QbTorrent[]>> {
  if (!isConfigured(config))
    return { ok: false, live: false, error: "qBittorrent isn't configured" }
  const loginResult = await login(config)
  if (!loginResult.ok) return { ok: false, live: false, error: loginResult.error }
  const base = normalizeBaseUrl(config.baseUrl)
  const res = await proxyFetch<QbTorrent[]>({
    url: `${base}/api/v2/torrents/info`,
    method: 'GET',
    headers: loginResult.cookie ? { Cookie: loginResult.cookie } : undefined
  })
  if (!res.ok) return { ok: false, live: false, error: res.error ?? `Status ${res.status}` }
  return { ok: true, live: true, data: res.data ?? [] }
}
