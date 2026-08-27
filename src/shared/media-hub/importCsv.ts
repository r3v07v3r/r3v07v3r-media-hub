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
