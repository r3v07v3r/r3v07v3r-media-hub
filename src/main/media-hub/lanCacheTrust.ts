// The app's half of trusting a cache daemon: learning its certificate when
// this device joins, and the pinned transport every later request rides on.
//
// Deliberately electron-free (no settings, no IPC) so the whole trust
// decision is testable under tsx against a real daemon server.
//
// The rules this module enforces:
//  - The daemon speaks HTTPS with its own self-signed certificate. The app
//    learns that certificate's fingerprint at the moment it joins and from
//    then on talks to that certificate and no other — API calls, the
//    player's /stream fetches, the rooms hop, the opt-in TorBox key. A
//    changed fingerprint is a hard failure, never a prompt or a fallback.
//  - The join carries a fresh nonce, so this device can show a verification
//    code computed from the certificate it actually connected to, for the
//    administrator to compare with the daemon's own (pairingProof.ts).
//  - There is no plain-http path. A URL typed as http:// is upgraded; an
//    old daemon that only speaks http fails to connect and is told to
//    update.

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { type Duplex, Readable } from 'node:stream'
import tls from 'node:tls'

import {
  FINGERPRINT_RE,
  LANCACHE_PROTOCOL_VERSION,
  LANCACHE_TOKEN_LIFETIME_MS,
  certFingerprint,
  joinVerificationCode,
  newNonce
} from '../../shared/lancache/pairingProof'
import type { LanCachePairResponse, LanCachePingResponse } from '../../shared/lancache/protocol'
import { readLimitedResponseText } from '../../shared/media-hub/responseLimit'

const CONNECT_TIMEOUT_MS = 10_000
const JSON_TIMEOUT_MS = 15_000
const MAX_JSON_BYTES = 2 * 1024 * 1024

/** The daemon presented a certificate other than the pinned one. Never
 *  retried, never downgraded. */
export class LanCacheIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LanCacheIdentityError'
  }
}

export class LanCacheHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'LanCacheHttpError'
  }
}

const IDENTITY_CHANGED =
  'The cache server presented a different identity than the one this app joined. Nothing was sent. If you reinstalled or reset r3-cache, leave it and join again; otherwise something on your network may be impersonating it.'

/**
 * What a person typed or discovery produced -> `https://host:port`.
 * http:// is upgraded (the daemon has no plain listener any more); paths,
 * queries and embedded credentials are refused.
 */
export function normalizeLanCacheUrl(input: string): string {
  let text = String(input ?? '').trim()
  if (!text) throw new Error('Enter the server URL.')
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error('That is not a valid server address.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('That is not a valid server address.')
  }
  if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search) {
    throw new Error('Enter just the server address, like https://192.168.1.20:8945.')
  }
  // An explicit port survives the scheme change: http://box:8945 -> https://box:8945.
  const port = url.port || (url.protocol === 'http:' ? '80' : '443')
  return `https://${url.host.replace(/:\d+$/, '')}:${port}`
}

/** Whether `candidate` addresses the same host:port as `base` — whatever
 *  its scheme, so an http:// URL to the paired daemon is still caught by
 *  the pinned path (and refused there) rather than fetched in the clear. */
export function sameLanCacheHost(candidate: string | URL, base: string): boolean {
  try {
    const a = new URL(String(candidate))
    const b = new URL(base)
    const port = (url: URL): string =>
      url.port || (url.protocol === 'http:' || url.protocol === 'ws:' ? '80' : '443')
    return a.hostname.toLowerCase() === b.hostname.toLowerCase() && port(a) === port(b)
  } catch {
    return false
  }
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason
  if (reason instanceof Error && reason.name === 'AbortError') return reason
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

/**
 * Opens a TLS connection and resolves once the handshake is done, with the
 * peer certificate's fingerprint. When `expected` is given, a different
 * certificate destroys the socket BEFORE a single application byte is
 * written. Certificate chains are not checked — a self-signed daemon
 * certificate is the design; the pin is the check.
 */
function connectTls(
  host: string,
  port: number,
  expected: string | null,
  signal?: AbortSignal | null
): Promise<{ socket: tls.TLSSocket; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal))
      return
    }
    const bare = host.replace(/^\[|\]$/g, '')
    const socket = tls.connect({
      host: bare,
      port,
      rejectUnauthorized: false,
      servername: net.isIP(bare) ? undefined : bare,
      ALPNProtocols: ['http/1.1']
    })
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      socket.destroy()
      reject(error)
    }
    const onAbort = (): void => fail(abortError(signal!))
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.setTimeout(CONNECT_TIMEOUT_MS, () =>
      fail(new Error('The cache server did not answer in time.'))
    )
    socket.once('error', (error) =>
      fail(
        Object.assign(
          new Error(
            `Could not open a secure connection to the cache server (${(error as NodeJS.ErrnoException).code ?? error.message}). If it runs an older r3-cache, update it first.`
          ),
          { code: (error as NodeJS.ErrnoException).code }
        )
      )
    )
    socket.once('secureConnect', () => {
      if (settled) return
      const raw = socket.getPeerCertificate()?.raw
      const fingerprint = raw ? certFingerprint(raw) : ''
      if (!fingerprint || (expected !== null && fingerprint !== expected)) {
        fail(new LanCacheIdentityError(IDENTITY_CHANGED))
        return
      }
      settled = true
      socket.setTimeout(0)
      signal?.removeEventListener('abort', onAbort)
      resolve({ socket, fingerprint })
    })
  })
}

