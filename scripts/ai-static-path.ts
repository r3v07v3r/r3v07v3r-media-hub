// Path resolution for the ai:screenshot / ai:loop static server, kept apart
// from ai-screenshots.ts so it can be unit-tested without starting a server
// or loading Playwright.
//
// The server binds 127.0.0.1 on an ephemeral port, but any local process (or
// a DNS-rebinding page that finds the port) can reach it, so a request path
// must never resolve outside the directory being served: `/../../.env.local`
// or `/..%2f..%2f.env.local` used to return the developer's secrets.

import path from 'node:path'

/** True when `candidate` is `root` itself or lies underneath it. Both must be absolute. */
export function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..')
}

/**
 * Maps a raw request target (`req.url`) to an absolute file path under
 * `serveDir`, or null when it is malformed or would escape `serveDir`.
 *
 * The decoded path is resolved relative to the root ('.' + urlPath, so a
 * leading '/' or a drive-letter cannot make it absolute) and then required to
 * stay inside it — which also covers encoded separators and backslashes,
 * since the check runs on the fully decoded, normalised result.
 */
export function resolveStaticPath(serveDir: string, rawUrl: string | undefined): string | null {
  let urlPath: string
  try {
    urlPath = decodeURIComponent((rawUrl ?? '/').split('?')[0].split('#')[0])
  } catch {
    return null
  }
  if (urlPath.includes('\0')) return null
  const root = path.resolve(serveDir)
  const resolved = path.resolve(root, '.' + (urlPath.startsWith('/') ? '' : '/') + urlPath)
  return isInsideRoot(root, resolved) ? resolved : null
}

/** True when the Host header names the loopback address the server is bound to — blocks DNS rebinding. */
export function isAllowedHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false
  const host = hostHeader.toLowerCase()
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
}
