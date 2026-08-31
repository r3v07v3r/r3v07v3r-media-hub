// Ported from r3v07v3r-media-hub's src/main.cjs (getJson). The original
// bakes a TorBox-specific 401 side effect (clearTorBoxToken()) directly
// into this shared helper, because in main.cjs everything — including the
// TorBox client — lived in the same file/scope. This port keeps that
// coupling at the TorBox layer instead (see torbox.ts's torboxFetch, which
// wraps this and adds the same 401 behavior) so this module stays a
// generic JSON fetcher reusable by every other backend domain (Simkl, MAL,
// OpenSubtitles, Kitsu, Cinemeta, TMDB, ...). Runtime behavior for TorBox
// calls is unchanged — every request that used to go through the shared
// getJson still ends up going through the same 401 handling, just via
// torboxFetch instead of inline.
//
// New since the port: every call made through here is dispatched by the
// central scheduler (taskScheduler.ts) rather than going straight out.
// This is the single choke point for all of this app's API traffic — every
// backend module reaches the network through this one function — so it is
// the one place where per-upstream concurrency limits and the
// interactive-before-background hierarchy can be applied to all of it at
// once, instead of each module having to remember to pace itself and
// having no way at all to pace itself relative to the others.
//
// Note what is deliberately NOT routed through here: streamCache.ts opens
// the actual video byte stream with its own client. Playback bytes must
// never queue behind a catalog crawl, and the stream cache already owns
// its own connection budget against TorBox's per-link limits.

import { laneForUrl, schedule, type TaskPriority } from './taskScheduler'

export interface HttpError extends Error {
  status?: number
}

interface JsonErrorBody {
  detail?: string
  error?: string
  success?: boolean
}

export interface FetchScheduling {
  /**
   * Which tier this request belongs to — see taskScheduler.ts.
   *
   * Defaults to `interactive`, i.e. "assume somebody is waiting for this".
   * That default is deliberate: it means an un-annotated call behaves the
   * way it always did, and only a caller that knows its work is bulk or
   * deferrable has to say so. The cost of getting it wrong in this
   * direction is a request that runs sooner than it needed to; in the
   * other direction it would be a spinner nobody told the scheduler about.
   */
  priority?: TaskPriority
  /** Override the upstream lane, which is otherwise derived from the URL's
   *  host. Rarely needed — one host is normally one budget. */
  lane?: string
  /** Coalescing key. Two identical in-flight requests share one round
   *  trip. Only safe where the response does not depend on anything but
   *  the URL. */
  key?: string
  /** What to call this in the activity view. Defaults to the host. */
  label?: string
  /**
   * Override the 30s default, for the rare call that legitimately takes
   * longer — the cache server's "update now" answers only once it has
   * checked the release feed and staged a bundle, which on a slow link is
   * minutes rather than seconds, and timing that out would report a
   * failure for an update that was in fact working.
   */
  timeoutMs?: number
}

const REQUEST_TIMEOUT_MS = 30000

/**
 * Fetches `url`, parses the response as JSON (tolerating a non-JSON/empty
 * body as `{}`), and throws an HttpError (with `.status` set to the HTTP
 * status code) when the response is non-ok OR the parsed body carries an
 * explicit `success: false` flag (several of these APIs signal failure
 * that way even on a 200). A 30s timeout aborts the request either way.
 *
 * The timeout is armed at dispatch, not when this is called, so a request
 * that waits its turn in the queue still gets its full 30 seconds on the
 * wire rather than having spent them queueing.
 */
export function fetchJson<T = unknown>(
  url: string | URL,
  options: RequestInit = {},
  scheduling: FetchScheduling = {}
): Promise<T> {
  return schedule(() => request<T>(url, options, scheduling.timeoutMs), {
    lane: scheduling.lane ?? laneForUrl(url),
    priority: scheduling.priority ?? 'interactive',
    key: scheduling.key,
    label: scheduling.label ?? hostLabel(url)
  })
}

function hostLabel(url: string | URL): string {
  try {
    return new URL(String(url)).hostname
  } catch {
    return 'request'
  }
}

async function request<T>(
  url: string | URL,
  options: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

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
