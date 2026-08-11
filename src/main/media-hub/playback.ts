// Ported from r3v07v3r-media-hub's src/playback.cjs. This is the SSRF
// defense boundary for remote media playback: it validates that a remote
// media URL is public HTTPS (not a private/loopback/link-local address or
// an internal-only hostname), re-resolves DNS and re-checks every resolved
// address before fetching (to defeat DNS-rebinding attacks where the
// hostname passes validation but later resolves to a private IP), follows
// redirects manually with re-validation at every hop, and only ever binds
// its local proxy server to 127.0.0.1. Every check here is preserved
// exactly, byte-for-byte in intent, from the original — do not loosen,
// skip, or "simplify" any of it without re-auditing against the source app.

import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'

/**
 * Classifies an IP-literal address (v4 or v6) as "private"/internal for
 * SSRF purposes. Preserved exactly from the original: IPv6 loopback/
 * unique-local/link-local/IPv4-mapped-private ranges, and IPv4 0.x
 * ("this network"), 10.x, 127.x (loopback), >=224 (multicast/reserved),
 * 100.64-127.x (CGNAT), 169.254.x (link-local), 172.16-31.x, 192.168.x,
 * and 198.18-19.x (benchmarking).
 */
export function isPrivateAddress(value: string): boolean {
  const address = String(value)
    .replace(/^\[|\]$/g, '')
    .toLowerCase()

  if (address.includes(':')) {
    return (
      address === '::1' ||
      address === '::' ||
      address.startsWith('fc') ||
      address.startsWith('fd') ||
      /^fe[89ab]/.test(address) ||
      address.startsWith('::ffff:127.') ||
      address.startsWith('::ffff:10.') ||
      address.startsWith('::ffff:192.168.')
    )
  }

  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) {
    return false
  }

  const [a, b] = parts
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  )
}

/**
 * Returns true only for https URLs, with no embedded credentials, whose
 * hostname isn't itself a private/loopback IP literal or an
 * internal-only-style name (localhost/.localhost/.local/.lan/.internal).
 * This is a *syntactic* pre-check only — DNS-rebinding is defended against
 * separately, by re-resolving and re-checking actual addresses at fetch
 * time (see `assertPublic` below).
 */
export function isAllowedRemoteMediaUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value))
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()

    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      Boolean(host) &&
      !isPrivateAddress(host) &&
      host !== 'localhost' &&
      !host.endsWith('.localhost') &&
      !host.endsWith('.local') &&
      !host.endsWith('.lan') &&
      !host.endsWith('.internal')
    )
  } catch {
    return false
  }
}

function defaultResolveHost(host: string): Promise<string[]> {
  return dns.lookup(host, { all: true }).then((rows) => rows.map((row) => row.address))
}

interface PlaybackSession {
  remoteUrl: string
  expiresAt: number
}

export interface CreatePlaybackProxyOptions {
  fetchImpl?: typeof fetch
  randomBytes?: typeof crypto.randomBytes
  resolveHost?: (host: string) => Promise<string[]>
}

export interface PlaybackProxy {
  register: (remoteUrl: string) => Promise<string>
  close: () => Promise<void>
}

