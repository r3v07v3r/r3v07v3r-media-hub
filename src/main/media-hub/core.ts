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

/** Every human-readable field a scraper puts the release details in.
 *  `description` is the important one and was previously read by nothing:
 *  Comet returns a generic `name` ("[TORRENT] Comet 2160p") and an empty
 *  `title`, and puts the actual filename, codecs, audio format and size
 *  in `description` — e.g. "Interstellar.2014.2160p.PROPER.IMAX.REMUX.DV.
 *  HDR10+.TrueHD.7.1.Atmos-...mkv ... 💾 63.0 GB". Scoring on name alone
 *  meant every candidate looked identical apart from the resolution. */
function streamText(stream: StreamCandidate): string {
  return `${stream.name || ''} ${stream.title || ''} ${stream.description || ''}`.toLowerCase()
}

function streamResolution(stream: StreamCandidate): number {
  const text = streamText(stream)
  if (/2160|4k/.test(text)) return 2160
  if (/1080/.test(text)) return 1080
  if (/720/.test(text)) return 720
  return stream.resolution || 0
}

/** How hostile a release is to *streaming*, as opposed to how good it
 *  looks. Disc remuxes are the top of the quality pile and the bottom of
 *  the playability one: a real one seen live here carried ~90 streams —
 *  one video, PCM 24-bit 7.1 audio, and 60+ hdmv_pgs_subtitle tracks.
 *  Lossless audio guarantees the compatibility transcoder engages, and
 *  ffmpeg then has to identify every one of those tracks over the network
 *  before it emits a single byte. It never finished inside even the
 *  extended 60s startup budget, so the title simply would not play —
 *  while a perfectly good x264 release of the same film sat lower in the
 *  ranking purely because the remux was 2160p.
 *
 *  Matched on the release name, which is the same text streamResolution
 *  already reads. Deliberately narrow: only the markers that actually
 *  imply a disc-sized, many-track, lossless-audio package. "BluRay" alone
 *  is NOT one of them — an ordinary BluRay-sourced x264 encode is exactly
 *  what we want to pick. */
function streamingPenalty(stream: StreamCandidate): number {
  const text = streamText(stream)
  let penalty = 0
  // Disc-remux and lossless-audio markers. "BluRay" alone is deliberately
  // absent — an ordinary BluRay-sourced x264/x265 encode is exactly what
  // we want to pick; it's the untouched disc streams that hurt.
  if (/remux|bdmv|\bpcm\b|truehd|dts-hd|dts hd|dtshd|dts-x|atmos|lossless/.test(text)) {
    penalty += REMUX_PENALTY
  }
  // Size, when the scraper reports it. An independent signal from the
  // markers above and a blunt one: whatever a 60GB file is, it is not the
  // right thing to start streaming in a few seconds. Caught live at
  // "💾 63.0 GB".
  const size = text.match(/([\d.]+)\s*gb\b/)
  if (size && Number(size[1]) > OVERSIZED_GB) penalty += REMUX_PENALTY
  // Deliberately NO codec penalty. An earlier version demoted HEVC here,
  // on the theory that it forces a re-encode — but Chromium decodes HEVC
  // natively, so the stream-copy path handles it fine (verified live:
  // 3840x2160 hevc, playing in 13s). Demoting it would only have pushed
  // 4K HDR releases down the ranking for no gain.
  return penalty
}

/** Sized to sit between the resolution term (max ~4320) and the `cached`
 *  gate (20000) on purpose: big enough that a remux always loses to a
 *  normal release regardless of resolution, small enough that a CACHED
 *  remux still beats an UNCACHED web encode — an uncached candidate can't
 *  be played right now at all, so it's not the better answer. */
const REMUX_PENALTY = 8000

/** Above this, a file is a disc image in all but name. Both penalties can
 *  apply at once (16000 total), which still stays under the `cached`
 *  gate — a cached monster is preferred to an uncached anything, because
 *  the uncached one can't be played at all right now. */
const OVERSIZED_GB = 25

export function rankStreams(streams: StreamCandidate[]): StreamCandidate[] {
  const score = (s: StreamCandidate): number =>
    (s.exact === false ? 0 : 100000) +
    (s.cached === false ? 0 : 20000) +
    (s.compatible === false ? -50000 : 10000) +
    streamResolution(s) -
    streamingPenalty(s)
  return [...streams].sort((a, b) => score(b) - score(a))
}

export function validateTorBoxToken(token: unknown): boolean {
  return typeof token === 'string' && token.trim().length >= 24 && !/\s/.test(token.trim())
}

