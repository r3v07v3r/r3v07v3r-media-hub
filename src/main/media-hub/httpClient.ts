// Ported from r3v07v3r-media-hub's src/main.cjs (getJson). The original
// bakes a TorBox-specific 401 side effect (clearTorBoxToken()) directly
// into this shared helper, because in main.cjs everything — including the
// TorBox client — lived in the same file/scope. This port keeps that
// coupling at the TorBox layer instead (see torbox.ts's torboxFetch, which
// wraps this and adds the same 401 behavior) so this module stays a
// generic, dependency-free JSON fetcher reusable by every other backend
// domain (Simkl, MAL, OpenSubtitles, Kitsu, Cinemeta, TMDB, ...). Runtime
// behavior for TorBox calls is unchanged — every request that used to go
// through the shared getJson still ends up going through the same 401
// handling, just via torboxFetch instead of inline.

export interface HttpError extends Error {
  status?: number
}

interface JsonErrorBody {
  detail?: string
  error?: string
  success?: boolean
}

const REQUEST_TIMEOUT_MS = 30000

/**
 * Fetches `url`, parses the response as JSON (tolerating a non-JSON/empty
 * body as `{}`), and throws an HttpError (with `.status` set to the HTTP
 * status code) when the response is non-ok OR the parsed body carries an
 * explicit `success: false` flag (several of these APIs signal failure
 * that way even on a 200). A 30s timeout aborts the request either way.
 */
export async function fetchJson<T = unknown>(
  url: string | URL,
  options: RequestInit = {}
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(String(url), { ...options, signal: controller.signal })
    const body = (await response.json().catch(() => ({}))) as JsonErrorBody &
      Record<string, unknown>

    if (!response.ok || body.success === false) {
      const error = new Error(
        body.detail || body.error || `Request failed (${response.status})`
      ) as HttpError
      error.status = response.status
      throw error
    }

    return body as T
  } finally {
    clearTimeout(timer)
  }
}
