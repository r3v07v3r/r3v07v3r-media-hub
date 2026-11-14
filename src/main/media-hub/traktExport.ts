// Reading the zip Trakt emails from Settings → Data → Export.
//
// The route in for somebody with no Trakt API app: signing in needs a client
// ID from a registered app, and the export needs nothing but the account. It
// is a one-off copy, not a connection — nothing is sent back to Trakt and
// nothing keeps in step afterwards.
//
// WHAT IS IN THE ZIP. JSON files in the shapes the API answers with, one kind
// per name, split into numbered pages once a kind is large:
//
//   watched-history.json, watched-history-2.json, …   one row per viewing
//   ratings-movies.json, ratings-shows.json, …        one row per rating
//
// Those are the only ones read. The rest are left alone on purpose:
// watched-movies / watched-shows are the same viewings added up to a play
// count and one last date (reading them too would file a second, date-less
// copy), and ratings-seasons / ratings-episodes rate something this app
// keeps no score for — read as show ratings they would put one episode's
// score on the whole show.
//
// Trakt publishes no description of this file. The names are the ones other
// importers of it read, so they are matched by name, anywhere in the archive,
// and a zip with none of them is refused rather than reported as an empty
// import.

import type { ImportedPlay } from '../../shared/media-hub/types'
import { parseTraktHistory, parseTraktRatings, type ParsedImport } from './trakt'
import { inflateZipEntry, readZipCentralDirectory } from './zipArchive'

/** One file. A page of history is a few megabytes at most; this is the
 *  zip-bomb guard inflateZipEntry asks for, sized far past that. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024

/** Everything read from one archive, for the same reason. */
const MAX_TOTAL_BYTES = 512 * 1024 * 1024

type ExportFileKind = 'history' | 'ratings'

/** Which of the kinds read here a file in the export is, by its own name
 *  (folders ignored). Null for every other file. */
export function traktExportFileKind(fileName: string): ExportFileKind | null {
  const name = fileName.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (/^watched-history(-\d+)?\.json$/.test(name)) return 'history'
  if (/^ratings-(movies|shows)(-\d+)?\.json$/.test(name)) return 'ratings'
  return null
}

export interface TraktExportRows {
  plays: ParsedImport<ImportedPlay>
  ratings: ReturnType<typeof parseTraktRatings>
}

/**
 * The viewings and ratings in a Trakt export, as the rows the API import
 * writes (trakt.ts's parsers, unchanged: same shapes, same rules for what is
 * skipped).
 *
 * Throws on a zip that is not a Trakt export, and on a file in it that cannot
 * be read. A page that fails is not stepped over: the import would report
 * success over part of somebody's history.
 */
export function readTraktExport(archive: Buffer): TraktExportRows {
  const entries = readZipCentralDirectory(archive)
    .map((entry) => ({ entry, kind: traktExportFileKind(entry.fileName) }))
    .filter((file): file is typeof file & { kind: ExportFileKind } => file.kind !== null)
  if (!entries.length) {
    throw new Error(
      'That does not look like a Trakt export — no watched-history or ratings file was found in it. Pick the zip Trakt emailed you, as it came.'
    )
  }

  const history: unknown[] = []
  const ratings: unknown[] = []
  let total = 0
  for (const { entry, kind } of entries) {
    total += entry.uncompressedSize
    if (entry.uncompressedSize > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES) {
      throw new Error('That export is too large to read.')
    }
    let rows: unknown
    try {
      rows = JSON.parse(
        inflateZipEntry(archive, entry, MAX_ENTRY_BYTES)
          .toString('utf-8')
          .replace(/^\ufeff/, '')
      )
    } catch {
      rows = null
    }
    if (!Array.isArray(rows)) {
      throw new Error(`${entry.fileName} in that export could not be read — nothing was imported.`)
    }
    // A loop, not push(...rows): a page can be long enough to overflow the
    // argument list.
    const into = kind === 'history' ? history : ratings
    for (const row of rows) into.push(row)
  }

  return { plays: parseTraktHistory(history), ratings: parseTraktRatings(ratings) }
}
