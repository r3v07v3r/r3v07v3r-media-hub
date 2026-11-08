// SubtitleDB (thesubtitledb.org) — the subtitle provider that needs nothing
// set up, and the one searched first.
//
// Why a third provider: both SubDL and OpenSubtitles want an account and a
// key before the Subtitles menu can find anything online, so a fresh
// install had no online subtitles until somebody signed up somewhere.
// SubtitleDB's lookups (by IMDb id, TMDB id, torrent info hash, release
// name or title) and its downloads take no key at all: 1,000 downloads an
// hour anonymously, which no viewer approaches. Only its whole-catalogue
// text search is keyed, and nothing here needs that. Its catalogue is also
// the largest of the three (checked 2026-11-08: 117 English files for
// Captain America: The Winter Soldier against SubDL's 30), and the info-hash
// lookup matches the exact torrent playing, which is the frame-accurate
// match OpenSubtitles needs a file hash for.
//
// Caveats, so nobody is surprised: the service is young (API v1, public
// since autumn 2026), its catalogue is crawled from the web and torrents,
// and a file can open with a few "©" credit cues even with the watermark
// filter on (stripLeadingCredits below takes those off). SubDL and
// OpenSubtitles stay as optional extras for anyone who has keys.
//
// Deliberately pure (no electron/network imports), like subdl.ts and
// opensubtitles.ts, so tests/subtitledb.test.ts can import it directly. The
// requests live in subtitlesService.ts.

import type { SubtitleResult } from '../../shared/media-hub/types'
import type { OpenSubtitlesSearchItem, OpenSubtitlesSearchPlayback } from './opensubtitles'

export const TSDB_API_ORIGIN = 'https://api.thesubtitledb.org'

/** Rows asked for per lookup. The menu shows 20 in total across providers;
 *  asking for more here lets a hash-matched or SRT-only pick survive the
 *  merge's share-out, and the API caps a page at 100 anyway. */
const TSDB_PAGE_LIMIT = 50

/**
 * The query every lookup carries: the wanted language, SRT only (the
 * player path is SRT-shaped end to end; see subdl.ts's readSrtFromZip for
 * why an .ass would render as nothing), and the fullest file first. Fullest
 * (most cues), not newest: checked live, "newest" put three 28-cue
 * forced-narrative tracks at the top of a film with 1,800-cue full
 * subtitles below them, and the automatic fetch applies the first row.
 */
function tsdbQuery(language: string): URLSearchParams {
  return new URLSearchParams({
    lang: String(language || 'en').toLowerCase(),
    format: 'srt',
    sort: 'cues',
    limit: String(TSDB_PAGE_LIMIT)
  })
}

/**
 * The lookup path for a catalog item: `/v1/by-imdb/<tt…>` with the season
 * and episode appended for an episode, or `/v1/by-title?q=` when the item
 * has no IMDb id (anime ids are Kitsu's, which SubtitleDB cannot know; the
 * caller has already swapped in the show's IMDb id where the bridge knows
 * it, see subtitlesService.ts's searchableItem). Returns '' when there is
 * nothing to ask for at all.
 */
export function buildTsdbLookupPath(
  item: OpenSubtitlesSearchItem | undefined,
  playback: OpenSubtitlesSearchPlayback = {}
): string {
  const query = tsdbQuery(playback.language || 'en')
  const imdbMatch = String(item?.id || '').match(/^tt\d+$/)
  const episodic =
    item?.type !== 'movie' && Number.isFinite(playback.season) && Number.isFinite(playback.episode)
  if (imdbMatch && item?.type !== 'anime') {
    let path = `/v1/by-imdb/${imdbMatch[0]}`
    if (episodic) path += `/season/${playback.season}/episode/${playback.episode}`
    return `${path}?${query}`
  }
  const title = String(item?.title || '').trim()
  if (!title) return ''
  // "Fargo S01E02" at the end of the name is how by-title takes an episode.
  const q = episodic
    ? `${title} S${String(playback.season).padStart(2, '0')}E${String(playback.episode).padStart(2, '0')}`
    : title
  query.set('q', q)
  query.set('type', item?.type === 'movie' ? 'movie' : 'tv')
  return `/v1/by-title?${query}`
}

/** The lookup path for the torrent playing, or '' when the hash is not a
 *  40-hex info hash. Its rows are timed to this exact release. */
export function buildTsdbInfohashPath(infoHash: string | undefined, language: string): string {
  const hash = String(infoHash || '').toLowerCase()
  if (!/^[a-f0-9]{40}$/.test(hash)) return ''
  return `/v1/by-infohash/${hash}?${tsdbQuery(language)}`
}

/** Raw SubtitleDB subtitle row. Loosely typed on purpose: untrusted API
 *  response data, same stance as OpenSubtitlesRawEntry. */
interface TsdbRawEntry {
  id?: unknown
  language?: unknown
  format?: unknown
  release_name?: unknown
  hearing_impaired?: unknown
  uploader?: unknown
  ai_transcribed?: unknown
}

/** The shape of every lookup response's subtitle list. */
export interface TsdbLookupResponse {
  subtitles?: { items?: unknown[] }
}

