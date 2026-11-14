/**
 * Image links that stop working minutes after they are handed out.
 *
 * Kitsu moved its newer uploads to a Backblaze bucket and answers with a
 * presigned S3 link that expires after 15 minutes (`X-Amz-Expires=900`).
 * Older titles still get a lasting `media.kitsu.app` link, so this only
 * showed on new shows: Dragon Ball Super: Beerus (kitsu:50497) was stored
 * with a link that answered 401 by the time anyone looked at its card.
 * Anything this app keeps — a cache entry, an index row, a tracked title —
 * outlives fifteen minutes, so a presigned link is as good as no link and
 * is treated as one.
 *
 * Pure; see tests/expiringImageUrl.test.ts.
 */

/** True for a presigned link: AWS SigV4 (`X-Amz-Signature` /
 *  `X-Amz-Expires`, which Backblaze's S3 API also uses) or the older
 *  `Signature` + `Expires` pair (S3 v2, CloudFront). */
export function isExpiringImageUrl(url: unknown): boolean {
  if (typeof url !== 'string' || !url.includes('?')) return false
  let params: URLSearchParams
  try {
    params = new URL(url).searchParams
  } catch {
    return false
  }
  return (
    params.has('X-Amz-Signature') ||
    params.has('X-Amz-Expires') ||
    (params.has('Signature') && params.has('Expires'))
  )
}

/** The first of `candidates` that is a non-empty link that will still work
 *  later, or '' when there is none. */
export function lastingImageUrl(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate && !isExpiringImageUrl(candidate)) {
      return candidate
    }
  }
  return ''
}

/** The keys an image link is stored under in this app's records. */
const IMAGE_KEYS = new Set(['poster', 'background', 'logo', 'thumbnail', 'posterUrl'])

/**
 * `value` with every expiring link under an image key replaced by '' —
 * at any depth, so a catalog list, a story panel's links or a title's
 * episode list are all cleaned in one pass. Returns the same object when
 * nothing changed, so a caller can tell whether there is anything to write.
 */
export function withoutExpiringImages<T>(value: T): T {
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((entry) => {
      const cleaned = withoutExpiringImages(entry)
      if (cleaned !== entry) changed = true
      return cleaned
    })
    return (changed ? next : value) as T
  }
  if (!value || typeof value !== 'object') return value
  let next: Record<string, unknown> | null = null
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const cleaned =
      IMAGE_KEYS.has(key) && isExpiringImageUrl(entry) ? '' : withoutExpiringImages(entry)
    if (cleaned !== entry) {
      next ??= { ...(value as Record<string, unknown>) }
      next[key] = cleaned
    }
  }
  return (next ?? value) as T
}
