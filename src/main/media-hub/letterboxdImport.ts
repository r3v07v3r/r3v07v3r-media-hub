// Bringing a Letterboxd account's diary and ratings in.
//
// The harder sibling of Trakt and IMDb import (traktClient.ts,
// appIpc.ts's importImdbRatings): both of those carry an id this app's
// catalog already understands. Letterboxd's export carries none at all —
// just a title and a year — so every row here has to be resolved to an
// IMDb id before it can be stored, and that resolution is the one place
// this whole import can go quietly wrong: a confident wrong match writes
// somebody else's rating into this person's history, where it will
// silently steer every recommendation from then on.
//
// The resolution: TMDB search by title+year, kept only when EXACTLY one
// result survives two independent checks — the release year (TMDB's own
// `year` search param, re-verified rather than trusted, since the param is
// documented as a ranking hint, not a hard filter) and the title itself,
// compared literally against TMDB's own title AND original_title. No fuzzy
// matching, no "closest" result. Letterboxd's own film database is built
// on TMDB's, so the ordinary case is an exact match; a row that fails this
// bar is skipped and counted, never guessed at.
//
// Resolved ids are cached (90 days — a title's IMDb id does not change) so
// running the same export twice, or two exports years apart with heavy
// overlap, does not re-search titles this app already knows.

import type { ImportedPlay, ImportSummary } from '../../shared/media-hub/types'
import {
  matchLetterboxdCandidate,
  parseLetterboxdDiaryCsv,
  parseLetterboxdRatingsCsv,
  type LetterboxdCandidate,
  type LetterboxdTitle
} from '../../shared/media-hub/importCsv'
import { fetchJson } from './httpClient'
import { getDatabase } from './dbState'
import { logError } from './logger'
import type { RawApiPayload } from './core'
import { requestRecommendationsRebuild } from './recommendations'
import { tmdbCredentials } from './settingsStore'
import { mapWithLimit, type TaskPriority } from './taskScheduler'
import { readZipCentralDirectory, inflateZipEntry } from './zipArchive'

/** A Letterboxd export is a few small CSVs; refuses anything absurd rather
 *  than trusting the file's own claimed size. Sized well above what even a
 *  many-thousand-entry diary or ratings file would ever be as plain text. */
const MAX_CSV_BYTES = 32 * 1024 * 1024

/** How many rows of EACH file this import is willing to resolve. Not a
 *  real-world expectation (a very active decade-plus Letterboxd account can
 *  legitimately have several thousand diary entries) but a backstop against
 *  spending an unbounded number of TMDB requests on one button press.
 *  Reported when hit — see ImportSummary.skipped — rather than silently
 *  trimmed, the same call traktClient.ts's IMPORT_MAX_PAGES makes. */
const MAX_ROWS_PER_FILE = 3000

/** How long a resolved (or confirmed-unresolvable) title is remembered. A
 *  film's IMDb id does not change; this is here so a second run of the same
 *  export — or two exports years apart with heavy overlap — does not
 *  re-search titles this app already has an answer for. */
const RESOLVE_TTL_MS = 90 * 24 * 60 * 60 * 1000

function normalizeTitle(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
}

function resolveCacheKey(title: LetterboxdTitle): string {
  return `letterboxd:resolve:v1:${normalizeTitle(title.name)}:${title.year}`
}

/**
 * One title, resolved to an IMDb id or to nothing — cached either way (see
 * RESOLVE_TTL_MS), so a title this app has already confirmed unresolvable
 * is not re-searched every run either.
 */
async function resolveLetterboxdTitle(
  title: LetterboxdTitle,
  apiKey: string,
  priority: TaskPriority
): Promise<string | null> {
  const db = getDatabase()
  const cacheKey = resolveCacheKey(title)
  // '' is the cached "confirmed unresolvable" answer, distinct from a cache
  // MISS (null) — both mean "return null" here, but only a miss goes to
  // the network.
  const cached = db.getCache<string>(cacheKey)
  if (cached !== null) return cached || null

  try {
    const query = new URLSearchParams({
      api_key: apiKey,
      query: title.name,
      year: title.year
    }).toString()
    const search = await fetchJson<RawApiPayload>(
      `https://api.themoviedb.org/3/search/movie?${query}`,
      {},
      { priority, label: 'letterboxd resolve' }
    )
    // The matching RULE itself is pure and lives in importCsv.ts — see
    // matchLetterboxdCandidate — so it can be pinned down by a test
    // independent of this fetch. Anything other than exactly one confident
    // match returns null: zero means TMDB has nothing that fits both
    // checks, more than one means the title+year pair does not uniquely
    // identify a film (a remake sharing both), and this app has no third
    // signal to break the tie with.
    const candidates: LetterboxdCandidate[] = (search.results || []).map(
      (record: RawApiPayload) => ({
        id: Number(record.id),
        title: String(record.title || ''),
        originalTitle: String(record.original_title || ''),
        releaseYear: String(record.release_date || '').slice(0, 4)
      })
    )
    const tmdbId = matchLetterboxdCandidate(title, candidates)
    if (!tmdbId) {
      db.putCache(cacheKey, '', RESOLVE_TTL_MS)
      return null
    }
    const external = await fetchJson<RawApiPayload>(
      `https://api.themoviedb.org/3/movie/${tmdbId}/external_ids?api_key=${encodeURIComponent(apiKey)}`,
      {},
      { priority, label: 'letterboxd external id' }
    )
    const imdbId = String(external.imdb_id || '')
    if (!/^tt\d+$/.test(imdbId)) {
      db.putCache(cacheKey, '', RESOLVE_TTL_MS)
      return null
    }
    db.putCache(cacheKey, imdbId, RESOLVE_TTL_MS)
    return imdbId
  } catch (error) {
    // NOT cached — unlike a genuine "no match", a request failure is
    // usually transient and a title this app never got to search should
    // stay eligible for the next run rather than being remembered as
    // unresolvable for 90 days because of one dropped connection.
    logError('letterboxd:resolve', error)
    return null
  }
}

