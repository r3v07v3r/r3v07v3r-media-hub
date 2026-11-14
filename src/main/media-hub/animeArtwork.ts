/**
 * Artwork from AniList for an anime Kitsu gave none for.
 *
 * Kitsu's newer uploads only come as presigned links that expire in 15
 * minutes, which normalizeKitsuAnime drops (see expiringImageUrl.ts) — so a
 * new show such as Dragon Ball Super: Beerus arrives with no poster at all.
 * AniList hosts the same show's cover and banner on a CDN whose links last,
 * and the Kitsu -> AniList id is already mapped and cached (anilist.ts).
 *
 * Only titles with no poster are looked up: a title that has one keeps it,
 * so the crawl's thousand titles cost nothing here beyond the few new ones.
 * Best-effort throughout, like the rest of the AniList reads: a failed
 * lookup leaves the title as it was.
 */
import { fetchJson } from './httpClient'
import { getDatabase } from './dbState'
import { logError } from './logger'
import type { TaskPriority } from './taskScheduler'
import { anilistIdForKitsu } from './anilist'
import type { CatalogItem } from '../../shared/media-hub/types'
import { lastingImageUrl } from '../../shared/media-hub/expiringImageUrl'

const ANILIST_ENDPOINT = 'https://graphql.anilist.co'

/** Artwork changes rarely; a month matches the id mapping it hangs off. A
 *  title AniList has no art for is cached as blanks for the same month. */
const ART_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Ids per aliased request, as in anilist.ts. */
const BATCH_SIZE = 20

export interface AnilistArtwork {
  poster: string
  background: string
}

interface AnilistArtNode {
  coverImage?: { extraLarge?: string | null; large?: string | null } | null
  bannerImage?: string | null
}

/** One AniList Media node's artwork. Pure; exported for its test. */
export function artworkFromNode(node: AnilistArtNode | null | undefined): AnilistArtwork {
  return {
    poster: lastingImageUrl(node?.coverImage?.extraLarge, node?.coverImage?.large),
    background: lastingImageUrl(node?.bannerImage)
  }
}

function artKey(anilistId: number): string {
  return `anilist:art:${anilistId}`
}

async function fetchArtwork(
  ids: number[],
  priority: TaskPriority
): Promise<Map<number, AnilistArtwork>> {
  const db = getDatabase()
  const found = new Map<number, AnilistArtwork>()
  const missing: number[] = []
  for (const id of ids) {
    const cached = db.getCache<AnilistArtwork>(artKey(id))
    if (cached) found.set(id, cached)
    else missing.push(id)
  }
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE)
    const query = `query {
      ${batch
        .map(
          (id, index) =>
            `a${index}: Media(id: ${id}, type: ANIME) { coverImage { extraLarge large } bannerImage }`
        )
        .join('\n')}
    }`
    try {
      const result = await fetchJson<{ data?: Record<string, AnilistArtNode | null> }>(
        ANILIST_ENDPOINT,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ query })
        },
        { priority, label: 'AniList artwork' }
      )
      batch.forEach((id, index) => {
        const art = artworkFromNode(result.data?.[`a${index}`])
        db.putCache(artKey(id), art, ART_TTL_MS)
        found.set(id, art)
      })
    } catch (error) {
      logError('anime:anilist-artwork', error)
    }
  }
  return found
}

function kitsuIdOf(item: CatalogItem): string {
  const id = String(item.id ?? '')
  if (!id.startsWith('kitsu:')) return ''
  return id.slice('kitsu:'.length).split(':')[0]
}

/**
 * `items` with a poster (and, where it had none, a background) from AniList
 * for every Kitsu anime that came without a poster. Items are replaced, not
 * mutated; the list keeps its order and length.
 */
export async function withAnilistArtwork<T extends CatalogItem>(
  items: T[],
  priority: TaskPriority
): Promise<T[]> {
  const wanted = items.filter((item) => !item.poster && kitsuIdOf(item))
  if (!wanted.length) return items
  try {
    // All at once: the Kitsu lane paces the mapping requests that are not
    // cached already, across every caller (taskScheduler.ts).
    const kitsuIds = [...new Set(wanted.map(kitsuIdOf))]
    const mapped = await Promise.all(kitsuIds.map((id) => anilistIdForKitsu(id, priority)))
    const anilistIds = new Map<string, number>()
    kitsuIds.forEach((kitsuId, index) => {
      const anilistId = mapped[index]
      if (anilistId) anilistIds.set(kitsuId, anilistId)
    })
    if (!anilistIds.size) return items
    const art = await fetchArtwork([...new Set(anilistIds.values())], priority)
    return items.map((item) => {
      if (item.poster) return item
      const anilistId = anilistIds.get(kitsuIdOf(item))
      const found = anilistId ? art.get(anilistId) : undefined
      if (!found?.poster) return item
      return {
        ...item,
        poster: found.poster,
        background: item.background || found.background
      }
    })
  } catch (error) {
    logError('anime:anilist-artwork', error)
    return items
  }
}

/** withAnilistArtwork for one title. */
export async function withAnilistArtworkOne<T extends CatalogItem>(
  item: T,
  priority: TaskPriority
): Promise<T> {
  return (await withAnilistArtwork([item], priority))[0]
}
