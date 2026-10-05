// Anime detail-page story lookup. This is intentionally separate from
// catalog.ts's broad "related titles" helper: that list also contains
// spin-offs, recaps, and alternate settings for recommendation filtering;
// here we need the direct prequel/sequel answer a person can act on.

import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import type {
  AnimeStoryOrder,
  AnimeStoryResult,
  AnimeTimelineEntry
} from '../../shared/media-hub/types'
import {
  animeShowParts,
  animeShowTimelineParts,
  groupedIdsFor,
  laterSeasonOf
} from './animeSeasons'
import {
  animeReleaseTimeline,
  animeStoryLinks,
  animeStoryTimeline,
  mergedShowStoryLinks,
  type RawApiPayload
} from './core'
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
  order?: unknown
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
 *
 * `order` decides the timeline that comes with it (AnimeStoryResult): in
 * release order a merged show's seasons with its films and OVAs between
 * them, which costs nothing more; in story order every part of the show and
 * everything they link to, which asks Kitsu for each part's links (each
 * kept a day) and so is only worked out when somebody chose it.
 */
export async function storyForShow(
  id: string,
  priority: TaskPriority = 'interactive',
  order: AnimeStoryOrder = 'release'
): Promise<AnimeStoryResult> {
  const showId = laterSeasonOf(id)?.id ?? id
  // The same lookup metadata() builds the page's seasons from, so what is
  // dropped here is exactly what the page already lists.
  const members = [showId, ...(groupedIdsFor(showId) ?? [])]
  if (members.length === 1) {
    const story = await storyForAnime(showId, priority)
    if (order !== 'story') return story
    return { ...story, timeline: await storyTimeline(animeShowTimelineParts(showId), priority) }
  }
  const [first, last] = await Promise.all([
    storyForAnime(showId, priority),
    storyForAnime(members[members.length - 1], priority)
  ])
  const story: AnimeStoryResult = {
    links: mergedShowStoryLinks(members, first.links, last.links),
    // Unchecked at either end is unchecked: with the last season's answer
    // missing, "no sequel listed" would be a claim nobody looked up.
    checked: first.checked && last.checked
  }
  if (order === 'story') {
    return { ...story, timeline: await storyTimeline(animeShowTimelineParts(showId), priority) }
  }
  // Release order lists the seasons only to place the films between them:
  // with none, the season tabs already say it all.
  if (!animeShowParts(showId)?.extras.length) return story
  const parts = animeShowTimelineParts(showId)
  return {
    ...story,
    timeline: animeReleaseTimeline(
      parts.filter((part) => part.season !== undefined),
      parts.filter((part) => part.season === undefined)
    )
  }
}

/**
 * The show's parts and everything they link to, in story order: each part's
 * own links are asked for (storyForAnime, kept a day) and put in order by
 * core.ts's animeStoryTimeline.
 */
async function storyTimeline(
  parts: readonly AnimeTimelineEntry[],
  priority: TaskPriority
): Promise<AnimeTimelineEntry[]> {
  const stories = await Promise.all(
    parts.map((part) => storyForAnime(String(part.item.id), priority))
  )
  return animeStoryTimeline(
    parts,
    stories.map((story) => story.links)
  )
}

/** Registers the narrowly-scoped anime sequel/prequel lookup. */
export function registerAnimeStoryIpc(): void {
  handle<CatalogStoryPayload, AnimeStoryResult>(
    MEDIA_HUB_CHANNELS.catalogStory,
    async (_event, payload) => {
      const kind = payload?.type
      if (!isValidCatalogKind(kind) || kind !== 'anime') return { links: [], checked: true }
      const order: AnimeStoryOrder = payload?.order === 'story' ? 'story' : 'release'
      return storyForShow(String(payload?.id || ''), 'interactive', order)
    }
  )
}
