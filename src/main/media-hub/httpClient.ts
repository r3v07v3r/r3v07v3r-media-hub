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

import {
  readLimitedResponseBytes,
  ResponseTooLargeError
} from '../../shared/media-hub/responseLimit'
import { laneForUrl, schedule, type TaskPriority } from './taskScheduler'

export interface HttpError extends Error {
  status?: number
  /** On a 429, how long the service asked to be left alone, from its
   *  Retry-After header. Absent when it did not say. */
  retryAfterMs?: number
}

interface JsonErrorBody {
  detail?: string
  error?: string
  success?: boolean
}

interface FetchScheduling {
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
  /**
   * Override the response size cap (DEFAULT_MAX_RESPONSE_BYTES) for a call
   * known to answer with something larger than an ordinary API page.
   */
  maxResponseBytes?: number
  /**
   * Reject when the body could not be read to its end, or is not JSON,
   * instead of answering `{}`.
   *
   * The lenient default suits a call whose body is a status and little
   * else. It is wrong for one whose body IS the answer: a whole-library
   * read cut off by the timeout or a dropped connection would come back as
   * an empty library, and a caller that then records "library read" has
   * skipped everything in it. An empty body still reads as `{}` — that is
   * how an empty library is spelled.
   */
  strictBody?: boolean
}

const REQUEST_TIMEOUT_MS = 30000

/**
 * The most a single response body may be before the read is abandoned.
 *
 * Every JSON API call in the app comes through here, so without a cap one
 * hostile or broken upstream could make the process buffer an unbounded
 * body. The largest legitimate answers are whole-library reads — Simkl's
 * all-items with per-episode watch times, a big Jellyfin or TorBox listing,
 * a batched AniList query — which should stay in single-digit megabytes for a
 * heavy account, so 64 MiB leaves an order of magnitude of headroom while
 * still bounding the worst case.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024

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
  return schedule(
    () =>
      request<T>(
        url,
        options,
        scheduling.timeoutMs,
        scheduling.maxResponseBytes,
        scheduling.strictBody
      ),
    {
      lane: scheduling.lane ?? laneForUrl(url),
      priority: scheduling.priority ?? 'interactive',
      key: scheduling.key,
      label: scheduling.label ?? hostLabel(url)
    }
  )
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
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  strictBody = false
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(String(url), { ...options, signal: controller.signal })
    // Lenient for a failed response whatever was asked: its body is only
    // read for an error message, and the status is thrown below either way.
    const body = (await readJsonBody(
      response,
      maxResponseBytes,
      strictBody && response.ok
    )) as JsonErrorBody & Record<string, unknown>

    if (!response.ok || body.success === false) {
      const error = new Error(
        body.detail || body.error || `Request failed (${response.status})`
      ) as HttpError
      error.status = response.status
      if (response.status === 429) {
        const wait = retryAfterMs(response.headers.get('retry-after'), Date.now())
        if (wait != null) error.retryAfterMs = wait
      }
      throw error
    }

    return body as T
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The body parsed as JSON, read under `maxBytes`.
 *
 * Mirrors what `response.json().catch(() => ({}))` used to give — an empty,
 * non-JSON or unreadable body becomes `{}` — with the one exception that a
 * body over the cap rejects, so it surfaces as an ordinary request error
 * instead of being buffered.
 *
 * `strict` (FetchScheduling.strictBody) rejects the other two as well: a
 * read that failed part way — the timeout firing mid-stream, a connection
 * dropped — and text that is there but does not parse. Only a body with
 * nothing in it still reads as `{}`.
 */
async function readJsonBody(
  response: Response,
  maxBytes: number,
  strict = false
): Promise<unknown> {
  let text: string
  try {
    text = new TextDecoder().decode(await readLimitedResponseBytes(response, maxBytes))
  } catch (error) {
    if (error instanceof ResponseTooLargeError || strict) throw error
    return {}
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    if (strict && text.trim()) throw error
    return {}
  }
}

/**
 * A Retry-After header as milliseconds from `nowMs`: either a number of
 * seconds or an HTTP date. Undefined for anything else, including no header.
 */
export function retryAfterMs(header: string | null | undefined, nowMs: number): number | undefined {
  const value = String(header ?? '').trim()
  if (!value) return undefined
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000)
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined
}

/** The longest a push waits on a 429 before trying once more. A service
 *  that asks for longer is not waited on here: the push fails as it always
 *  did, and whatever retries failed pushes takes it from there. */
export const MAX_RETRY_AFTER_MS = 60_000

/** How long a 429 with no Retry-After is waited out. */
const DEFAULT_RETRY_AFTER_MS = 1_000

/**
 * Sends a push, and if the service answers 429, waits the time it asked for
 * and sends it once more.
 *
 * Simkl and Trakt both limit how fast an account may write, and the bursts
 * this app makes (a season marked, a review batch flushed alongside a mark)
 * can trip that limit with a request that is otherwise fine. Treated as an
 * ordinary failure, that push was lost. One delayed retry is what the
 * header is asking for; a second 429 is a real failure and is thrown. The
 * wait happens outside the scheduler's lane, so nothing else queues behind
 * it.
 */
export async function retryOnceOn429<T>(
  send: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms))
): Promise<T> {
  try {
    return await send()
  } catch (error) {
    const failure = error as HttpError
    if (failure?.status !== 429) throw error
    const wait = failure.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS
    if (wait > MAX_RETRY_AFTER_MS) throw error
    await sleep(wait)
    return send()
  }
}
