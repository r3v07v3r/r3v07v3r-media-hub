// Main-process orchestration helpers for the media-hub backend integration —
// a straight port of r3v07v3r-media-hub's src/core.cjs (that app's business
// logic layer, sitting between main.cjs's IPC handlers and its
// TorBox/Simkl/Kitsu/TMDB API clients) into this project's
// src/main/media-hub/ directory. Logic is preserved 1:1 (translated to
// TypeScript, not redesigned). The original module re-exports everything
// from shared.js as part of its own public API surface — that pattern is
// kept here too, re-exporting the five catalog-logic.ts functions this
// file also consumes internally, so downstream orchestration code can
// import everything it needs from this one module.

import {
  CatalogItem,
  ContinueWatchingEntry,
  Episode,
  HistoryEntry,
  LibraryItem,
  MediaKind,
  StreamCandidate,
  Trailer
} from '../../shared/media-hub/types'
import {
  airingStatus,
  episodeWatchState,
  filterCatalog,
  isItemWatched,
  subtitlesInadequate
} from '../../shared/media-hub/catalog-logic'

export { airingStatus, episodeWatchState, filterCatalog, isItemWatched, subtitlesInadequate }

// Loose "raw external JSON" type for third-party API payloads (Cinemeta,
// Kitsu, Simkl, TMDB, TorBox) that aren't worth fully modeling — the
// contract that matters is each normalize function's CatalogItem/Episode/
// LibraryItem *output*, not these dynamic inputs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RawApiPayload = Record<string, any>

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function createRoomCode(random: () => number = Math.random): string {
  let value = ''
  for (let i = 0; i < 6; i++) {
    value += ROOM_ALPHABET[Math.floor(random() * ROOM_ALPHABET.length) % ROOM_ALPHABET.length]
  }
  return `${value.slice(0, 3)}-${value.slice(3)}`
}

function streamResolution(stream: StreamCandidate): number {
  const text = `${stream.name || ''} ${stream.title || ''}`.toLowerCase()
  if (/2160|4k/.test(text)) return 2160
  if (/1080/.test(text)) return 1080
  if (/720/.test(text)) return 720
  return stream.resolution || 0
}

export function rankStreams(streams: StreamCandidate[]): StreamCandidate[] {
  const score = (s: StreamCandidate): number =>
    (s.exact === false ? 0 : 100000) +
    (s.cached === false ? 0 : 20000) +
    (s.compatible === false ? -50000 : 10000) +
    streamResolution(s)
  return [...streams].sort((a, b) => score(b) - score(a))
}

export function validateTorBoxToken(token: unknown): boolean {
  return typeof token === 'string' && token.trim().length >= 24 && !/\s/.test(token.trim())
}

export function meteorConfigPath(token: string): string {
  return Buffer.from(
    JSON.stringify({
      debridService: 'torbox',
      debridApiKey: token,
      maxResults: '20',
      cachedOnly: true,
      allowP2P: false
    }),
    'utf8'
  ).toString('base64url')
}

export function meteorP2PConfigPath(): string {
  return Buffer.from(
    JSON.stringify({
      debridService: 'torrent',
      debridApiKey: '',
      maxResults: '30',
      allowP2P: true
    }),
    'utf8'
  ).toString('base64url')
}

interface RawTrailerInput {
  source?: string
  youtubeId?: string
  id?: string
  type?: string
  name?: string
}

function normalizeTrailers(values?: (string | RawTrailerInput)[]): Trailer[] {
  return (values || [])
    .map((x) =>
      typeof x === 'string'
        ? { source: x, type: 'Trailer', name: 'Trailer' }
        : {
            source: x.source || x.youtubeId || x.id || '',
            type: x.type || 'Trailer',
            name: x.name || x.type || 'Trailer'
          }
    )
    .filter((x) => /^[\w-]{6,20}$/.test(x.source))
}

