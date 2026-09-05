// Anime detail-page story lookup. This is intentionally separate from
// catalog.ts's broad "related titles" helper: that list also contains
// spin-offs, recaps, and alternate settings for recommendation filtering;
// here we need the direct prequel/sequel answer a person can act on.

import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import type { AnimeStoryResult } from '../../shared/media-hub/types'
import { animeStoryLinks, type RawApiPayload } from './core'
import { getDatabase } from './dbState'
import { fetchJson } from './httpClient'
import { handle } from './ipcGuard'
import { logError } from './logger'
import { isValidCatalogKind } from './security'

const STORY_TTL_MS = 24 * 60 * 60 * 1000

interface CatalogStoryPayload {
  type?: unknown
  id?: unknown
}

/** A failed live request can use a stale known answer; otherwise it says it
 * was not checked rather than silently reporting "no sequel exists." */
async function storyForAnime(id: string): Promise<AnimeStoryResult> {
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
      `https://kitsu.io/api/edge/anime/${encodeURIComponent(kitsuId)}/media-relationships?include=destination&page%5Blimit%5D=20`
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

/** Registers the narrowly-scoped anime sequel/prequel lookup. */
export function registerAnimeStoryIpc(): void {
  handle<CatalogStoryPayload, AnimeStoryResult>(
    MEDIA_HUB_CHANNELS.catalogStory,
    async (_event, payload) => {
      const kind = payload?.type
      if (!isValidCatalogKind(kind) || kind !== 'anime') return { links: [], checked: true }
      return storyForAnime(String(payload?.id || ''))
    }
  )
}
