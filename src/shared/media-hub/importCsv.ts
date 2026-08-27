// A small RFC 4180 CSV parser, and the IMDb "export your ratings" reader
// built on it.
//
// WHY A HAND-ROLLED PARSER. `String.split(',')` is wrong the moment a field
// is quoted, and every title with a comma in it — "Dune: Part Two", "Léon:
// The Professional" survive; "The Good, the Bad and the Ugly" does not — is
// exactly the kind of row a split-on-comma reader corrupts silently rather
// than visibly. This reads one character at a time so a comma or a newline
// inside quotes is data, not a field boundary.
//
// Column lookup is by NAME, read from the header row, not by position.
// IMDb has reordered and added columns to this export more than once over
// the years; a parser keyed to position would silently read the wrong
// field the next time they do it again, exactly the "confident wrong
// match" this app has refused to risk everywhere else it touches somebody
// else's data.

/** Parses CSV text into rows of raw string cells. Handles quoted fields,
 *  embedded commas and newlines within quotes, and `""` as an escaped quote. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  // Normalizes CRLF up front so the scanner below only ever has to reason
  // about `\n` — IMDb and Letterboxd both export CRLF, but a bare `\n`
  // inside a quoted multi-line field must not be treated any differently.
  const source = text.replace(/\r\n/g, '\n')

  function endCell(): void {
    row.push(cell)
    cell = ''
  }
  function endRow(): void {
    endCell()
    rows.push(row)
    row = []
  }

  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cell += char
      }
      continue
    }
    if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      endCell()
    } else if (char === '\n') {
      endRow()
    } else {
      cell += char
    }
  }
  // The final row has no trailing newline to trigger endRow — unless the
  // file ended on an actually-empty line, which is not a row at all.
  if (cell !== '' || row.length > 0) endRow()
  return rows
}

/** One CSV file, read as objects keyed by its own header row rather than by
 *  column position — see the file header on why. */
function readByHeader(text: string): { header: string[]; rows: Record<string, string>[] } {
  const table = parseCsv(text)
  const header = table[0] ?? []
  const rows = table.slice(1).map((cells) => {
    const record: Record<string, string> = {}
    header.forEach((name, index) => {
      record[name] = cells[index] ?? ''
    })
    return record
  })
  return { header, rows }
}

export interface ImdbRatingRow {
  id: string
  score: number
  ratedAt: string
}

/** What one call understood, and what it had to leave behind — same shape
 *  ParsedImport takes in trakt.ts, for the same reason: an import always
 *  reports what it dropped rather than going quiet about it. */
export interface ParsedCsvImport<T> {
  rows: T[]
  skipped: number
}

/**
 * IMDb's "Your ratings" export as ratings this app can store.
 *
 * `Const` is already an IMDb id — the exact id space this app's catalog and
 * `ratings` table are keyed by — so unlike Letterboxd's export (which
 * carries no id at all and would need a title/year lookup against a
 * catalog that does not promise to have every film), an IMDb row needs no
 * matching step and no guessing. A row with anything else in that column,
 * or a rating outside 1-10, is skipped and counted rather than coerced.
 */
export function parseImdbRatingsCsv(text: string): ParsedCsvImport<ImdbRatingRow> {
  const { rows } = readByHeader(text)
  const parsed: ImdbRatingRow[] = []
  let skipped = 0
  for (const record of rows) {
    const id = String(record.Const ?? '').trim()
    const score = Math.round(Number(record['Your Rating']))
    const ratedAt = String(record['Date Rated'] ?? '').trim()
    if (
      !/^tt\d+$/.test(id) ||
      !Number.isFinite(score) ||
      score < 1 ||
      score > 10 ||
      !ratedAt ||
      Number.isNaN(Date.parse(ratedAt))
    ) {
      skipped += 1
      continue
    }
    parsed.push({ id, score, ratedAt })
  }
  return { rows: parsed, skipped }
}

// ---------------------------------------------------------------------------
// Letterboxd.
//
// Letterboxd's export carries no id at all — no IMDb, no TMDB, just a title
// and a year — so these two functions hand back exactly that much, and no
// more. Resolving a (title, year) pair to an IMDb id is main-only work (a
// TMDB search, then external_ids — see main/media-hub/letterboxdImport.ts)
// and stays out of this module for the same reason the rest of this file's
// functions are pure: it needs network I/O these cannot do.
//
// Two files, two questions. diary.csv is used for VIEWINGS rather than
// watched.csv, deliberately: watched.csv's own Date column is documented by
// Letterboxd as "when you added this to your watched list", not when you
// watched it — importing it as a play date would be exactly the "decade of
// viewing lands at the top of recently-watched, today" failure the Trakt
// import was built to avoid (see traktClient.ts's importTraktLibrary). A
// film marked watched but never diary-logged has no accurate date
// anywhere in this export, so it is left out rather than dated with a
// number known to be wrong. ratings.csv's own Date is honestly labeled as
// when the rating was GIVEN, which is what a rating date is expected to
// mean everywhere else in this app too.
// ---------------------------------------------------------------------------

