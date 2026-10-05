// The cast and story-label half of catalog:search, kept in memory.
//
// After the title matches, catalog:search appends the catalogued titles whose
// cast, creators or story labels contain the query (see credits.ts's
// searchCredits). That pass used to start with catalogData(kind), which on a
// cold install or an expired six-hour blob joined a full catalogue crawl, so
// a search reply could wait about twenty seconds for anime with its title
// results already in hand. On a warm cache it still parsed the whole blob and
// read a credits row per catalogued title, on every search, three times over
// for the assistant.
//
// Here the blob is read from the cache only, expired or not, and never
// crawled for: a search adds what is already known about cast and labels, it
// does not go and find out more. What the pass needs from it (the catalogued
// titles that have credits, with those credits) is kept per kind until the
// blob or the credits change. The two blob writers in catalog.ts call
// invalidateSearchPool; credits writes move credits.ts's version counter; and
// a database that was reopened (a restore) is a different object, so a pool
// read from the old one is not served.

import type { CatalogItem, MediaKind, TitleCredits } from '../../shared/media-hub/types'
import { creditsFor, currentCreditsVersion, matchCredits } from './credits'
import { getDatabase } from './dbState'

interface SearchPool {
  /** The database the pool was read from. */
  db: object
  creditsVersion: number
  /** Catalogued titles that have credits, in blob order. Titles without
   *  credits are not kept: the pass can never return them, and holding the
   *  whole parsed blob for every kind would cost memory for nothing. */
  items: Map<string, CatalogItem>
  credits: Map<string, TitleCredits>
}

const pools = new Map<MediaKind, SearchPool>()

/** Drops the kept pool for one kind. Called where the catalog blob is
 *  written, so the next search reads the new one. */
export function invalidateSearchPool(kind: MediaKind): void {
  pools.delete(kind)
}

function poolFor(kind: MediaKind): SearchPool {
  const db = getDatabase()
  const version = currentCreditsVersion()
  const kept = pools.get(kind)
  if (kept && kept.db === db && kept.creditsVersion === version) return kept

  const blob = db.getCache<CatalogItem[]>(`catalog:v2:${kind}`, { allowExpired: true }) || []
  const byId = new Map<string, CatalogItem>()
  for (const item of blob) {
    const id = String(item?.id ?? '')
    if (id && !byId.has(id)) byId.set(id, item)
  }
  const credits = creditsFor(byId.keys())
  const items = new Map<string, CatalogItem>()
  for (const id of credits.keys()) {
    const item = byId.get(id)
    if (item) items.set(id, item)
  }
  const pool: SearchPool = { db, creditsVersion: version, items, credits }
  pools.set(kind, pool)
  return pool
}

/**
 * Catalogued titles of one kind whose cast or creators contain `query`, then
 * those whose story labels do, skipping ids in `exclude` (the title matches
 * already listed). Never touches the network.
 */
export function searchByCredits(
  kind: MediaKind,
  query: string,
  exclude: ReadonlySet<string> = new Set()
): CatalogItem[] {
  const pool = poolFor(kind)
  const { people, labels } = matchCredits(pool.credits, query)
  const seen = new Set(exclude)
  const out: CatalogItem[] = []
  for (const id of [...people, ...labels]) {
    if (seen.has(id)) continue
    const item = pool.items.get(id)
    if (!item) continue
    seen.add(id)
    out.push(item)
  }
  return out
}