function hostAndPort(url: URL): { host: string; port: number } {
  return { host: url.hostname, port: Number(url.port || 443) }
}

/** The fingerprint of whatever certificate `baseUrl` presents. Sends no
 *  application data at all — used once, to learn what to pin. */
export async function peekLanCacheFingerprint(
  baseUrl: string,
  signal?: AbortSignal | null
): Promise<string> {
  const { host, port } = hostAndPort(new URL(baseUrl))
  const { socket, fingerprint } = await connectTls(host, port, null, signal)
  socket.destroy()
  return fingerprint
}

function assertPinnable(url: URL, fingerprint: string): void {
  if (url.protocol !== 'https:' && url.protocol !== 'wss:') {
    throw new LanCacheIdentityError('Refusing to talk to the cache server without TLS.')
  }
  if (!FINGERPRINT_RE.test(fingerprint)) {
    throw new LanCacheIdentityError('This cache server has no pinned identity. Join it again.')
  }
}

/**
 * fetch(), restricted to one pinned certificate. Same call shape as the
 * global fetch for what this app uses (method, headers, string body,
 * signal), so streamCache and httpClient can take it as their fetch for
 * the daemon. Redirects are returned, never followed — safeFetchMedia
 * re-validates.
 */
export async function pinnedFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  fingerprint: string
): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input))
  assertPinnable(url, fingerprint)
  const signal = init.signal ?? null
  const { host, port } = hostAndPort(url)
  const { socket } = await connectTls(host, port, fingerprint, signal)

  const headers: Record<string, string> = {}
  new Headers(init.headers ?? {}).forEach((value, key) => {
    headers[key] = value
  })
  headers.host = url.host
  headers.connection = 'close'
  const body =
    init.body === undefined || init.body === null
      ? undefined
      : typeof init.body === 'string'
        ? init.body
        : init.body instanceof Uint8Array
          ? init.body
          : undefined
  if (init.body != null && body === undefined) {
    socket.destroy()
    throw new Error('Unsupported request body for the cache server.')
  }
  if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body))
  const method = (init.method ?? 'GET').toUpperCase()

  return new Promise<Response>((resolve, reject) => {
    const request = http.request({
      host: url.hostname,
      port: url.port,
      method,
      path: `${url.pathname}${url.search}`,
      headers,
      // The already-verified socket: http writes to it, nothing else can.
      createConnection: () => socket
    })
    const onAbort = (): void => {
      const error = abortError(signal!)
      request.destroy(error)
      reject(error)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    request.once('error', (error) => {
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    request.once('response', (incoming) => {
      const responseHeaders = new Headers()
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) for (const entry of value) responseHeaders.append(key, entry)
        else if (value !== undefined) responseHeaders.set(key, value)
      }
      const status = incoming.statusCode ?? 502
      const noBody = method === 'HEAD' || status === 204 || status === 304
      if (noBody) incoming.resume()
      // Abort after the headers tears down the body stream too.
      if (signal) {
        signal.removeEventListener('abort', onAbort)
        signal.addEventListener('abort', () => incoming.destroy(abortError(signal)), {
          once: true
        })
      }
      try {
        const response = new Response(
          noBody ? null : (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>),
          { status, statusText: incoming.statusMessage, headers: responseHeaders }
        )
        Object.defineProperty(response, 'url', { value: url.toString() })
        resolve(response)
      } catch (error) {
        incoming.destroy()
        reject(error)
      }
    })
    request.end(body)
  })
}

/**
 * An https.Agent whose every connection is the pinned one, for callers that
 * take an agent rather than a fetch — the rooms hop's WebSocket. The pin is
 * checked in the TLS handshake, before the upgrade request (which carries
 * the token) is written.
 */
