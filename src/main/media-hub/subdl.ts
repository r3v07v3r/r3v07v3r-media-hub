// SubDL subtitle provider — the free-tier counterpart to opensubtitles.ts.
//
// Why this exists alongside OpenSubtitles: OpenSubtitles meters the
// *download* step (5/day on a free account, 1000/day only for paid VIP),
// which is low enough that a couple of episodes exhausts it. SubDL meters
// the *search* step instead (2000 requests/day on the free API key) and
// serves the subtitle files themselves from dl.subdl.com as plain public
// URLs — no key, no login, no per-account download quota. Verified against
// a live link: an unauthenticated GET returns 200 with the zip. SubDL Pro's
// "API downloads" feature adds *key-authenticated* downloads (tracked, with
// their own 2000/day quota); it is not required to fetch a file.
//
// The trade-off SubDL brings instead is packaging: every subtitle is
// delivered as a ZIP archive, not raw SRT text. Hence readSrtFromZip below.
//
// This module is deliberately pure (no electron/network imports) so it can
// be unit-tested directly — see tests/subdl.test.ts. The network calls live
// in subtitlesService.ts, matching how opensubtitles.ts is split.

import type { SubtitleResult } from '../../shared/media-hub/types'
import type { OpenSubtitlesSearchItem, OpenSubtitlesSearchPlayback } from './opensubtitles'
import { inflateZipEntry, readZipCentralDirectory } from './zipArchive'

/** Public host serving the subtitle archives. Search results carry only a
 *  root-relative path (`/subtitle/<id>-<id>.zip`); this is the only host it
 *  is ever joined to — see resolveSubdlDownloadUrl's SSRF note. */
export const SUBDL_DOWNLOAD_ORIGIN = 'https://dl.subdl.com'

/**
 * Raw SubDL search result row. Loosely typed on purpose: this is untrusted
 * external API response data, same defensive stance as
 * OpenSubtitlesRawEntry. Field names follow SubDL's snake_case JSON.
 */
export interface SubdlRawEntry {
  release_name?: unknown
  name?: unknown
  url?: unknown
  lang?: unknown
  language?: unknown
  author?: unknown
  hi?: unknown
  season?: unknown
  episode?: unknown
  full_season?: unknown
}

/**
 * Builds the SubDL `/api/v1/subtitles` query.
 *
 * Mirrors buildSearchParams (opensubtitles.ts) decision-for-decision so the
 * two providers answer the same question the same way: prefer the IMDb id
 * when the catalog item has a real `tt` one, fall back to a title query
 * otherwise, and only attach season/episode for non-movies. The anime
 * carve-out is identical too — anime catalog ids are Kitsu/MAL ids that
 * happen to look like IMDb ids in some paths, so they are never sent as
 * `imdb_id`.
 *
 * Differences forced by SubDL's API shape:
 *  - it wants the full `tt1375666` form, where OpenSubtitles wants the bare
 *    digits;
 *  - `type` (movie|tv) is required alongside a title query to disambiguate;
 *  - language codes are uppercase and comma-separated.
 */
export function buildSubdlSearchParams(
  item: OpenSubtitlesSearchItem | undefined,
  playback: OpenSubtitlesSearchPlayback = {}
): Record<string, string | number> {
  const params: Record<string, string | number> = {
    languages: String(playback.language || 'en').toUpperCase(),
    subs_per_page: 30
  }

  const imdbMatch = String(item?.id || '').match(/^tt(\d+)$/)
  if (imdbMatch && item?.type !== 'anime') {
    params.imdb_id = imdbMatch[0]
  } else {
    params.film_name = String(item?.title || '').trim()
  }

  if (item?.type === 'movie') {
    params.type = 'movie'
  } else {
    params.type = 'tv'
    if (Number.isFinite(playback.season)) params.season_number = playback.season as number
    if (Number.isFinite(playback.episode)) params.episode_number = playback.episode as number
  }

  return params
}

/**
 * Normalizes a SubDL row into the same SubtitleResult the OpenSubtitles
 * path produces, so the renderer's subtitle menu stays provider-agnostic.
 *
 * `fileId` is 0 for every SubDL row: OpenSubtitles identifies a file by an
 * integer id posted to its /download endpoint, whereas SubDL identifies one
 * by the archive path carried in `downloadPath`. The apply path picks which
 * field to trust off `provider`, never off which field happens to be set.
 *
 * SubDL exposes no download counter, so `downloadCount` is 0 — which sorts
 * SubDL rows below OpenSubtitles rows if anything ever sorts on it, and is
 * honest rather than inventing a number.
 */
