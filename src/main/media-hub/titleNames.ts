// What a title is called, from its cached record — without a network trip
// and without importing catalog.ts (which torbox.ts and the LAN feeder
// cannot pull in: it reaches the renderer bridge, and their tests run
// outside Electron).
//
// The release guards (titleMatchesRelease) need every name a title goes by,
// and most callers only hold one: a tracked row, a history row and an
// index-backed card all lack `originalTitle`, the romaji an anime's
// releases are actually named by. The metadata cache has it whenever the
// title has been opened once, which is what these read.

import type { CatalogItem } from '../../shared/media-hub/types'
import { getDatabase } from './dbState'

/** The metadata cache key — v4: anime titles became English (originalTitle
 *  carries the romaji), so every cached anime entry had to re-resolve
 *  rather than read the old name back for a day. Shared with catalog.ts's
 *  resolveMetadata, which writes under it. */
export function metaCacheKey(type: string, resolvedId: string): string {
  return `meta:v4:${type}:${resolvedId}`
}

/**
 * A title's cached metadata, or null when it was never resolved here.
 * Expired entries count: a name does not go stale the way an episode list
 * does, and this is only ever read for names.
 */
export function cachedMetadata(type: string, id: string): CatalogItem | null {
  try {
    return (
      getDatabase().getCache<CatalogItem>(metaCacheKey(type, String(id)), {
        allowExpired: true
      }) ?? null
    )
  } catch {
    return null
  }
}

/**
 * Every name a title goes by, for release matching: the names the caller
 * has, plus what the cached record adds — its `originalTitle`, and its own
 * title when the caller's differs (a row tracked under a name the catalog
 * has since renamed). Order is kept, so the caller's first name stays the
 * search term where one is needed. `id` is the SHOW's id (see torbox.ts's
 * showKey), which is what the metadata is cached under.
 */
export function knownTitles(
  type: string,
  id: string,
  given: ReadonlyArray<string | undefined>
): string[] {
  const names = given.map((name) => String(name ?? '').trim()).filter(Boolean)
  const cached = cachedMetadata(type, id)
  for (const extra of [cached?.originalTitle, cached?.title]) {
    const name = String(extra ?? '').trim()
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}
