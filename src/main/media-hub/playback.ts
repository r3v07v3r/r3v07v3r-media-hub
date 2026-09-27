// The SSRF defense boundary for remote media. Ported from
// r3v07v3r-media-hub's src/playback.cjs, which also held a loopback playback
// proxy; that was deleted here once nothing constructed it (mpv plays either
// a public HTTPS URL or streamCache.ts's own loopback server). What this file
// holds is the checks themselves, which every remote media fetch goes
// through:
//
//   - isAllowedRemoteMediaUrl: a media URL must be public HTTPS with no
//     embedded credentials, not a private/loopback/link-local address or an
//     internal-only hostname. mpv.ts and torbox.ts gate on it.
//   - assertPublicMediaUrl: re-resolves DNS and re-checks every resolved
//     address before fetching, to defeat DNS-rebinding attacks where the
//     hostname passes validation but later resolves to a private IP.
//   - safeFetchMedia / fetchMediaWithRetry: follow redirects manually with
//     re-validation at every hop. streamCache.ts's upstream fetch and the
//     r3-cache daemon's fetcher both go through these.
//
// Every check here is preserved exactly, byte-for-byte in intent, from the
// original — do not loosen, skip, or "simplify" any of it without
// re-auditing against the source app.

import dns from 'node:dns/promises'

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
 * THE ONE DELIBERATE EXCEPTION to everything this file's header says.
 *
 * A self-hosted media server (Jellyfin) is, by definition, the exact thing
 * the SSRF rules above exist to keep playback away from: a plain-http
 * service on an RFC1918 address. Supporting one as a playback source means
 * *some* private address has to become reachable — there is no way around
 * that, so the design goal is to make the hole as small as it can possibly
 * be, and to keep it in this file where the rest of the boundary lives
 * rather than letting each call site invent its own bypass.
 *
 * What keeps this narrow:
 *  - Exact `host:port` match. Never a wildcard, never a CIDR range, never
 *    "any private address is fine now".
 *  - The set is derived solely from a base URL a person typed into the
 *    Settings UI, published through `setTrustedMediaHosts`. The renderer
 *    cannot reach that function; it goes through the settings IPC handler,
 *    which is already `assertTrustedSender`-guarded.
 *  - It grants nothing when empty, which is the state for every user who
 *    hasn't configured a media server. Their behaviour is bit-identical to
 *    before this existed.
 *  - It does NOT relax the redirect handling: `safeFetchMedia` re-validates
 *    every hop through `assertPublicMediaUrl`, so a trusted host cannot
 *    launder a redirect into some *other* private address.
 */
let trustedMediaHosts: ReadonlySet<string> = new Set()

/** Normalizes a URL to the exact `host:port` form the trusted set stores.
 *  The port is always made explicit — `URL.port` is '' for a protocol's
 *  default port, so without this a trusted `http://box:80` and an untrusted
 *  `http://box:8096` would collapse to the same key. */
function mediaHostKey(url: URL): string {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  return `${host}:${port}`
}

/**
 * Replaces the trusted-host set wholesale (never appends — a host removed
 * in Settings must stop being trusted immediately). Accepts raw base-URL
 * strings and normalizes them here so no caller has to know the key format.
 * Anything unparseable, credential-bearing, or non-http(s) is dropped
 * rather than throwing: this is called from a settings-save path, and one
 * malformed saved URL must not break playback for the other source.
 */
export function setTrustedMediaHosts(baseUrls: readonly string[]): void {
  const next = new Set<string>()
  for (const value of baseUrls) {
    try {
      const url = new URL(String(value))
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
      if (url.username || url.password) continue
      if (!url.hostname) continue
      next.add(mediaHostKey(url))
    } catch {
      // Ignore — a malformed entry simply grants nothing.
    }
  }
  trustedMediaHosts = next
}

export function isTrustedMediaHost(url: URL): boolean {
  return trustedMediaHosts.has(mediaHostKey(url))
}

/** Test seam / teardown: drops every trusted host. */
export function clearTrustedMediaHosts(): void {
  trustedMediaHosts = new Set()
}

