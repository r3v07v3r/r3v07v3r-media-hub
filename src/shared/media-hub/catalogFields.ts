// How a CatalogItem's stringly-typed fields become the numbers the browse
// grid filters and sorts on.
//
// These live in shared/ and nowhere else on purpose. The same values are
// derived twice in this app and MUST agree: once in the renderer, where
// adapters.ts maps a CatalogItem onto the MediaItem the grid renders, and
// once in main, where the catalog crawl writes typed columns into
// catalog_index for SQL to filter and sort on. Two copies of "what counts as
// a runtime" is exactly the drift that makes a server-side filter quietly
// mean something different from the client-side one it replaced.
//
// Deliberately permissive in the same way the originals were: anything that
// does not parse to a positive number is absent, not zero. A title with no
// year must not sort as year 0 and must not match a year filter — "unknown"
// and "nineteen hundred" are different answers.

// Runtime is NOT parsed here. It has its own module — see runtime.ts — and
// re-exporting it rather than reimplementing it is the whole point of this
// file: main writes catalog_index.runtime_min from the same function the
// renderer displays and filters on.
//
// This deliberately replaced a local `parseInt(runtime, 10)`, which is wrong
// in a way that only shows on some titles: it reads "1h 40min" as 1. That is
// the bug behind every feature film's card reading a 1-3 minute runtime, and
// runtime.ts fixes it by recognising the hours-and-minutes form. Keeping a
// second, simpler parser here would have written runtime_min = 1 into the
// index for exactly those titles while the renderer showed 100 — a filter
// meaning two different things on the two sides of the same question.
export { parseRuntimeMinutes } from './runtime'

/**
 * A four-digit year from a year string.
 *
 * `parseInt` again, because normalizeKitsuAnime builds this by slicing a
 * full ISO date (`"1998-04-03".slice(0, 4)`) and Simkl entries can carry a
 * range like `"2005-2010"` — both of which should read as their start year
 * rather than as nothing.
 */
export function parseYear(year: string): number | undefined {
  const n = parseInt(year, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * A numeric rating.
 *
 * `Number`, not `parseInt` — these are decimals ("8.4"), and parseInt would
 * silently floor every one of them to the integer part.
 */
export function parseRating(rating: string): number | undefined {
  const n = Number(rating)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * The value `ORDER BY` uses for the "A–Z" sort.
 *
 * Two adjustments, both there to make SQLite's byte-order comparison land
 * where `a.title.localeCompare(b.title)` — the sort this replaces, in
 * categoryFilters.ts's sortMediaItems — already landed:
 *
 *  - LOWERCASED, because SQLite's default ORDER BY on TEXT is byte order,
 *    which files every capitalised title before every lowercase one.
 *  - DIACRITICS REMOVED, because byte order puts "Pokémon" after "Pz" while
 *    localeCompare files it under "Poke". Decomposing to NFD and dropping
 *    the combining marks is what collapses "é" onto "e" the way a
 *    locale-aware collation does.
 *
 * Measured against the real catalogs (3,860 distinct movie and series
 * titles, 200,000 random pairs): plain lowercasing disagrees with
 * localeCompare on 0.019% of pairs; with diacritics removed, on none of
 * them. That is not a proof of equivalence — localeCompare implements far
 * more collation than this — but it is the difference between a known gap
 * and no gap this catalog can demonstrate.
 *
 * DELIBERATELY NOT article-stripped. localeCompare files "The Matrix" under
 * T, and a server-side sort that quietly filed it under M would be a
 * behaviour change disguised as an optimisation. If articles should be
 * ignored, that is a product decision to make on both sides at once.
 */
export function titleSortKey(title: string): string {
  return String(title || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}
