// Ported from r3v07v3r-media-hub's src/security.cjs. This is a security
// boundary (URL allowlisting, IPC sender trust check, tracker sanitization
// against SSRF) — validation logic is preserved exactly, byte-for-byte in
// intent, from the original. Do not "improve" or simplify these checks
// without re-auditing every branch against the source app.

import type { MediaKind } from '../../shared/media-hub/types'
import { isPrivateAddress } from './playback'

// Hosts the app is allowed to open external browser windows/links to.
// Mirrors the original app's allowlist exactly.
const TRUSTED_EXTERNAL_HOSTS = new Set([
  'torbox.app',
  'www.torbox.app',
  'simkl.com',
  'www.simkl.com',
  'github.com',
  'themoviedb.org',
  'www.themoviedb.org',
  'myanimelist.net',
  'www.myanimelist.net',
  'opensubtitles.com',
  'www.opensubtitles.com'
])

/**
 * Returns true only for https URLs, with no embedded credentials, whose
 * host is on the trusted allowlist, and (for hosts where the original app
 * further restricted by path) whose path also matches.
 */
export function isAllowedExternalUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value))
    const host = url.hostname.toLowerCase()

    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !TRUSTED_EXTERNAL_HOSTS.has(host)
    ) {
      return false
    }

    // TODO(media-hub-integration): this path prefix ('/r3v07v3r/r3v07v3r-media-hub')
    // is specific to the old app's GitHub repo. If/when this project publishes
    // its own releases under a different repo, update this prefix to match —
    // do not remove the check, and do not guess a replacement value.
    if (host === 'github.com' && !url.pathname.startsWith('/r3v07v3r/r3v07v3r-media-hub')) {
      return false
    }

    if (
      (host === 'themoviedb.org' || host === 'www.themoviedb.org') &&
      !url.pathname.startsWith('/settings/')
    ) {
      return false
    }

    if (
      (host === 'myanimelist.net' || host === 'www.myanimelist.net') &&
      !['/v1/oauth2/authorize', '/apiconfig'].some((p) => url.pathname.startsWith(p))
    ) {
      return false
    }

    return true
  } catch {
    return false
  }
}

/** Runtime check for the `MediaKind` union — used to validate untrusted catalog-kind input from IPC. */
export function isValidCatalogKind(value: unknown): value is MediaKind {
  return value === 'movie' || value === 'series' || value === 'anime'
}

/**
 * Confirms an IPC message's claimed sender URL matches the expected origin
 * (scheme/host/path/search), used to reject spoofed senders. Hash fragments
 * are stripped from both sides before comparing: the renderer uses
 * HashRouter (see App.tsx), so the sender's real, trusted document URL
 * legitimately gains a `#/route` suffix on every client-side navigation —
 * comparing full `href` (which includes the hash) would reject every IPC
 * call made from anywhere but the exact initial route, which is not a
 * spoofing signal, just normal in-app navigation.
 */
export function isTrustedIpcSender(value: unknown, expected: unknown): boolean {
  try {
    const actual = new URL(String(value))
    const trusted = new URL(String(expected))
    actual.hash = ''
    trusted.hash = ''
    return actual.href === trusted.href
  } catch {
    return false
  }
}

/**
 * Sanitizes an untrusted list of `tracker:<url>` source strings (as seen in
 * torrent/magnet-style source lists) against SSRF: caps input size, requires
 * an allowed protocol, forbids embedded credentials, and rejects any host
 * that resolves to a private/loopback address or `localhost`. Caps output
 * to 20 deduplicated trackers.
 */
export function sanitizeTrackers(sources: unknown): string[] {
  const trackers: string[] = []

  for (const source of Array.isArray(sources) ? sources.slice(0, 40) : []) {
    if (typeof source !== 'string' || !source.startsWith('tracker:') || source.length > 520) {
      continue
    }

    try {
      const url = new URL(source.slice(8))
      const host = url.hostname.replace(/^\[|\]$/g, '')

      if (
        !['udp:', 'http:', 'https:', 'wss:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        isPrivateAddress(host) ||
        host === 'localhost'
      ) {
        continue
      }

      trackers.push(url.toString())
    } catch {
      // ignore malformed tracker URLs
    }
  }

  return [...new Set(trackers)].slice(0, 20)
}