export function pinnedAgent(fingerprint: string): https.Agent {
  if (!FINGERPRINT_RE.test(fingerprint)) {
    throw new LanCacheIdentityError('This cache server has no pinned identity. Join it again.')
  }
  class PinnedAgent extends https.Agent {
    // Node's Agent accepts an asynchronous createConnection: return nothing
    // and hand the socket to the callback once the pin has been checked.
    createConnection(
      options: http.RequestOptions,
      callback?: (error: Error | null, stream: Duplex) => void
    ): undefined {
      const host = String(options.hostname ?? options.host ?? '')
      const port = Number(options.port || 443)
      connectTls(host, port, fingerprint).then(
        ({ socket }) => callback?.(null, socket),
        (error: Error) => callback?.(error, undefined as unknown as Duplex)
      )
      return undefined
    }
  }
  return new PinnedAgent({ keepAlive: false })
}

/** A pinned JSON call with a timeout and a size ceiling. Non-2xx answers
 *  become LanCacheHttpError carrying the daemon's own message. */
export async function lanCacheJson<T>(
  url: string,
  init: RequestInit,
  fingerprint: string,
  timeoutMs = JSON_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await pinnedFetch(url, { ...init, signal: controller.signal }, fingerprint)
    const text = await readLimitedResponseText(response, MAX_JSON_BYTES)
    let body: Record<string, unknown> = {}
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    } catch {
      throw new LanCacheHttpError(response.status, 'The cache server sent an unreadable answer.')
    }
    if (!response.ok) {
      const message =
        typeof body.error === 'string' && body.error
          ? body.error
          : `The cache server answered ${response.status}.`
      throw new LanCacheHttpError(response.status, message)
    }
    return body as T
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      throw new Error('The cache server did not answer in time.')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export interface LanCacheJoin {
  /** https://host:port */
  url: string
  serverName: string
  token: string
  /** The certificate this join was made over — pin it. */
  fingerprint: string
  status: 'approved' | 'pending'
  tokenExpiresAt: number
  /** The code this device computed from the certificate it saw, for the
   *  administrator to compare with the daemon's. */
  verification: string
}

/**
 * Asks to join. Learns the certificate first; every request after that is
 * pinned to it, so the ping, the request and the token all concern ONE
 * server. Throws a person-readable Error on failure. `stillWanted` is asked
 * before the request that creates a device on the server, so a join that
 * is going to be thrown away is never made.
 */
export async function requestLanCacheJoin(options: {
  url: string
  deviceName: string
  stillWanted?: () => boolean
}): Promise<LanCacheJoin | null> {
  const base = normalizeLanCacheUrl(options.url)
  const fingerprint = await peekLanCacheFingerprint(base)
  const ping = await lanCacheJson<LanCachePingResponse>(`${base}/api/ping`, {}, fingerprint)
  if (ping.product !== 'r3-cache') throw new Error('That server is not an r3-cache daemon.')
  if (!(Number(ping.protocol) >= LANCACHE_PROTOCOL_VERSION)) {
    throw new Error('That cache server runs an older r3-cache. Update it, then join again.')
  }
  if (options.stillWanted && !options.stillWanted()) return null
  const clientNonce = newNonce()
  let paired: LanCachePairResponse
  try {
    paired = await lanCacheJson<LanCachePairResponse>(
      `${base}/api/pair`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The device NAME is what the server's administrator sees in the
        // approval list, so an unnamed request is one nobody can sensibly
        // say yes to.
        body: JSON.stringify({
          deviceName: String(options.deviceName || '').slice(0, 64),
          clientNonce
        })
      },
      fingerprint
    )
  } catch (error) {
    if (error instanceof LanCacheHttpError && error.status === 429) {
      // Throttled, or too many devices already waiting. Both are
      // temporary and neither is about this device.
      throw new Error('The cache server is not taking requests right now. Try again shortly.')
    }
    throw error
  }
  const token = String(paired.token ?? '')
  if (!/^[a-f0-9]{64}$/.test(token)) {
    throw new Error('The cache server is not taking requests right now. Try again shortly.')
  }
  return {
    url: base,
    serverName: String(paired.serverName || ping.serverName || ''),
    token,
    fingerprint,
    status: paired.status === 'pending' ? 'pending' : 'approved',
    tokenExpiresAt: Number(paired.expiresAt) || Date.now() + LANCACHE_TOKEN_LIFETIME_MS,
    verification: joinVerificationCode(fingerprint, token, clientNonce)
  }
}

/** Renew when less than this is left on the token. */
export const LAN_CACHE_RENEW_WITHIN_MS = 30 * 24 * 60 * 60 * 1000

export function lanCacheTokenNeedsRenewal(expiresAt: number, now = Date.now()): boolean {
  return !expiresAt || expiresAt - now < LAN_CACHE_RENEW_WITHIN_MS
}