/**
 * Returns true only for https URLs, with no embedded credentials, whose
 * hostname isn't itself a private/loopback IP literal or an
 * internal-only-style name (localhost/.localhost/.local/.lan/.internal).
 * This is a *syntactic* pre-check only — DNS-rebinding is defended against
 * separately, by re-resolving and re-checking actual addresses at fetch
 * time (see `assertPublic` below).
 *
 * The single exception is a configured media-server host — see
 * `trustedMediaHosts` above for why it exists and what bounds it.
 */
export function isAllowedRemoteMediaUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value))
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()

    // Hoisted out of the expression below so the trusted-host branch is
    // subject to them too: credentials in the URL and an empty host are
    // disqualifying for *every* media URL, trusted or not.
    if (!host || url.username || url.password) return false

    // The configured media server, which is allowed to be plain http on a
    // private address — that is the whole point of it.
    if ((url.protocol === 'http:' || url.protocol === 'https:') && isTrustedMediaHost(url)) {
      return true
    }

    return (
      url.protocol === 'https:' &&
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

export function defaultResolveHost(host: string): Promise<string[]> {
  return dns.lookup(host, { all: true }).then((rows) => rows.map((row) => row.address))
}

/**
 * Re-validates the URL syntactically, then performs a *fresh* DNS
 * resolution and rejects if any resolved address is private. This is the
 * DNS-rebinding defense: a hostname that passed the syntactic check earlier
 * (e.g. at registration time) could since have been repointed at a private
 * address, so every fetch (including every redirect hop) must re-resolve
 * and re-check, not just re-check the hostname string.
 *
 * Exported so streamCache.ts's upstream fetch uses this exact audited check
 * instead of duplicating it — the SSRF boundary must stay in exactly one
 * place.
 */
export async function assertPublicMediaUrl(
  urlValue: string,
  resolveHost: (host: string) => Promise<string[]> = defaultResolveHost
): Promise<void> {
  if (!isAllowedRemoteMediaUrl(urlValue)) {
    throw new Error('Playback requires a valid public HTTPS media URL.')
  }
  const url = new URL(urlValue)
  // A trusted media-server host resolves to a private address by design —
  // that IS the address we mean to reach — so the rebinding check below
  // would reject it every single time. Skipping it here rather than
  // weakening `isPrivateAddress` keeps the exemption tied to the exact
  // host:port allowlist instead of leaking into every other caller. Note
  // the exemption is re-evaluated per redirect hop by safeFetchMedia, so a
  // trusted host redirecting elsewhere gets no inherited trust.
  if (isTrustedMediaHost(url)) return
  const addresses = await resolveHost(url.hostname)
  if (!addresses.length || addresses.some(isPrivateAddress)) {
    throw new Error('Playback source resolved to a private network address.')
  }
}

/** Follows redirects manually, re-validating (assertPublicMediaUrl) at every hop. */
export async function safeFetchMedia(
  urlValue: string,
  options: RequestInit,
  fetchImpl: typeof fetch = globalThis.fetch,
  resolveHost: (host: string) => Promise<string[]> = defaultResolveHost
): Promise<Response> {
  let current = urlValue
  for (let redirects = 0; redirects <= 5; redirects++) {
    await assertPublicMediaUrl(current, resolveHost)
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

// Streaming/debrid sources can drop the connection briefly under load, and
// one transient blip must not end a playback or a cache fill. So a fetch
// that fails before any response has arrived is retried, up to three
// attempts with a short growing delay; an abort is never retried.
// Bounded to the pre-response window only: once a response is being
// consumed, a failure surfaces to the caller, which asks again from the byte
// it had reached (streamCache.ts's fill, the r3-cache daemon's fetcher).
export async function fetchMediaWithRetry(
  remoteUrl: string,
  options: RequestInit,
  fetchImpl: typeof fetch = globalThis.fetch,
  resolveHost: (host: string) => Promise<string[]> = defaultResolveHost
): Promise<Response> {
  const attempts = 3
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await safeFetchMedia(remoteUrl, options, fetchImpl, resolveHost)
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