export interface LetterboxdTitle {
  name: string
  year: string
}

export interface LetterboxdWatchedRow extends LetterboxdTitle {
  watchedAt: string
}

/**
 * Letterboxd's diary.csv as viewings — real per-entry dates, rewatches
 * included as their own rows (this app's `plays` table is append-only for
 * exactly this reason).
 */
export function parseLetterboxdDiaryCsv(text: string): ParsedCsvImport<LetterboxdWatchedRow> {
  const { rows } = readByHeader(text)
  const parsed: LetterboxdWatchedRow[] = []
  let skipped = 0
  for (const record of rows) {
    const name = String(record.Name ?? '').trim()
    const year = String(record.Year ?? '').trim()
    const watchedAt = String(record['Watched Date'] ?? '').trim()
    if (!name || !/^\d{4}$/.test(year) || !watchedAt || Number.isNaN(Date.parse(watchedAt))) {
      skipped += 1
      continue
    }
    parsed.push({ name, year, watchedAt })
  }
  return { rows: parsed, skipped }
}

export interface LetterboxdRatingRow extends LetterboxdTitle {
  score: number
  ratedAt: string
}

/**
 * Letterboxd's ratings.csv as ratings this app can store.
 *
 * Letterboxd rates in half-stars, 0.5-5; this app rates 1-10. `score * 2` is
 * an exact conversion with no rounding artifact — every legal half-star
 * value already lands on a whole number doubled — so `Math.round` here is a
 * defensive guard against a malformed value, not a real rounding step.
 */
export function parseLetterboxdRatingsCsv(text: string): ParsedCsvImport<LetterboxdRatingRow> {
  const { rows } = readByHeader(text)
  const parsed: LetterboxdRatingRow[] = []
  let skipped = 0
  for (const record of rows) {
    const name = String(record.Name ?? '').trim()
    const year = String(record.Year ?? '').trim()
    const ratedAt = String(record.Date ?? '').trim()
    const stars = Number(record.Rating)
    const score = Math.round(stars * 2)
    if (
      !name ||
      !/^\d{4}$/.test(year) ||
      !ratedAt ||
      Number.isNaN(Date.parse(ratedAt)) ||
      !Number.isFinite(stars) ||
      stars < 0.5 ||
      stars > 5 ||
      score < 1 ||
      score > 10
    ) {
      skipped += 1
      continue
    }
    parsed.push({ name, year, score, ratedAt })
  }
  return { rows: parsed, skipped }
}

/**
 * The candidate shape this app can decide a Letterboxd (title, year) pair
 * against — the fields a TMDB `/search/movie` result carries, and nothing
 * this app has to fetch separately to make the call.
 */
export interface LetterboxdCandidate {
  id: number
  title: string
  originalTitle: string
  releaseYear: string
}

function normalizeLetterboxdTitle(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * Which TMDB search result, if any, is confidently the same film as one
 * Letterboxd row — the one place this whole import can go quietly wrong,
 * pulled out as a pure function so the matching RULE can be pinned down by
 * a test independent of the network call that produces its input.
 *
 * Kept deliberately strict, on the same "a confident wrong match is worse
 * than a missing one" call this app makes everywhere it touches a title it
 * did not author: the year must match exactly, the title must match
 * LITERALLY (case/whitespace normalized, nothing fuzzy) against either
 * TMDB's `title` or `original_title`, and there must be exactly one such
 * survivor. Zero or more than one both mean "not confident enough" and
 * return null — a remake sharing a title and year has no third signal
 * here to break the tie with, so it is left for a person to resolve by
 * hand rather than guessed at.
 */
export function matchLetterboxdCandidate(
  title: LetterboxdTitle,
  candidates: readonly LetterboxdCandidate[]
): number | null {
  const wanted = normalizeLetterboxdTitle(title.name)
  const matches = candidates.filter(
    (candidate) =>
      candidate.releaseYear === title.year &&
      (normalizeLetterboxdTitle(candidate.title) === wanted ||
        normalizeLetterboxdTitle(candidate.originalTitle) === wanted)
  )
  return matches.length === 1 ? matches[0].id : null
}
