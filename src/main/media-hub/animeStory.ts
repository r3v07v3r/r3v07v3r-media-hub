// Anime detail-page story lookup. This is intentionally separate from
// catalog.ts's broad "related titles" helper: that list also contains
// spin-offs, recaps, and alternate settings for recommendation filtering;
// here we need the direct prequel/sequel answer a person can act on.

import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import type { AnimeStoryResult } from '../../shared/media-hub/types'
import { groupedIdsFor, laterSeasonOf } from './animeSeasons'
import { animeStoryLinks, mergedShowStoryLinks, type RawApiPayload } from './core'
import { getDatabase } from './dbState'
import { fetchJson } from './httpClient'
import { handle } from './ipcGuard'
import { logError } from './logger'
import { isValidCatalogKind } from './security'
import type { TaskPriority } from './taskScheduler'

const STORY_TTL_MS = 24 * 60 * 60 * 1000

interface CatalogStoryPayload {
  type?: unknown
  id?: unknown
}

/** A failed live request can use a stale known answer; otherwise it says it
 * was not checked rather than silently reporting "no sequel exists." */
export async function storyForAnime(
  id: string,
  priority: TaskPriority = 'interactive'
): Promise<AnimeStoryResult> {
  // v2: side stories, spin-offs, recaps and full stories are part of the
  // answer now; a v1 row would read back with only sequels and prequels.
  const key = `story:v2:anime:${id}`
  const db = getDatabase()
  const cached = db.getCache<AnimeStoryResult>(key)
  if (cached) return cached

  try {
    const kitsuId = String(id)
      .replace(/^kitsu:/, '')
      .split(':')[0]
    const payload = await fetchJson<RawApiPayload>(
      `https://kitsu.io/api/edge/anime/${encodeURIComponent(kitsuId)}/media-relationships?include=destination&page%5Blimit%5D=20`,
      {},
      { priority }
    )
    const value: AnimeStoryResult = { links: animeStoryLinks(payload), checked: true }
    db.putCache(key, value, STORY_TTL_MS)
    return value
  } catch (error) {
    logError('catalog:story:anime', error)
    return (
      db.getCache<AnimeStoryResult>(key, { allowExpired: true }) || { links: [], checked: false }
    )
  }
}

/**
 * The story around a title as its PAGE shows it: a merged show is asked as
 * the whole show, not as its first season.
 *
 * continuations.ts asks the same question for the Home row, of the last
 * season only. The page wants the other end too — see mergedShowStoryLinks
 * for what is taken from which. A later season's own id is answered as its
 * show, since that is the page it opens (catalog.ts's meta handler).
 */
export async function storyForShow(
  id: string,
  priority: TaskPriority = 'interactive'
): Promise<AnimeStoryResult> {
  const showId = laterSeasonOf(id)?.id ?? id
  // The same lookup metadata() builds the page's seasons from, so what is
  // dropped here is exactly what the page already lists.
  const members = [showId, ...(groupedIdsFor(showId) ?? [])]
  if (members.length === 1) return storyForAnime(showId, priority)
  const [first, last] = await Promise.all([
    storyForAnime(showId, priority),
    storyForAnime(members[members.length - 1], priority)
  ])
  return {
    links: mergedShowStoryLinks(members, first.links, last.links),
    // Unchecked at either end is unchecked: with the last season's answer
    // missing, "no sequel listed" would be a claim nobody looked up.
    checked: first.checked && last.checked
  }
}

/** Registers the narrowly-scoped anime sequel/prequel lookup. */
export function registerAnimeStoryIpc(): void {
  handle<CatalogStoryPayload, AnimeStoryResult>(
    MEDIA_HUB_CHANNELS.catalogStory,
    async (_event, payload) => {
      const kind = payload?.type
      if (!isValidCatalogKind(kind) || kind !== 'anime') return { links: [], checked: true }
      return storyForShow(String(payload?.id || ''))
    }
  )
}