/**
 * Config for the P2P scraper add-on's `/{b64config}/stream/...json` route
 * (see torbox.ts's stream:resolve). The add-on this pointed to ("Meteor")
 * was retired and now redirects to a different, unrelated add-on ("Comet",
 * https://github.com/g0ldyy/comet) that has its own, much larger config
 * schema — the old `{debridService, debridApiKey, maxResults, allowP2P}`
 * shape (and this function's former name/pair, meteorConfigPath/
 * meteorP2PConfigPath) is rejected outright ("obsolete configuration").
 * This shape and its encoding (plain `btoa`/base64, NOT base64url) were
 * reverse-engineered directly from Comet's own /configure page's inline
 * getSettings()/getManifestUrl() JS (not documented anywhere) and verified
 * live against the actual hosted instance this app talks to — confirmed
 * to return real infoHash-bearing candidates. `debridServices` is left
 * empty deliberately: this app already does its own authoritative
 * checkcached call against the user's real TorBox account right after
 * (see torbox.ts), so there's no need to hand this third-party add-on the
 * user's TorBox API key just to get candidates discovered.
 */
export function cometConfigPath(): string {
  return Buffer.from(
    JSON.stringify({
      maxResultsPerResolution: 0,
      maxSize: 0,
      cachedOnly: false,
      sortCachedUncachedTogether: false,
      removeTrash: true,
      resultFormat: ['all'],
      debridServices: [],
      enableTorrent: true,
      deduplicateStreams: false,
      scrapeDebridAccountTorrents: false,
      debridStreamProxyPassword: '',
      languages: { required: [], allowed: [], exclude: [], preferred: [] },
      resolutions: {},
      options: {
        remove_ranks_under: -10000000000,
        allow_english_in_languages: false,
        remove_unknown_languages: false
      }
    }),
    'utf8'
  ).toString('base64')
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

// `Number(x) || fallback` would silently turn a real season/episode 0
// (season 0 is Cinemeta's own specials convention) into the fallback — 0
// is falsy in JS, not "missing". Only a genuinely non-numeric/absent
// value should fall back.
function numberOr(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

// Cinemeta's raw video entries use `.name` for the episode title (never
// `.title`) — a blind pass-through of `meta.videos` left every episode
// title falling back to "Episode N" in the UI, found live via Heroes
// showing "Episode 1" instead of "Genesis". `.overview`/`.description`,
// `.released`/`.firstAired`, and `.episode`/`.number` are all genuinely
// duplicated by Cinemeta itself, so those don't need remapping.
function normalizeMetaVideo(v: RawApiPayload): Episode {
  const season = numberOr(v.season, 1)
  const episode = numberOr(v.episode ?? v.number, 1)
  return {
    id: v.id || `${season}:${episode}`,
    season,
    episode,
    number: episode,
    title: v.title || v.name || `Episode ${episode}`,
    released: v.released || v.firstAired || '',
    description: v.description || v.overview || '',
    thumbnail: v.thumbnail || ''
  }
}

// Bug fix: Cinemeta sometimes reuses the exact same `id`/`season`/`episode`
// for a real numbered episode AND one or more unrelated bonus/promotional
// featurettes — found live via Star Trek: Strange New Worlds, where a
// "Inside The Series" preview clip and two other featurettes all carry the
// literal same id/season/episode as S1E1 itself. Since EpisodesSection
// keys its list on `ep.id` and filters by `ep.season === selectedSeason`,
// those collisions manifested as: the featurettes' watched state bleeding
// onto the real episode (episodeKey is season:episode, shared by all four),
// and — the visible symptom — React warning about duplicate list keys and
// then, on the next season switch, some of the stale featurette rows
// sticking around instead of being replaced by the new season's episodes
// (duplicate keys leave React's reconciliation unable to tell which fiber
// belongs to which item, which is exactly the kind of "leftover rows"
// glitch React's own docs warn is undefined behavior).
//
// Applied once, centrally, to every source that assembles an episode list
// (Cinemeta-normalized, the Simkl fallback fetch, and grouped-anime's own
// TMDB-backed build — see catalog.ts's metadata()) rather than duplicated
// per-source, so any of them exhibiting this same upstream-data quirk gets
// the same protection. The FIRST video seen for a given season+episode is
// assumed to be the real one (every case observed so far lists the genuine
// episode before any stray duplicate) and is left untouched; every later
// duplicate is moved into season 0 — this app's existing "Specials" bucket
// (see EpisodesSection's seasonLabel) — with a disambiguated id and a
// negative episode number, which can never collide with a real,
// positively-numbered special Cinemeta itself already tags as season 0.
//
// unplayable:true is the important part beyond just dodging the id/key
// collision: (season:0, episode:-1) isn't a real coordinate the scraper/
// TorBox pipeline can resolve a stream for, and season 0 sorts before
// every real season — so left unmarked, one of these would become
// MediaDetailPage's `nextEpisode`/default selected season (the first
// unwatched entry in season+episode order) and "Next to Play" would try
// to play a promotional clip that doesn't exist as a playable file. Every
// consumer that picks a play/next target (MediaDetailPage's nextEpisode
// and its episodes[0] fallback, EpisodesSection's Play button) must skip
// entries with this flag; they're informational list entries only.
export function disambiguateVideos(videos: Episode[]): Episode[] {
  const seen = new Set<string>()
  let extraCount = 0
  return videos.map((v) => {
    const dedupeKey = `${v.season}:${v.episode}`
    if (!seen.has(dedupeKey)) {
      seen.add(dedupeKey)
      return v
    }
    extraCount += 1
    return {
      ...v,
      season: 0,
      episode: -extraCount,
      number: -extraCount,
      id: `${v.id}:extra${extraCount}`,
      unplayable: true
    }
  })
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
    videos: Array.isArray(meta.videos) ? meta.videos.map(normalizeMetaVideo) : [],
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
    released: a.airdate || '',
    description: a.synopsis || a.description || '',
    thumbnail: a.thumbnail?.original || ''
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

/**
 * Whether a raw release name (a torrent's own declared name, a file path,
 * or similar free text) is plausibly a release of `requestedTitle`, not a
 * different-but-related title — see torbox.ts's streamResolve, which found
 * live that a P2P scraper add-on's own "exact match" flag isn't reliable
 * for a franchise with several similarly-prefixed entries: a "Dragon Ball
 * Z Complete Series" batch torrent came back flagged exact for a request
 * for "Dragon Ball" (a different, if related, show/catalog id). Reuses
 * enrichTorBoxItem's own parseReleaseName + mediaKey pipeline and requires
 * an EXACT match after normalization, not a substring check — substring
 * inclusion is exactly what fails here, since "dragonball" is a substring
 * of "dragonballz" too.
 */
export function titleMatchesRelease(releaseText: string, requestedTitle: string): boolean {
  if (!requestedTitle.trim()) return true
  const parsed = parseReleaseName(releaseText)
  return mediaKey(parsed.title) === mediaKey(requestedTitle)
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
  const episodic =
    typeof season === 'number' &&
    Number.isFinite(season) &&
    typeof episode === 'number' &&
    Number.isFinite(episode)
  if (episodic) {
    // Both padded (S01E03) and unpadded (S1E3) forms of each number, since
    // real-world release names aren't consistent about zero-padding —
    // matching only the padded season while requiring a padded episode (the
    // original patterns' actual behavior) silently missed plenty of
    // otherwise-correctly-named files.
    const sPad = String(season).padStart(2, '0')
    const ePad = String(episode).padStart(2, '0')
    const patterns = [
      new RegExp(`S(?:${season}|${sPad})[ ._-]*E(?:${episode}|${ePad})(?:\\D|$)`, 'i'),
      new RegExp(`(?:^|[ ._-])(?:${season}|${sPad})x(?:${episode}|${ePad})(?:[ ._-]|$)`, 'i'),
      // Anime fansub convention: a lone episode number after a dash, no
      // season marker anywhere (fansub groups essentially never encode
      // season — it's implicit) — e.g. "[SubsPlease] Show - 05 (1080p)
      // [HASH].mkv". Found live: this is the *normal* single-episode
      // release shape, not an edge case — SxxExx/1x05 patterns above never
      // match it at all. Restricted to season 1 since a bare "- 05" in a
      // later season's own release would be genuinely ambiguous with a
      // season-1 episode of the same number.
      ...(season === 1 ? [new RegExp(`-\\s*0*${episode}(?:v\\d)?(?:[ ._[(]|$)`, 'i')] : [])
    ]
    const filtered = candidates.filter((f) =>
      patterns.some((p) => p.test(f.name || f.short_name || ''))
    )
    // A torrent with only one video file at all has no ambiguity to guess
    // wrong about, regardless of what its name looks like — this is the
    // normal shape for a single-episode fansub release, unlike the
    // multi-file season-pack case the comment below is actually guarding
    // against.
    if (!filtered.length && candidates.length === 1) return candidates[0]
    const match = filtered.sort((a, b) => (b.size || 0) - (a.size || 0))[0]
    // Deliberately NOT falling back to "largest video file in the torrent"
    // for a torrent with MULTIPLE files, unlike the movie path below — a
    // season-pack torrent's file names not matching any expected pattern
    // means we genuinely don't know which file is the requested episode,
    // and guessing "biggest file" reliably picks a DIFFERENT, usually
    // longer episode (a finale, a double-length episode, ...) instead of
    // erroring. Live-reported bug: requesting a specific episode played a
    // different, longer one instead of failing loudly — this fallback
    // returning ANY video file in the pack whenever the season/episode
    // patterns didn't match is exactly that failure mode.
    return match || null
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