export function createPlaybackProxy({
  fetchImpl = globalThis.fetch,
  randomBytes = crypto.randomBytes,
  resolveHost = defaultResolveHost
}: CreatePlaybackProxyOptions = {}): PlaybackProxy {
  let server: http.Server | null = null
  let origin = ''
  const sessions = new Map<string, PlaybackSession>()

  // Re-validates the URL syntactically, then performs a *fresh* DNS
  // resolution and rejects if any resolved address is private. This is
  // the DNS-rebinding defense: a hostname that passed the syntactic check
  // earlier (e.g. at registration time) could since have been repointed at
  // a private address, so every fetch (including every redirect hop) must
  // re-resolve and re-check, not just re-check the hostname string.
  async function assertPublic(urlValue: string): Promise<void> {
    if (!isAllowedRemoteMediaUrl(urlValue)) {
      throw new Error('Playback requires a valid public HTTPS media URL.')
    }
    const url = new URL(urlValue)
    const addresses = await resolveHost(url.hostname)
    if (!addresses.length || addresses.some(isPrivateAddress)) {
      throw new Error('Playback source resolved to a private network address.')
    }
  }

  async function safeFetch(urlValue: string, options: RequestInit): Promise<Response> {
    let current = urlValue
    for (let redirects = 0; redirects <= 5; redirects++) {
      await assertPublic(current)
      const response = await fetchImpl(current, { ...options, redirect: 'manual' })
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return response
      }
      const location = response.headers.get('location')
      if (!location) {
        throw new Error('Playback redirect did not include a destination.')
      }
      current = new URL(location, current).toString()
    }
    throw new Error('Playback source redirected too many times.')
  }

  // vlc.ts's ffmpeg transcoder gets `-reconnect`/`-reconnect_on_network_error`
  // for exactly this reason ("Streaming/debrid sources can drop the
  // connection briefly under load"), but that protection never covered
  // direct/proxied playback (no ffmpeg involved) — every distinct byte
  // range Chromium's <video> element asks for is its own fresh request
  // through this proxy, and a single failed upstream fetch here (before
  // any response has gone to the client) turned straight into a 502,
  // which the <video> element surfaces as a hard error that closes the
  // whole player — a transient blip on the MORE common playback path
  // (direct/proxied is used whenever a title doesn't need transcoding)
  // forcing a full "click Play again" restart, exactly the kind of
  // failure ffmpeg's own reconnect flags exist to absorb on its path.
  // Bounded to the pre-response window only: once headers are already
  // sent, a failure has to surface immediately (see the caller) — there is
  // no way to retry a fetch whose response Chromium has already started
  // consuming without a Range-aware resume this proxy doesn't implement.
  async function fetchUpstreamWithRetry(
    remoteUrl: string,
    options: RequestInit
  ): Promise<Response> {
    const attempts = 3
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await safeFetch(remoteUrl, options)
      } catch (error) {
        const isLastAttempt = attempt === attempts
        const aborted = (error as { name?: string } | undefined)?.name === 'AbortError'
        if (aborted || isLastAttempt) throw error
        await new Promise((resolve) => setTimeout(resolve, 300 * attempt))
      }
    }
    // Unreachable — the loop above always returns or throws — but keeps
    // this function's return type honest without a non-null assertion.
    throw new Error('Playback source could not be reached.')
  }

  async function listen(): Promise<void> {
    if (server) return
    server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const match = /^\/media\/([a-f0-9]{64})$/.exec(
          new URL(req.url ?? '', 'http://127.0.0.1').pathname
        )
        const session = match && sessions.get(match[1])
        if (
          !session ||
          session.expiresAt < Date.now() ||
          !['GET', 'HEAD'].includes(req.method ?? '')
        ) {
          res.writeHead(404, { 'cache-control': 'no-store' })
          res.end()
          return
        }

        const headers: Record<string, string> = {}
        if (req.headers.range) headers.Range = req.headers.range as string
        const controller = new AbortController()
        res.on('close', () => controller.abort())
        const upstream = await fetchUpstreamWithRetry(session.remoteUrl, {
          headers,
          signal: controller.signal
        })
        if (!isAllowedRemoteMediaUrl(upstream.url || session.remoteUrl)) {
          res.writeHead(502, { 'cache-control': 'no-store' })
          res.end()
          return
        }

        const forwarded: Record<string, string> = {}
        for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
          const value = upstream.headers.get(name)
          if (value) forwarded[name] = value
        }
        forwarded['cache-control'] = 'no-store'
        forwarded['x-content-type-options'] = 'nosniff'
        res.writeHead(upstream.status, forwarded)
        if (req.method === 'HEAD' || !upstream.body) {
          res.end()
          return
        }
        // Node's global `fetch` Response#body is typed against the whatwg-fetch
        // lib.dom ReadableStream, while Readable.fromWeb expects
        // node:stream/web's ReadableStream type. These are structurally
        // near-identical but not assignable in strict TS, so a cast is needed
        // to bridge the two at this one call site.
        Readable.fromWeb(upstream.body as unknown as NodeWebReadableStream<Uint8Array>)
          .on('error', () => res.destroy())
          .pipe(res)
      } catch (error) {
        if (!res.headersSent) {
          res.writeHead(
            (error as { name?: string } | undefined)?.name === 'AbortError' ? 499 : 502,
            {
              'cache-control': 'no-store'
            }
          )
        }
        res.end()
      }
    })
    await new Promise<void>((resolve, reject) => {
      const activeServer = server as http.Server
      activeServer.once('error', reject)
      activeServer.listen(0, '127.0.0.1', () => {
        activeServer.off('error', reject)
        const address = activeServer.address()
        const port = typeof address === 'object' && address ? address.port : 0
        origin = `http://127.0.0.1:${port}`
        resolve()
      })
    })
  }

  async function register(remoteUrl: string): Promise<string> {
    if (!isAllowedRemoteMediaUrl(remoteUrl)) {
      throw new Error('Playback requires a valid HTTPS media URL.')
    }
    await listen()
    // Only one active playback session at a time, by design (mirrors the
    // original): registering a new source invalidates any prior token.
    sessions.clear()
    const token = randomBytes(32).toString('hex')
    sessions.set(token, { remoteUrl, expiresAt: Date.now() + 6 * 60 * 60 * 1000 })
    return `${origin}/media/${token}`
  }

  async function close(): Promise<void> {
    sessions.clear()
    if (!server) return
    const active = server
    server = null
    origin = ''
    await new Promise<void>((resolve) => active.close(() => resolve()))
  }

  return { register, close }
}
