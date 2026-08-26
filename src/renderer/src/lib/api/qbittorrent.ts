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

/**
 * True when a torrent is in one of qBittorrent's several stopped states.
 *
 * There is no single "paused" flag: the WebUI reports pausedDL, pausedUP,
 * stoppedDL and stoppedUP depending on version and on whether the torrent had
 * finished, and 4.x renamed the pair midway. Matching on the shape of the
 * name rather than on an exhaustive list is what keeps this working across
 * both, and across whatever the next rename is.
 */
export function isPaused(torrent: QbTorrent): boolean {
  const state = String(torrent.state ?? '').toLowerCase()
  return state.startsWith('paused') || state.startsWith('stopped')
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

/**
 * One authenticated POST against a torrent-management endpoint.
 *
 * Every call logs in first rather than holding a session. That is a real
 * round trip per action, and it is the right trade here: the SID cookie
 * expires on its own schedule, the Downloads page acts on a torrent rarely
 * (this is not a polling path), and a cached cookie that has quietly gone
 * stale turns every button into a silent no-op. `getTorrents` above already
 * works this way for the same reason.
 */
async function manage(
  config: ServiceConfig,
  action: 'pause' | 'resume' | 'delete',
  hash: string,
  extra: Record<string, string> = {}
): Promise<ClientResult<true>> {
  if (!isConfigured(config)) {
    return { ok: false, live: false, error: "qBittorrent isn't configured" }
  }
  const loginResult = await login(config)
  if (!loginResult.ok) return { ok: false, live: false, error: loginResult.error }
  const base = normalizeBaseUrl(config.baseUrl)
  const res = await proxyFetch<string>({
    // pause/resume rather than 5.x's newer stop/start: those are the names
    // that exist in both, since 5.x kept the old pair as aliases while 4.x
    // never had the new one.
    url: `${base}/api/v2/torrents/${action}`,
    method: 'POST',
    headers: loginResult.cookie ? { Cookie: loginResult.cookie } : undefined,
    // Form-encoded, which is what this API takes — see the proxy's own
    // formBody note. `hashes` is plural in the API and takes a pipe-separated
    // list; one at a time is all this UI ever needs.
    formBody: { hashes: hash, ...extra }
  })
  if (!res.ok) return { ok: false, live: false, error: res.error ?? `Status ${res.status}` }
  return { ok: true, live: true, data: true }
}

export function pauseTorrent(config: ServiceConfig, hash: string): Promise<ClientResult<true>> {
  return manage(config, 'pause', hash)
}

export function resumeTorrent(config: ServiceConfig, hash: string): Promise<ClientResult<true>> {
  return manage(config, 'resume', hash)
}

/**
 * Removes a torrent, optionally with the files it downloaded.
 *
 * `deleteFiles` is spelled out as a string because the body is form-encoded
 * and this API's own WebUI sends "true"/"false" — passing a JS boolean would
 * rely on the encoder's stringification rather than on the documented shape,
 * on a parameter where being wrong means deleting somebody's media when they
 * asked not to.
 */
export function deleteTorrent(
  config: ServiceConfig,
  hash: string,
  deleteFiles: boolean
): Promise<ClientResult<true>> {
  return manage(config, 'delete', hash, { deleteFiles: deleteFiles ? 'true' : 'false' })
}