/** Finds a named entry inside a zip archive, matching by suffix so both a
 *  file at the archive's root and one nested under an export folder
 *  (`letterboxd-export-2026-01-01/diary.csv`) are found the same way. */
function readZipTextEntry(archive: Buffer, fileName: string): string | null {
  const entries = readZipCentralDirectory(archive)
  const entry = entries.find(
    (candidate) =>
      candidate.fileName.toLowerCase() === fileName ||
      candidate.fileName.toLowerCase().endsWith(`/${fileName}`)
  )
  if (!entry || entry.uncompressedSize > MAX_CSV_BYTES) return null
  try {
    // Strip a leading UTF-8 BOM: it survives decoding as U+FEFF and would
    // otherwise land in front of the header row's first column name, where
    // readByHeader's exact-string column lookup no longer matches it.
    // Written as an escape rather than the literal character, matching
    // subdl.ts's own BOM strip, so it stays visible to anyone reading the
    // source instead of rendering as invisible whitespace.
    return inflateZipEntry(archive, entry, MAX_CSV_BYTES)
      .toString('utf-8')
      .replace(/^\ufeff/, '')
  } catch (error) {
    logError('letterboxd:zip', error)
    return null
  }
}

/**
 * Brings a Letterboxd "Export Your Data" archive's diary and ratings into
 * this profile.
 *
 * `archive` is the raw zip bytes, read from a path a native file picker
 * chose — this module never touches the filesystem itself, matching every
 * other import/backup flow's rule that the renderer can never name a file
 * for main to open.
 */
export async function importLetterboxdLibrary(
  archive: Buffer,
  priority: TaskPriority = 'background'
): Promise<ImportSummary> {
  const { apiKey } = tmdbCredentials()
  if (!apiKey) {
    throw new Error(
      'Connect TMDB in Settings before importing from Letterboxd — resolving titles needs it.'
    )
  }

  const diaryText = readZipTextEntry(archive, 'diary.csv')
  const ratingsText = readZipTextEntry(archive, 'ratings.csv')
  if (!diaryText && !ratingsText) {
    throw new Error(
      'That does not look like a Letterboxd export — no diary.csv or ratings.csv was found in it.'
    )
  }

  const diary = diaryText ? parseLetterboxdDiaryCsv(diaryText) : { rows: [], skipped: 0 }
  const ratings = ratingsText ? parseLetterboxdRatingsCsv(ratingsText) : { rows: [], skipped: 0 }

  // See MAX_ROWS_PER_FILE — reported, not silently trimmed.
  const diaryTruncated = diary.rows.length > MAX_ROWS_PER_FILE
  const ratingsTruncated = ratings.rows.length > MAX_ROWS_PER_FILE
  const diaryRows = diary.rows.slice(0, MAX_ROWS_PER_FILE)
  const ratingRows = ratings.rows.slice(0, MAX_ROWS_PER_FILE)

  const db = getDatabase()
  // The profile this import is FOR, captured before the first request —
  // every resolution below is an await, the same reason every other
  // profile-scoped import in this app captures it up front rather than
  // resolving it at write time.
  const profile = db.activeProfile()

  const [resolvedDiary, resolvedRatings] = await Promise.all([
    mapWithLimit(diaryRows, async (row) => {
      const id = await resolveLetterboxdTitle(row, apiKey, priority)
      if (!id) return null
      return {
        id,
        type: 'movie',
        title: row.name,
        year: row.year,
        watchedAt: row.watchedAt
      } as ImportedPlay
    }),
    mapWithLimit(ratingRows, async (row) => {
      const id = await resolveLetterboxdTitle(row, apiKey, priority)
      return id ? { id, score: row.score } : null
    })
  ])

  if (db.activeProfile() !== profile) {
    throw new Error('Profile changed while importing — nothing was written.')
  }

  const plays = resolvedDiary.filter((row): row is ImportedPlay => Boolean(row))
  const scored = resolvedRatings.filter((row): row is { id: string; score: number } => Boolean(row))

  const summary: ImportSummary = {
    plays: db.importWatched(plays),
    ratings: db.importRatings(scored),
    skipped:
      diary.skipped +
      ratings.skipped +
      (diaryRows.length - plays.length) +
      (ratingRows.length - scored.length)
  }

  if (diaryTruncated || ratingsTruncated) {
    logError(
      'letterboxd:import',
      new Error(`Stopped after ${MAX_ROWS_PER_FILE} rows per file — the import is partial.`)
    )
  }

  if (summary.plays || summary.ratings) requestRecommendationsRebuild()
  return summary
}
