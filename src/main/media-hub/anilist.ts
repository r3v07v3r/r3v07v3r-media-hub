// AniList's relations graph, used as a SECOND franchise-grouping signal
// alongside Kitsu's own media-relationships (animeSeasons.ts's
// kitsuSequelEdges) — added specifically for the gap the anime catalog
// audit measured live against a real user's database: TheTVDB has no
// mapping at all for 45% of crawled anime (591 of 1,070 lookups), and
// those titles fall back to Kitsu's own relationship graph — which is the
// exact same shape of signal (a relationship-type label, no season
// ordinal) AniList's is, just from a different provider. AniList is a
// second attempt at the same fallback question, not a replacement for
// TheTVDB/TMDB, which still own real season numbers and per-episode data.
//
// SCOPE, DELIBERATELY NARROW — AniList's terms (docs.anilist.co/guide/
// terms-of-use, confirmed live 2026-08-10) explicitly prohibit "hoarding
// or mass collection of data from the AniList API" and using it "as a
// backup or data storage service." This only ever queries relations for
// the SAME bounded needsEdgeCheck subset animeSeasons.ts already limits
// Kitsu's own edge-fetch to (titles already being crawled from Kitsu,
// AND only the ones TheTVDB couldn't map — not the full ~1000-title
// crawl, and never AniList's catalog at large), and every result is
// cached 30 days: a franchise's relation graph does not meaningfully
// change week to week, so a steady-state 6h re-crawl re-queries AniList
// only for titles it has genuinely never resolved before. This is
// per-lookup enrichment of a real, identified gap, not a standing mirror
// of AniList's database.
//
// RATE LIMIT — confirmed live via AniList's own X-RateLimit-Limit
// response header on 2026-08-10: 30 requests/minute (AniList's current,
// degraded tier; do not assume the nominal 90/min holds). Batched via
// GraphQL aliasing — one HTTP request resolves many titles' relations at
// once, confirmed live the same day — and paced well under the ceiling.

import { fetchJson } from './httpClient'
import { logError } from './logger'
import { getDatabase } from './dbState'

const ANILIST_ENDPOINT = 'https://graphql.anilist.co'

/** Titles per aliased request. AniList's limit is on REQUEST count, not
 *  query count, so batching many ids into one request is what actually
 *  matters for staying under it — not how many ids are in the batch. 20
 *  keeps a single request's response a reasonable size and matches the
 *  batch size every other paced loop in this file already uses. */
const ANILIST_BATCH_SIZE = 20

/** ~24 requests/minute sustained — under the confirmed 30/min ceiling
 *  with real headroom for the rest of this app's own traffic and for
 *  AniList's limit being per-IP-shared across whatever else is running
 *  on this machine. */
const ANILIST_BATCH_PACING_MS = 2_500

/** A franchise's relation graph is close to static — new entries appear,
 *  existing ones essentially never change their relationType. 30 days
 *  matches the TTL every other id-bridging cache in this file already
 *  uses (kitsu:tvdb:*, tvdb:tmdb-tv:*). */
const RELATIONS_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Sentinel for "confirmed no AniList id" — same convention
 *  tmdbTvIdFromTvdb (animeSeasons.ts) already uses: a cached miss must
 *  be distinguishable from "never looked up," or every miss gets
 *  re-fetched forever. */
const NO_ANILIST_ID = -1

/**
 * Extracts the AniList numeric id from a Kitsu `/mappings` response —
 * pure, so it's testable without a live fetch. `result` is the same
 * JSON:API payload animeSeasons.ts's kitsuTvdbMapping already parses for
 * its own `thetvdb` entry; confirmed live (audit, 2026-08-10) that the
 * same response also carries an `anilist/anime` entry for most
 * non-obscure titles, so this reads a field already being fetched rather
 * than costing a second live request.
 */
export function anilistIdFromKitsuMappings(mappings: {
  data?: { attributes?: { externalSite?: string; externalId?: string } }[]
}): number | null {
  const entry = (mappings.data || []).find((x) => x.attributes?.externalSite === 'anilist/anime')
  const id = Number(entry?.attributes?.externalId)
  return Number.isInteger(id) && id > 0 ? id : null
}

export interface AnilistSeasonChainEdge {
  relationType: string
  targetAnilistId: number
}

export interface AnilistMediaNode {
  id: number
  format?: string | null
  season?: string | null
  seasonYear?: number | null
  relations?: { edges?: { relationType?: string; node?: { id?: number; format?: string } }[] }
}

/** Only these relationTypes describe "the next/previous numbered season
 *  of the SAME story" — confirmed live (audit) against real franchises:
 *  Attack on Titan's SEQUEL edge points at a real TV "Season 2" entry,
 *  while its PREQUEL edge points at an OVA that is chronologically
 *  earlier but not a numbered season. Every other relationType
 *  (ADAPTATION, SIDE_STORY, SUMMARY, SPIN_OFF, ALTERNATIVE, CHARACTER,
 *  OTHER, ...) describes a different KIND of relationship, not a season
 *  continuation — including them would merge a manga adaptation, a
 *  recap special, or an unrelated spinoff into the same tile as a
 *  franchise's real seasons. PARENT is included alongside PREQUEL/SEQUEL
 *  for the same "same story, adjacent position" reason. */
const SEASON_CHAIN_RELATIONS = new Set(['PREQUEL', 'SEQUEL', 'PARENT'])

/** Also confirmed live: One Piece's entire relations list (specials,
 *  movies, recaps) carries no PREQUEL/SEQUEL/PARENT edge at all — a
 *  single continuous TV entry has nothing to chain, and this filter
 *  correctly finds nothing for it rather than merging in a movie/special
 *  as if it were a season. Format is checked on the EDGE TARGET, not the
 *  source: a franchise's spinoff movie can carry a PREQUEL/SEQUEL label
 *  toward a real season without itself being one. */
