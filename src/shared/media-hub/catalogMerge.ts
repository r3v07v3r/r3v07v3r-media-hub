// Two descriptions of one title becoming one, without either losing what
// only it knew.
//
// Lives in shared/ because it is needed on both sides of the IPC boundary:
// main's catalog crawl coalesces a Simkl entry with its Cinemeta twin
// (core.ts's mergeCatalogSources), and both main's and the renderer's
// search merge coalesce an index row with a provider's hit for the same
// id (titleSearch.ts's mergeSearchResults). One rule for what "missing"
// means keeps a title from being sparse in one place and whole in another.

import type { CatalogItem } from './types'

/**
 * Fills the gaps in `into` from `from`, without ever overwriting something
 * already there.
 *
 * The two sources describe the same title but do not carry the same fields:
 * a Simkl trending entry has a simklId and no episode list at all, a
 * Cinemeta entry has the full episode list and no simklId; an index row
 * written sparse by one crawl has no poster where a search hit has one.
 * Whichever is seen first should keep its position and its own values, and
 * gain what it was missing — which is exactly what the index's own upsert
 * does with COALESCE(NULLIF(...)), applied here so the two agree.
 *
 * Empty counts as missing, deliberately: `videos: []` and `poster: ''` are
 * how these normalizers say "this source has none", not "this source says
 * there are none".
 */
export function fillMissing(into: CatalogItem, from: CatalogItem): CatalogItem {
  const merged: CatalogItem = { ...into }
  for (const key of [
    'poster',
    'background',
    'logo',
    'description',
    'status',
    'rating',
    'runtime',
    'year'
  ] as const) {
    if (!merged[key] && from[key]) merged[key] = from[key]
  }
  if (!merged.genres?.length && from.genres?.length) merged.genres = from.genres
  if (!merged.videos?.length && from.videos?.length) merged.videos = from.videos
  if (!merged.trailers?.length && from.trailers?.length) merged.trailers = from.trailers
  if (merged.simklId == null && from.simklId != null) merged.simklId = from.simklId
  if (!merged.episodeCounts && from.episodeCounts) merged.episodeCounts = from.episodeCounts
  if (!merged.groupedIds?.length && from.groupedIds?.length) merged.groupedIds = from.groupedIds
  return merged
}
