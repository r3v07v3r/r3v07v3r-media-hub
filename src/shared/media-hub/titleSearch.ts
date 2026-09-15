// How a typed query is matched against a title, and how hits from several
// places become one list.
//
// Lives in shared/ because the same question is asked on both sides of the
// IPC boundary: main merges the local index with a provider's search for
// one kind (catalog.ts's catalog:search), and the renderer merges three of
// those answers across kinds for the assistant (assistantSearch.ts). Two
// copies of "what counts as a good match" would let the category page and
// the assistant rank the same title differently for the same words.

import type { CatalogItem } from './types'
import { fillMissing } from './catalogMerge'

/**
 * The form a title and a query are compared in: lowercased, diacritics
 * dropped, every run of punctuation or whitespace collapsed to one space.
 *
 * So "Amélie" and "amelie" are the same word, and "Spider-Man" is the two
 * words "spider man" — which is what somebody typing either of those into
 * a search box means by them. The diacritic fold is the same NFD strip
 * catalogFields.ts's titleSortKey does, so a query folded here can be
 * compared with what the index stored there.
 */
export function comparableTitle(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** The words of a query, in the comparable form. Empty for a query with no letters or digits in it. */
export function searchTokens(query: string): string[] {
  const folded = comparableTitle(query)
  return folded ? folded.split(' ') : []
}

/**
 * How well a title answers a query, lower being better.
 *
 *   0  the title IS the query ("Foundation" for "foundation")
 *   1  the title starts with the query as whole words ("Dune: Part One")
 *   2  the query appears as whole words further in ("SCP Foundation")
 *   3  the query appears inside a word ("Foundations of Yoga")
 *   4  every word of the query appears somewhere, in any order
 *   5  no match at all
 *
 * Word boundaries are what separate 1 from 3: for "foundation", the
 * Apple series and "Foundations of Yoga" are both prefix matches in the
 * plain string sense, and only one of them is what was asked for.
 */
export function titleMatchRank(title: string, query: string): number {
  const a = comparableTitle(title)
  const b = comparableTitle(query)
  if (!a || !b) return 5
  if (a === b) return 0
  if (a.startsWith(`${b} `)) return 1
  if (a.includes(` ${b} `) || a.endsWith(` ${b}`)) return 2
  if (a.includes(b)) return 3
  const words = a.split(' ')
  if (b.split(' ').every((token) => words.some((word) => word.includes(token)))) return 4
  return 5
}

/** The rank above which a hit is no longer the title that was named — used where a result stands in for a specific title rather than for a search. */
export const CLOSE_MATCH_RANK = 1

/**
 * One ranked list from the hits of several sources, best match first.
 *
 * Each source ranks only against itself, so their lists arrive unrelated —
 * concatenating them puts every hit from the first source ahead of an
 * exactly-matching one from the second. The one comparison that can be
 * made across them is how well the title answers the query
 * (titleMatchRank); equally good matches keep each source's own idea of
 * relevance, interleaved by position so one source cannot take every
 * slot, and fall back to source order last.
 *
 * A title that more than one source returned appears once, built from the
 * EARLIEST source's item — callers list their richest source first (the
 * index row carries genres, rating and a synopsis; a provider's search hit
 * carries a poster and a year) — with its gaps filled from the later ones
 * (fillMissing, the same coalescing the catalog crawl does), sorted by the
 * best rank and position any source gave it. An index row a crawl wrote
 * sparse still gets its poster from the hit that had one.
 *
 * The title travels with the rank: when a later source names the same id
 * in a way that answers the query better ("Frieren: Beyond Journey's End"
 * for "frieren", where the index held the romaji), the result carries THAT
 * name. A card ranked for one name and labelled with another would read
 * as a mismatch, and resolveSimilarTitles checks the label against the
 * name the model gave — a result whose label did not match would be
 * rejected for the very reason it was found.
 *
 * Anything without an id is dropped: it can never be opened, so it is not
 * a result.
 */
export function mergeSearchResults(
  query: string,
  sources: readonly (readonly CatalogItem[])[],
  limit = Number.POSITIVE_INFINITY
): CatalogItem[] {
  const best = new Map<
    string,
    { item: CatalogItem; rank: number; position: number; source: number }
  >()
  sources.forEach((items, source) => {
    items.forEach((item, position) => {
      const id = String(item?.id ?? '')
      if (!id) return
      const rank = titleMatchRank(String(item.title ?? ''), query)
      const held = best.get(id)
      if (!held) {
        best.set(id, { item, rank, position, source })
        return
      }
      held.item = fillMissing(held.item, item)
      if (rank < held.rank) {
        held.rank = rank
        held.item = { ...held.item, title: item.title }
      }
      held.position = Math.min(held.position, position)
    })
  })
  return [...best.values()]
    .sort((x, y) => x.rank - y.rank || x.position - y.position || x.source - y.source)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.item)
}
