// How a CatalogItem's stringly-typed fields become the numbers the browse
// grid filters and sorts on.
//
// These live in shared/ and nowhere else on purpose. The same three values
// are derived twice in this app and MUST agree: once in the renderer, where
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

/**
 * Minutes from a runtime string.
 *
 * `parseInt`, not `Number`, because the sources write a unit: Cinemeta and
 * Simkl both produce strings like `"142 min"`, and Number("142 min") is NaN.
 */
export function parseRuntimeMinutes(runtime: string): number | undefined {
  const n = parseInt(runtime, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

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
 * Lowercased and trimmed, and DELIBERATELY NOTHING ELSE — in particular no
 * leading-article stripping. The sort this replaces is
 * `a.title.localeCompare(b.title)` (categoryFilters.ts's sortMediaItems),
 * which files "The Matrix" under T, and a server-side sort that quietly
 * filed it under M would be a behaviour change disguised as an optimisation.
 * If articles should be ignored, that is a product decision to make on both
 * sides at once, not a side effect of moving the sort into SQL.
 *
 * Lowercasing is the one adjustment, because SQLite's default `ORDER BY` on
 * TEXT is byte order — which puts every capitalised title before every
 * lowercase one, something localeCompare never did.
 */
export function titleSortKey(title: string): string {
  return String(title || '')
    .trim()
    .toLowerCase()
}
