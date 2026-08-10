import { ipcMain } from 'electron'
import { IPC_CHANNELS, ProxyRequest, ProxyResponse } from '../../shared/ipc-types'
import { assertTrustedSender } from './trustedSender'

// This proxy deliberately accepts any http(s) host, not just a saved
// service's own baseUrl — the Settings page's "Test Connection" button
// calls it with the live, not-yet-saved form value (see
// MediaServicesSection.tsx's handleTest), so pinning to persisted settings
// would break that real flow. What it can and does block outright: the
// cloud-metadata endpoints every major provider (AWS/Azure/GCP/DigitalOcean/
// Oracle) exposes at a fixed, well-known address — a compromised renderer
// with no other capability could otherwise use this proxy as an SSRF pivot
// to read instance credentials from there. Ordinary RFC1918/loopback
// addresses stay reachable on purpose (that's exactly where a self-hosted
// Jellyfin/Sonarr/Radarr/qBittorrent normally lives).
const BLOCKED_HOSTS = new Set([
  '169.254.169.254', // AWS IMDS, Azure IMDS, GCP legacy, DigitalOcean, Oracle Cloud
  'metadata.google.internal', // GCP's DNS alias for the same
  'metadata.internal',
  'fd00:ec2::254' // AWS IMDSv2, IPv6
])

function isBlockedTarget(target: URL): boolean {
  const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (BLOCKED_HOSTS.has(host)) return true
  // The whole 169.254.0.0/16 link-local block, not just the one IMDS
  // address — every cloud provider's metadata service lives somewhere in
  // this range, and no legitimate self-hosted media server does.
  return /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)
}

function assertAllowedTarget(target: URL): void {
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('Proxy URL must be HTTP(S) and must not contain credentials.')
  }
  if (isBlockedTarget(target)) {
    throw new Error('This address is not reachable through the proxy.')
  }
}

const MAX_REDIRECTS = 5

/**
 * fetch() follows redirects automatically by default — a server this proxy
 * was allowed to reach could redirect to a blocked address (metadata
 * endpoint) and bypass assertAllowedTarget's one-time check on the way in.
 * Manual redirect handling re-validates every hop the same way the
 * original URL was validated, and caps the chain so a malicious/broken
 * server can't redirect-loop the main process forever.
 */
async function fetchValidated(
  target: URL,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }
): Promise<Response> {
  let current = target
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current, { ...init, redirect: 'manual' })
    if (res.status < 300 || res.status >= 400 || !res.headers.has('location')) return res
    if (hop === MAX_REDIRECTS) throw new Error('Too many redirects.')
    current = new URL(res.headers.get('location') as string, current)
    assertAllowedTarget(current)
  }
  throw new Error('Too many redirects.')
}

// All Jellyfin/Sonarr/Radarr/qBittorrent calls are proxied through here
// rather than fetched directly from the renderer. Node's fetch in the main
// process isn't subject to browser CORS enforcement, which matters because
// most self-hosted media-server APIs don't send permissive CORS headers for
// a renderer-origin (file:// or the dev server's http://localhost) request.
export function registerHttpProxyIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.httpRequest,
    async (event, req: ProxyRequest): Promise<ProxyResponse> => {
      assertTrustedSender(event)
      if (!req || typeof req !== 'object') throw new Error('Invalid proxy request.')
      const { url, method = 'GET', headers = {}, body, formBody, timeoutMs = 8000 } = req

      const target = new URL(url)
      assertAllowedTarget(target)
      if (!Number.isFinite(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) {
        throw new Error('Proxy timeout must be between 250 and 30000 ms.')
      }
      if (
        Object.keys(headers).length > 32 ||
        JSON.stringify({ body, formBody }).length > 1_000_000
      ) {
        throw new Error('Proxy request exceeds size limits.')
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const finalHeaders = { ...headers }
        let finalBody: string | undefined
        if (formBody) {
          finalHeaders['Content-Type'] =
            finalHeaders['Content-Type'] ?? 'application/x-www-form-urlencoded'
          finalBody = new URLSearchParams(formBody).toString()
        } else if (body !== undefined) {
          finalBody = JSON.stringify(body)
        }

        const res = await fetchValidated(target, {
          method,
          headers: finalHeaders,
          body: finalBody,
          signal: controller.signal
        })
        const contentType = res.headers.get('content-type') ?? ''
        const data = contentType.includes('application/json')
          ? await res.json().catch(() => undefined)
          : await res.text()

        // getSetCookie() (Node 18.17+/undici) returns each Set-Cookie header
        // separately — headers.get('set-cookie') would incorrectly merge
        // multiple cookies into one comma-joined string.
        const cookies = res.headers.getSetCookie?.() ?? []

        return {
          ok: res.ok,
          status: res.status,
          data,
          setCookie: cookies.length ? cookies.join('; ') : undefined
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown network error'
        return { ok: false, status: 0, error: message }
      } finally {
        // Keep the timeout alive while consuming the response body too.
        // fetch() resolves as soon as the headers arrive, so clearing here
        // any earlier would let a server stall res.json()/res.text()
        // indefinitely after sending a quick set of headers.
        clearTimeout(timer)
      }
    }
  )
}