export function seasonChainEdges(node: AnilistMediaNode): AnilistSeasonChainEdge[] {
  return (node.relations?.edges || [])
    .filter((e): e is { relationType: string; node: { id: number; format: string } } =>
      Boolean(
        e.relationType &&
        SEASON_CHAIN_RELATIONS.has(e.relationType) &&
        e.node?.format === 'TV' &&
        Number.isInteger(e.node?.id)
      )
    )
    .map((e) => ({ relationType: e.relationType, targetAnilistId: e.node.id }))
}

/** WINTER < SPRING < SUMMER < FALL within a year — AniList's own
 *  broadcast-quarter ordering, confirmed live via the MediaSeason enum.
 *  Computed here explicitly rather than trusting AniList's own
 *  `seasonInt` scalar, whose encoding is undocumented. */
const SEASON_ORDINAL: Record<string, number> = { WINTER: 1, SPRING: 2, SUMMER: 3, FALL: 4 }

/**
 * A chronological sort key from AniList's own season+year, for ordering
 * franchise members that TheTVDB couldn't season-number — real broadcast
 * date, not Kitsu's upload-order id, which is only ever a proxy for it.
 * Pure and testable. Null when either half is missing/unrecognized.
 */
export function anilistSeasonOrderKey(
  season: string | null | undefined,
  seasonYear: number | null | undefined
): number | null {
  const ordinal = season ? SEASON_ORDINAL[season] : undefined
  if (!ordinal || !Number.isInteger(seasonYear) || !seasonYear) return null
  return seasonYear * 10 + ordinal
}

export interface AnilistTitleInfo {
  seasonOrderKey: number | null
  chainEdges: AnilistSeasonChainEdge[]
}

async function fetchAnilistBatch(ids: number[]): Promise<Record<string, AnilistMediaNode | null>> {
  const query = `query {
    ${ids
      .map(
        (id, i) => `a${i}: Media(id: ${id}, type: ANIME) {
      id format season seasonYear
      relations { edges { relationType node { id format } } }
    }`
      )
      .join('\n')}
  }`
  const result = await fetchJson<{ data?: Record<string, AnilistMediaNode | null> }>(
    ANILIST_ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query })
    }
  )
  return result.data || {}
}

/**
 * Resolves season-chain info for a batch of AniList ids, cached
 * individually so a steady-state re-crawl only pays for ids it has
 * genuinely never seen before. Best-effort throughout: a failed id, or a
 * failed batch, contributes nothing rather than failing the whole crawl
 * — exactly the same convention kitsuSequelEdges/kitsuTvdbMapping
 * already use for the same reason (a transient failure here should
 * degrade grouping quality, never take playback-adjacent code down).
 */
export async function anilistTitleInfo(ids: number[]): Promise<Map<number, AnilistTitleInfo>> {
  const db = getDatabase()
  const results = new Map<number, AnilistTitleInfo>()
  const uncached: number[] = []

  for (const id of ids) {
    const cached = db.getCache<AnilistTitleInfo>(`anilist:relations:${id}`)
    if (cached) results.set(id, cached)
    else uncached.push(id)
  }

  for (let i = 0; i < uncached.length; i += ANILIST_BATCH_SIZE) {
    const batch = uncached.slice(i, i + ANILIST_BATCH_SIZE)
    try {
      const nodes = await fetchAnilistBatch(batch)
      batch.forEach((id, idx) => {
        const node = nodes[`a${idx}`]
        const info: AnilistTitleInfo = node
          ? {
              seasonOrderKey: anilistSeasonOrderKey(node.season, node.seasonYear),
              chainEdges: seasonChainEdges(node)
            }
          : { seasonOrderKey: null, chainEdges: [] }
        db.putCache(`anilist:relations:${id}`, info, RELATIONS_TTL_MS)
        results.set(id, info)
      })
    } catch (error) {
      logError('anime:anilist-relations', error)
      // Nothing cached for this batch's ids — they simply contribute no
      // AniList signal this crawl, same as if they'd never been queried.
    }
    if (i + ANILIST_BATCH_SIZE < uncached.length) {
      await new Promise((resolve) => setTimeout(resolve, ANILIST_BATCH_PACING_MS))
    }
  }

  return results
}

/** Cached (30d) AniList id for one Kitsu anime id, extracted from the
 *  SAME Kitsu `/mappings` response animeSeasons.ts's kitsuTvdbMapping
 *  already fetches for every crawled item — see cacheAnilistIdFromMappings
 *  below, which that function calls as a side effect so this never costs
 *  a second live request on its own. */
export function cachedAnilistId(kitsuId: string): number | null {
  const cached = getDatabase().getCache<number>(`kitsu:anilist:${kitsuId}`)
  return cached !== null && cached > 0 ? cached : null
}

/** Called by kitsuTvdbMapping as a side effect of the `/mappings` fetch
 *  it already makes for every crawled item — reads the same payload for
 *  an `anilist/anime` entry and caches it under its own key so
 *  cachedAnilistId can read it back with no additional request. */
export function cacheAnilistIdFromMappings(
  kitsuId: string,
  mappings: { data?: { attributes?: { externalSite?: string; externalId?: string } }[] }
): void {
  const id = anilistIdFromKitsuMappings(mappings)
  getDatabase().putCache(`kitsu:anilist:${kitsuId}`, id ?? NO_ANILIST_ID, RELATIONS_TTL_MS)
}