/**
 * Normalizes a SubtitleDB row into the provider-agnostic SubtitleResult.
 *
 * `downloadPath` is `/get/<id>`, resolved by resolveTsdbDownloadUrl at
 * download time; `fileId` stays 0 as for SubDL (an OpenSubtitles concept).
 * A row whose id is not a positive integer normalizes to an empty
 * downloadPath, and the search drops it. The release name is cut at the
 * first line break: SubtitleDB joins several release names with "\r\n"
 * when one file fits several, and a menu row has room for one.
 */
export function normalizeTsdbResult(entry: unknown, hashMatch = false): SubtitleResult {
  const raw = (entry ?? {}) as TsdbRawEntry
  const id = Number(raw.id)
  const valid = Number.isInteger(id) && id > 0
  const release = String(raw.release_name || '')
    .split(/\r?\n/)[0]
    .trim()
  return {
    id: valid ? `subtitledb:${id}` : 'subtitledb:',
    provider: 'subtitledb',
    fileId: 0,
    downloadPath: valid ? `/get/${id}` : '',
    fileName: release,
    language: String(raw.language || ''),
    releaseName: release,
    downloadCount: 0,
    uploader: String(raw.uploader || 'Anonymous'),
    hearingImpaired: Boolean(raw.hearing_impaired),
    hashMatch
  }
}

/**
 * Turns an untrusted `/get/<id>` path into the download URL, or ''.
 *
 * The same SSRF boundary as subdl.ts's resolveSubdlDownloadUrl: the path
 * has made the round trip through the renderer, so only a bare `/get/`
 * plus digits is accepted and it is joined to the API origin alone. The
 * watermark filter is asked for: it strips the "downloaded from …" credit
 * cues a crawled file often opens and closes with.
 */
export function resolveTsdbDownloadUrl(downloadPath: unknown): string {
  const match = /^\/get\/(\d{1,12})$/.exec(String(downloadPath || ''))
  if (!match) return ''
  return `${TSDB_API_ORIGIN}/get/${match[1]}?remove_watermark=true`
}

/** How far into a file a credit stamp may run. A real first line lands
 *  later than this in practice (a cold open has a title card first). */
const CREDIT_STAMP_WINDOW_S = 20
/** How many leading cues are examined at most. A typewriter stamp is a
 *  few dozen cues; this bounds the work on a hostile file. */
const CREDIT_STAMP_MAX_CUES = 80
/** What makes a run of opening cues a credit stamp rather than dialogue:
 *  a copyright or trademark mark, a web or e-mail address, a phone number,
 *  or the words such stamps are made of. Without one of these somewhere in
 *  the run, nothing is removed, however short the lines. */
const CREDIT_STAMP_EVIDENCE =
  /[©®™]|https?:|www\.|\.(?:com|net|org|co|tv|io)\b|\S+@\S+\.\S+|\+?\d[\d\s-]{7,}\d|\b(?:downloaded|subtitles?|subs|sync(?:ed|hronized)?|corrected|translat(?:ed|ion)|encoded|ripped|uploaded)\b/iu

/**
 * Drops the credit stamp a crawled file often opens with, where the
 * service's own filter (which examines the first three cues) has not:
 * a run of leading cues inside the first seconds that carry no word, or
 * that type a credit out letter by letter, each cue's text a prefix of
 * the next ("©", "© P", "© P@rM…"), hold the typed credit for a few cues,
 * and add a line to it — and that, somewhere, carries the mark of a credit
 * (CREDIT_STAMP_EVIDENCE). The shape alone is not enough: "No." followed
 * by "No. Stop!" has it too, and an opening "I…" has no two letters.
 * Anything else, the file as it was: the first cue with a real word that
 * is not part of such a run ends the stamp, and a file whose first cue is
 * dialogue loses nothing. Cue numbers are left as they were; players do
 * not read them.
 */
export function stripLeadingCredits(srt: string): string {
  const blocks = srt.split(/\r?\n\r?\n/)
  const texts: string[] = []
  const starts: number[] = []
  for (const block of blocks.slice(0, CREDIT_STAMP_MAX_CUES)) {
    const lines = block.split(/\r?\n/)
    const timing = lines.findIndex((line) => /-->/.test(line))
    if (timing < 0) return srt
    const match = /^(\d+):(\d\d):(\d\d)[,.](\d{1,3})/.exec(lines[timing].trim())
    if (!match) return srt
    starts.push(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]))
    texts.push(
      lines
        .slice(timing + 1)
        .join(' ')
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    )
  }
  let drop = 0
  while (drop < texts.length && starts[drop] < CREDIT_STAMP_WINDOW_S) {
    const text = texts[drop]
    const next = texts[drop + 1]
    const previous = drop > 0 ? texts[drop - 1] : undefined
    const wordless = !/\p{L}{2}/u.test(text)
    const typesNext =
      next !== undefined && text.length > 0 && next !== text && next.startsWith(text)
    // A repeat or an extension counts only once the run has begun
    // (previous is undefined on the first cue), so an opening line said
    // twice is never taken for a stamp.
    const continuesPrevious =
      previous !== undefined && previous.length > 0 && text.startsWith(previous)
    // A credit line proper ("Downloaded from …") is part of the stamp too.
    const credit = CREDIT_STAMP_EVIDENCE.test(text)
    if (!wordless && !typesNext && !continuesPrevious && !credit) break
    drop++
  }
  if (!drop) return srt
  if (!texts.slice(0, drop).some((text) => CREDIT_STAMP_EVIDENCE.test(text))) return srt
  return blocks.slice(drop).join('\n\n')
}