export function normalizeMeta(meta: RawApiPayload, fallbackType?: MediaKind): CatalogItem {
  return {
    id: meta.id || meta.imdb_id,
    title: meta.name || meta.title || 'Untitled',
    type: fallbackType || meta.type,
    poster: meta.poster || '',
    background: meta.background || '',
    logo: meta.logo || '',
    year: String(meta.year || ''),
    status: meta.status || '',
    description: meta.description || '',
    rating: String(meta.imdbRating || meta.rating || ''),
    runtime: String(meta.runtime || ''),
    genres: Array.isArray(meta.genres) ? meta.genres : Array.isArray(meta.genre) ? meta.genre : [],
    videos: Array.isArray(meta.videos) ? meta.videos : [],
    trailers: normalizeTrailers(meta.trailers || meta.trailerStreams)
  }
}

export function normalizeKitsuEpisode(record: RawApiPayload, parentId: string): Episode {
  const a = record.attributes || {}
  const season = Number(a.seasonNumber) || 1
  const episode = Number(a.number) || 1
  return {
    id: `${parentId}:${season}:${episode}`,
    season,
    episode,
    number: episode,
    title: a.canonicalTitle || a.titles?.en_us || a.titles?.en || `Episode ${episode}`,
    released: a.airdate || ''
  }
}

export function normalizeKitsuAnime(record: RawApiPayload): CatalogItem {
  const a = record.attributes || {}
  const id = `kitsu:${record.id}`
  const count = Number(a.episodeCount) || 0
  return {
    id,
    title: a.canonicalTitle || a.titles?.en_us || a.titles?.en || 'Untitled',
    type: 'anime',
    poster: a.posterImage?.large || a.posterImage?.original || '',
    background: a.coverImage?.large || a.coverImage?.original || '',
    logo: '',
    year: String(a.startDate || '').slice(0, 4),
    status: a.status || '',
    description: a.synopsis || a.description || '',
    rating:
      a.averageRating != null && a.averageRating !== ''
        ? (Number(a.averageRating) / 10).toFixed(1)
        : '',
    runtime: a.episodeLength ? `${a.episodeLength} min` : '',
    genres: Array.isArray(a.genres) ? a.genres : [],
    videos: Array.from({ length: count }, (_, i) => ({
      id: `${id}:1:${i + 1}`,
      season: 1,
      episode: i + 1,
      number: i + 1,
      title: `Episode ${i + 1}`,
      released: ''
    })),
    trailers: normalizeTrailers(a.youtubeVideoId ? [a.youtubeVideoId] : [])
  }
}

export function normalizeSimklCatalog(item: RawApiPayload, type: MediaKind): CatalogItem {
  const year = String(item.release_date || '').match(/\d{4}/)?.[0] || String(item.year || '')
  const poster = item.poster ? `https://simkl.in/posters/${item.poster}_m.jpg` : ''
  const background = item.fanart ? `https://simkl.in/fanart/${item.fanart}_medium.jpg` : ''
  return {
    id: item.ids?.imdb || `simkl:${item.ids?.simkl_id}`,
    simklId: item.ids?.simkl_id,
    title: item.title || 'Untitled',
    type,
    poster,
    background,
    logo: '',
    year,
    description: item.overview || '',
    rating: String(item.ratings?.imdb?.rating || item.ratings?.simkl?.rating || ''),
    runtime: String(item.runtime || ''),
    genres: Array.isArray(item.genres) ? item.genres : [],
    videos: [],
    trailers: normalizeTrailers(item.trailer ? [item.trailer] : [])
  }
}

export function normalizeSimklSearchResult(item: RawApiPayload, type: MediaKind): CatalogItem {
  const poster = item.poster ? `https://simkl.in/posters/${item.poster}_m.jpg` : ''
  return {
    id: `simkl:${item.ids?.simkl_id}`,
    title: item.title || 'Untitled',
    type,
    poster,
    background: '',
    logo: '',
    year: String(item.year || ''),
    description: '',
    rating: String(item.ratings?.imdb?.rating || item.ratings?.simkl?.rating || ''),
    runtime: '',
    genres: [],
    videos: [],
    trailers: []
  }
}

const FRANCHISE_ANIME_ROLES = new Set([
  'sequel',
  'prequel',
  'side_story',
  'spin_off',
  'parent_story',
  'alternative_version',
  'alternative_setting',
  'full_story',
  'summary'
])

