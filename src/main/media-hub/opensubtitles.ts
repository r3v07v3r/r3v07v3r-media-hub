// Ported from r3v07v3r-media-hub's src/opensubtitles.cjs. Logic preserved
// exactly from the original: IMDb-id vs. title-query search-param
// selection, the JSON:API-shaped result normalization, and the SRT->VTT
// timestamp/wrapper conversion.

import type { SubtitleResult } from '../../shared/media-hub/types'

/** Raw item passed in from the catalog/library side of the app. */
export interface OpenSubtitlesSearchItem {
  id?: string
  type?: string
  title?: string
}

export interface OpenSubtitlesSearchPlayback {
  language?: string
  season?: number
  episode?: number
  /** The release somebody is actually watching, hashed off the live stream
   *  — see main/media-hub/movieHash.ts. Undefined whenever it could not be
   *  computed, which is the ordinary case (a source with no known length, a
   *  slow tail read, or simply too small a file) and not an error. */
  movieHash?: string
  movieBytes?: number
}

/**
 * Raw OpenSubtitles API "subtitles" search result row (JSON:API-style).
 * Field types are loosely/defensively typed since this is untrusted
 * external API response data.
 */
export interface OpenSubtitlesRawEntry {
  id?: unknown
  attributes?: {
    files?: Array<{ file_id?: unknown; file_name?: unknown }>
    language?: unknown
    release?: unknown
    download_count?: unknown
    uploader?: { name?: unknown }
    hearing_impaired?: unknown
    /** Present only when the search included a moviehash — see
     *  buildSearchParams. True on the rows that matched it. */
    moviehash_match?: unknown
  }
}

export function buildSearchParams(
  item: OpenSubtitlesSearchItem | undefined,
  playback: OpenSubtitlesSearchPlayback = {}
): Record<string, string | number> {
  const params: Record<string, string | number> = {
    languages: String(playback.language || 'en').toLowerCase()
  }
  const imdbMatch = String(item?.id || '').match(/^tt(\d+)$/)
  if (imdbMatch && item?.type !== 'anime') {
    params.imdb_id = imdbMatch[1]
  } else {
    params.query = String(item?.title || '').trim()
  }
  if (item?.type !== 'movie') {
    if (Number.isFinite(playback.season)) params.season_number = playback.season as number
    if (Number.isFinite(playback.episode)) params.episode_number = playback.episode as number
  }
  // Sent ALONGSIDE imdb_id/query, never instead of it: OpenSubtitles ranks a
  // hash match first when both are present and falls back to the title match
  // on its own the moment the hash misses (a re-encode, a different release
  // nobody has hashed and uploaded yet) — so adding this can only improve the
  // result, never narrow it the way replacing imdb_id with it would.
  if (playback.movieHash) {
    params.moviehash = playback.movieHash
    if (Number.isFinite(playback.movieBytes)) {
      params.moviebytesize = playback.movieBytes as number
    }
  }
  return params
}

export function normalizeSubtitleResult(entry: unknown): SubtitleResult {
  const raw = (entry ?? {}) as OpenSubtitlesRawEntry
  const a = raw.attributes || {}
  const file = a.files?.[0] || {}
  return {
    id: String(raw?.id || ''),
    provider: 'opensubtitles',
    // Empty for this provider: OpenSubtitles hands out a short-lived
    // download link from its own /download endpoint rather than a stable
    // archive path — see subdl.ts's normalizeSubdlResult for the contrast.
    downloadPath: '',
    fileId: Number(file.file_id) || 0,
    fileName: String(file.file_name || ''),
    language: String(a.language || ''),
    releaseName: String(a.release || ''),
    downloadCount: Number(a.download_count) || 0,
    uploader: String(a.uploader?.name || 'Anonymous'),
    hearingImpaired: Boolean(a.hearing_impaired),
    hashMatch: a.moviehash_match === true
  }
}