export function normalizeSubdlResult(entry: unknown): SubtitleResult {
  const raw = (entry ?? {}) as SubdlRawEntry
  const path = String(raw.url || '')
  return {
    id: `subdl:${path}`,
    provider: 'subdl',
    fileId: 0,
    downloadPath: path,
    fileName: String(raw.name || raw.release_name || ''),
    language: String(raw.language || raw.lang || ''),
    releaseName: String(raw.release_name || raw.name || ''),
    downloadCount: 0,
    uploader: String(raw.author || 'Anonymous'),
    hearingImpaired: Boolean(raw.hi),
    // SubDL has no hash-matching endpoint — see SubtitleResult.hashMatch.
    hashMatch: false
  }
}

/**
 * Turns an untrusted archive path into an absolute download URL, or ''.
 *
 * This is an SSRF boundary, not a formatting helper. The path arrives from
 * the renderer (the subtitle the person clicked, round-tripped through IPC),
 * so it is treated as attacker-controlled: only a root-relative `.zip` path
 * built from a conservative character set is accepted, and it is resolved
 * against SUBDL_DOWNLOAD_ORIGIN with the result re-checked to confirm the
 * origin did not move. That rejects absolute URLs, protocol-relative
 * `//evil.host/x.zip`, and `..` traversal that would otherwise let a
 * compromised renderer point the main process at an arbitrary host.
 */
export function resolveSubdlDownloadUrl(downloadPath: unknown): string {
  const path = String(downloadPath || '')
  if (!/^\/[A-Za-z0-9._~\-/]+\.zip$/.test(path) || path.includes('..')) return ''
  try {
    const url = new URL(path, SUBDL_DOWNLOAD_ORIGIN)
    return url.origin === SUBDL_DOWNLOAD_ORIGIN ? url.toString() : ''
  } catch {
    return ''
  }
}

// --- ZIP reading -----------------------------------------------------------
//
// The actual zip-parsing lives in zipArchive.ts now — a Letterboxd import
// needs the same central-directory-plus-inflate logic this originally had
// all to itself, and re-typing a binary format parser per caller is not the
// kind of "small local duplication" this codebase otherwise prefers over a
// shared utility. This file keeps the SRT-specific shape: which entry to
// pick out of an archive, how big is too big, and the encoding fallback.

/** Refuses to inflate anything absurd for a subtitle. A real SRT is tens of
 *  KB; this is a zip-bomb guard, not a real-world limit. */
const MAX_SUBTITLE_BYTES = 8 * 1024 * 1024

/**
 * Decodes subtitle bytes to text.
 *
 * SubDL hosts community uploads, and a large share of non-English SRTs are
 * still legacy single-byte encodings (windows-1252 for western European,
 * windows-1256 for Farsi/Arabic, and so on) rather than UTF-8. Decoding
 * those as UTF-8 does not throw by default — it silently produces U+FFFD
 * replacement characters, i.e. visibly mangled subtitles. So this decodes
 * strictly first and only falls back on failure, which is the one case
 * where the bytes are definitely not UTF-8. windows-1252 is the fallback
 * because it maps every byte to something printable, so it degrades to
 * "wrong accents" rather than "throws"; a full charset detector would be a
 * bigger dependency than this feature warrants.
 */
function decodeSubtitleText(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

/**
 * Extracts the SRT text from a downloaded SubDL archive.
 *
 * Only `.srt` is accepted. The rest of the pipeline is SRT-shaped —
 * The player parses SRT timestamps directly, and playbackSession writes the text out
 * as a .srt for ffmpeg burn-in — so handing it an .ass/.ssa would not fail
 * loudly, it would render as garbage or as nothing. Refusing with a clear
 * message is the honest outcome; the person can pick another release from
 * the same menu.
 *
 * Directory entries and __MACOSX resource forks are skipped: season packs
 * are routinely zipped with both.
 */
export function readSrtFromZip(archive: Buffer): string {
  const candidates = readZipCentralDirectory(archive).filter(
    (entry) =>
      entry.fileName.toLowerCase().endsWith('.srt') &&
      !entry.fileName.endsWith('/') &&
      !entry.fileName.startsWith('__MACOSX/')
  )

  if (!candidates.length) {
    throw new Error('The subtitle archive contained no .srt file.')
  }
  const entry = candidates[0]
  if (entry.uncompressedSize > MAX_SUBTITLE_BYTES) {
    throw new Error('The subtitle file is unexpectedly large.')
  }

  // Strip a leading UTF-8 BOM: it survives decoding as U+FEFF and would
  // otherwise land in front of the first cue number, where a subtitle parser's
  // timestamp match no longer lines up with the block. Written as an escape
  // rather than a literal so it stays visible to anyone reading the source.
  return decodeSubtitleText(inflateZipEntry(archive, entry, MAX_SUBTITLE_BYTES)).replace(
    /^\ufeff/,
    ''
  )
}
