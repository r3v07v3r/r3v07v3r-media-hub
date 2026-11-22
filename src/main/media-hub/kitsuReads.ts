// One Kitsu `/anime/{id}/mappings` read for everything that wants a piece
// of it. Four callers used to fetch the same URL under their own cache keys
// — the TheTVDB season (animeSeasons.ts), the AniList id (anilist.ts), the
// MAL id for skip times (aniskip.ts) and the id bridge's MAL fallback
// (idBridge.ts) — so one anime opened cold could cost four round trips to
// an API that has been taking anywhere from one second to a minute each.
// Now the first asks, the rest join it in flight or read the row it wrote.

import { fetchJson } from './httpClient'
import { getDatabase } from './dbState'
import type { TaskPriority } from './taskScheduler'

export interface KitsuMappingsPayload {
  data?: { attributes?: { externalSite?: string; externalId?: string | number } }[]
}

const MAPPINGS_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** How long a failed read is not asked again. Short: a failure is Kitsu
 *  being slow or down, not a fact about the title, and the page that
 *  wanted it degrades without it. Long enough that a grouping pass or a
 *  rebuild of a degraded page does not ask once per title per minute
 *  while Kitsu is timing out. */
const FAILURE_TTL_MS = 10 * 60 * 1000

function bareId(kitsuId: string | number): string {
  return String(kitsuId)
    .replace(/^kitsu:/, '')
    .split(':')[0]
}

/**
 * Kitsu's mappings for one anime, cached 30 days. Throws when Kitsu could
 * not be asked (and for ten minutes after, without asking), so a caller can
 * still tell "no mapping" from "no answer".
 */
export async function kitsuMappings(
  kitsuId: string | number,
  priority: TaskPriority = 'interactive'
): Promise<KitsuMappingsPayload> {
  const id = bareId(kitsuId)
  const db = getDatabase()
  const cached = db.getCache<KitsuMappingsPayload>(`kitsu:mappings:${id}`)
  if (cached) return cached
  if (db.getCache<boolean>(`kitsu:mappings-failed:${id}`)) {
    throw new Error('Kitsu did not answer for this title a few minutes ago.')
  }
  const url = `https://kitsu.io/api/edge/anime/${encodeURIComponent(id)}/mappings`
  try {
    const result = await fetchJson<KitsuMappingsPayload>(
      url,
      {},
      { priority, label: 'anime franchise mapping', key: url }
    )
    // Only the two fields anything reads: the raw rows carry links and
    // timestamps several times their size.
    const slim: KitsuMappingsPayload = {
      data: (result.data || []).map((m) => ({
        attributes: {
          externalSite: m.attributes?.externalSite,
          externalId: m.attributes?.externalId
        }
      }))
    }
    db.putCache(`kitsu:mappings:${id}`, slim, MAPPINGS_TTL_MS)
    return slim
  } catch (error) {
    db.putCache(`kitsu:mappings-failed:${id}`, true, FAILURE_TTL_MS)
    throw error
  }
}

/** The external id one mapping site gives, as a string; '' when none. */
export function mappedId(payload: KitsuMappingsPayload, site: string): string {
  const entry = (payload.data || []).find((m) => m.attributes?.externalSite === site)
  return String(entry?.attributes?.externalId ?? '')
}

// ---------------------------------------------------------------------
// `/media-relationships?include=destination`: the same URL is read by the
// grouping pass's sequel edges (animeSeasons.ts), the detail page's story
// links (animeStory.ts) and its Related row (catalog.ts). The page asks
// for the last two at the same moment, so each open paid for the read
// twice. Joined in flight, and the answer held in memory for a few minutes
// — long enough for the reads one page open makes, without a second copy
// of every relationship payload in the database next to the three derived
// rows each caller already keeps.
//
// include=destination is required, not optional: Kitsu omits
// relationships.destination.data (the id itself) without it, despite
// JSON:API keeping linkage independent of `include`.

const RELATIONSHIPS_MEMO_MS = 5 * 60 * 1000
const RELATIONSHIPS_MEMO_MAX = 50
const relationshipsMemo = new Map<string, { at: number; payload: Promise<unknown> }>()

/** Kitsu's relationships for one anime, with their destinations included. */
export function kitsuRelationships<T = unknown>(
  kitsuId: string | number,
  priority: TaskPriority = 'interactive',
  label = 'anime relationships'
): Promise<T> {
  const id = bareId(kitsuId)
  const now = Date.now()
  const memo = relationshipsMemo.get(id)
  if (memo && now - memo.at < RELATIONSHIPS_MEMO_MS) return memo.payload as Promise<T>
  const url = `https://kitsu.io/api/edge/anime/${encodeURIComponent(id)}/media-relationships?include=destination&page%5Blimit%5D=20`
  const payload = fetchJson<T>(url, {}, { priority, label, key: url })
  relationshipsMemo.set(id, { at: now, payload })
  // A failure is not held: each caller has its own stale-row fallback.
  payload.catch(() => {
    if (relationshipsMemo.get(id)?.payload === payload) relationshipsMemo.delete(id)
  })
  if (relationshipsMemo.size > RELATIONSHIPS_MEMO_MAX) {
    const oldest = relationshipsMemo.keys().next().value
    if (oldest !== undefined) relationshipsMemo.delete(oldest)
  }
  return payload
}

// ---------------------------------------------------------------------
// Kitsu's slow answers are not slow, they are stuck: timed on 22 Nov 2026
// the same record came back in 1.5-5 s or not until the 30 s timeout (or a
// 504 at 60), with little in between. Waiting out a stuck one cost the page
// half a minute; asking again once the first has had a fair chance usually
// lands in a few seconds. Whichever answers first wins; the other is left
// to its own timeout.

const HEDGE_AFTER_MS = 8000

/** fetchJson for one Kitsu read the page is waiting on, re-asked once if
 *  the first has not answered in eight seconds. */
export function kitsuHedged<T>(url: string, priority: TaskPriority, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let pending = 1
    const win = (value: T): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const lose = (error: unknown): void => {
      pending--
      // A first try that fails before the hedge is due is an answer (a 404,
      // a refused connection): no point waiting eight seconds to repeat it.
      if (settled || pending > 0) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }
    fetchJson<T>(url, {}, { priority, label }).then(win, lose)
    const timer = setTimeout(() => {
      if (settled) return
      pending++
      fetchJson<T>(url, {}, { priority, label: `${label} (second try)` }).then(win, lose)
    }, HEDGE_AFTER_MS)
  })
}
