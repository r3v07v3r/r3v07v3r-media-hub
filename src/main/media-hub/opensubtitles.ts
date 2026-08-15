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
    hearingImpaired: Boolean(a.hearing_impaired)
  }
}

export function srtToVtt(text: string): string {
  const body = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
  return `WEBVTT\n\n${body.trim()}\n`
}