export function filterAnimeRelationships(payload: RawApiPayload = {}): CatalogItem[] {
  const included = new Map(
    (payload.included || [])
      .filter((x: RawApiPayload) => x.type === 'anime')
      .map((x: RawApiPayload) => [String(x.id), x])
  )
  const entries: CatalogItem[] = []
  for (const rel of payload.data || []) {
    const role = rel.attributes?.role
    if (!FRANCHISE_ANIME_ROLES.has(role)) continue
    const destId = rel.relationships?.destination?.data?.id
    const dest = destId !== undefined ? included.get(String(destId)) : null
    if (!dest) continue
    entries.push(normalizeKitsuAnime(dest as RawApiPayload))
  }
  return entries
}

export function normalizeTmdbCollectionPart(part: RawApiPayload, imdbId: string): CatalogItem {
  return {
    id: imdbId,
    type: 'movie',
    title: part.title || part.original_title || 'Untitled',
    poster: part.poster_path ? `https://image.tmdb.org/t/p/w500${part.poster_path}` : '',
    background: '',
    logo: '',
    year: String(part.release_date || '').slice(0, 4),
    description: part.overview || '',
    rating: String(part.vote_average || ''),
    runtime: '',
    genres: [],
    videos: [],
    trailers: []
  }
}

function readableTitle(value: string): string {
  const words = value
    .replace(/[._]+/g, ' ')
    .replace(/\[[^\]]*]|\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
  const loud =
    words.join('').toUpperCase() === words.join('') ||
    words.join('').toLowerCase() === words.join('')
  return words
    .map((word, index) => {
      if (!loud) return word
      const lower = word.toLowerCase()
      if (
        index &&
        ['a', 'an', 'and', 'at', 'for', 'in', 'of', 'on', 'or', 'the', 'to'].includes(lower)
      ) {
        return lower
      }
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join(' ')
}

export interface ParsedReleaseName {
  title: string
  year: string
  season: number | null
  episode: number | null
}

export function parseReleaseName(value: string): ParsedReleaseName {
  let name = String(value || '')
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(mkv|mp4|avi|mov|webm|m4v|ts)$/i, '')
  let season: number | null = null
  let episode: number | null = null
  let year = ''
  const ep =
    name.match(/(?:^|[ ._-])S(\d{1,2})[ ._-]*E(\d{1,3})/i) ||
    name.match(/(?:^|[ ._-])(\d{1,2})x(\d{1,3})(?:[ ._-]|$)/i)
  if (ep) {
    season = Number(ep[1])
    episode = Number(ep[2])
    name = name.slice(0, ep.index)
  } else {
    const years = [...name.matchAll(/(?:^|[ ._-])((?:19|20)\d{2})(?=[ ._-]|$)/g)]
    const match = years.at(-1)
    if (match && match.index! > 0) {
      year = match[1]
      name = name.slice(0, match.index)
    }
  }
  name = name.replace(
    /(?:^|[ ._-])(2160p|1080p|720p|480p|uhd|bluray|brrip|webrip|web-dl|web|hdtv|remux|x26[45]|h26[45]|hevc|av1|aac|ddp?\d(?:\.\d)?|dts|atmos).*$/i,
    ''
  )
  return { title: readableTitle(name) || 'Untitled', year, season, episode }
}

function librarySourceName(raw: RawApiPayload): string {
  const files: RawApiPayload[] = raw.files || raw.file_list || []
  return (
    raw.name ||
    raw.filename ||
    files.find((f) => /\.(mkv|mp4|avi|mov|webm|m4v|ts)$/i.test(f.name || f.short_name || ''))
      ?.name ||
    'Untitled'
  )
}

function mediaKey(value: string): string {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
}

export function enrichTorBoxItem(raw: RawApiPayload, catalog: CatalogItem[] = []): LibraryItem {
  const parsed = parseReleaseName(librarySourceName(raw))
  const key = mediaKey(parsed.title)
  const matches = catalog.filter((x) => mediaKey(x.title) === key)
  const match = matches.find((x) => !parsed.year || String(x.year) === parsed.year) || matches[0]
  // Original JS: `match?.type||(parsed.season?'series':'movie')` — match.type
  // comes from the shared CatalogItem catalog and can be 'anime', but
  // LibraryItem.mediaType only models 'movie'|'series' (library entries
  // don't carry an anime distinction). The original had no runtime guard
  // against this either, so the value is preserved as-is via a cast rather
  // than redesigning the fallback behavior.
  const mediaType = (match?.type || (parsed.season ? 'series' : 'movie')) as 'movie' | 'series'
  return {
    id: String(raw.id || raw.torrent_id || raw.hash || librarySourceName(raw)),
    title: match?.title || parsed.title,
    type: 'library',
    mediaType,
    year: match?.year || parsed.year || raw.download_state || raw.state || '',
    season: parsed.season,
    episode: parsed.episode,
    poster: match?.poster || raw.poster || '',
    background: match?.background || raw.background || '',
    description: match?.description || '',
    rating: match?.rating || '',
    runtime: match?.runtime || '',
    genres: match?.genres || [],
    metadataId: match?.id || '',
    raw
  }
}

export function selectPlayableStream(streams?: StreamCandidate[]): StreamCandidate | null {
  const playable = (streams || []).filter(
    (s) => typeof s.url === 'string' && /^https?:\/\//.test(s.url)
  )
  return rankStreams(playable)[0] || null
}

export interface TorBoxFile {
  id?: string | number
  file_id?: string | number
  name?: string
  short_name?: string
  size?: number
}

export function selectVideoFile(
  files: TorBoxFile[] | undefined,
  season?: number | null,
  episode?: number | null
): TorBoxFile | null {
  const video = /\.(mkv|mp4|avi|mov|webm|m4v|ts)$/i
  const candidates = [...(files || [])].filter((f) => video.test(f.name || f.short_name || ''))
  if (
    typeof season === 'number' &&
    Number.isFinite(season) &&
    typeof episode === 'number' &&
    Number.isFinite(episode)
  ) {
    const s = String(season).padStart(2, '0')
    const e = String(episode).padStart(2, '0')
    const patterns = [
      new RegExp(`S${s}[ ._-]*E${e}`, 'i'),
      new RegExp(`(?:^|[ ._-])${season}x${e}(?:[ ._-]|$)`, 'i')
    ]
    const match = candidates
      .filter((f) => patterns.some((p) => p.test(f.name || f.short_name || '')))
      .sort((a, b) => (b.size || 0) - (a.size || 0))[0]
    if (match) return match
  }
  return candidates.sort((a, b) => (b.size || 0) - (a.size || 0))[0] || null
}

export function dedupeCatalog(groups: CatalogItem[][]): CatalogItem[] {
  const seen = new Set<string>()
  const result: CatalogItem[] = []
  for (const item of (groups || []).flat()) {
    const key = String(item?.id || '')
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

function lastWatchedAt(history: HistoryEntry[], contentId: string): string {
  let latest = ''
  for (const h of history || []) {
    if (String(h.id) !== String(contentId) || !h.watchedAt) continue
    if (!latest || new Date(h.watchedAt) > new Date(latest)) latest = h.watchedAt
  }
  return latest
}

export function continueWatchingList(
  details: CatalogItem[],
  history: HistoryEntry[]
): ContinueWatchingEntry[] {
  const rows: ContinueWatchingEntry[] = []
  for (const detail of details || []) {
    const episodes = (detail.videos || [])
      .filter((v) => (v.season ?? 1) > 0)
      .sort(
        (a, b) =>
          (a.season || 1) - (b.season || 1) ||
          (a.episode || a.number || 0) - (b.episode || b.number || 0)
      )
    if (!episodes.length) continue
    const progress = episodeWatchState(episodes, history, detail.id)
    if (progress.watchedCount === 0 || progress.watchedCount >= progress.total) continue
    const next = episodes[progress.nextIndex >= 0 ? progress.nextIndex : 0]
    rows.push({
      ...detail,
      continueSeason: next.season || 1,
      continueEpisode: next.episode || next.number || 1,
      watchedCount: progress.watchedCount,
      totalCount: progress.total,
      lastWatchedAt: lastWatchedAt(history, detail.id)
    })
  }
  return rows.sort(
    (a, b) => new Date(b.lastWatchedAt).getTime() - new Date(a.lastWatchedAt).getTime()
  )
}
