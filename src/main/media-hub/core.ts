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
  AnimeStoryLink,
  CacheSourceRef,
  CatalogItem,
  ContinueWatchingEntry,
  Episode,
  HistoryEntry,
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
import { releaseTextMentionsExecutable } from '../../shared/media-hub/unsafeFiles'
import { releaseLacksPreferredLanguage } from '../../shared/media-hub/language'
import { streamResolution, streamText } from '../../shared/media-hub/streamQuality'

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
// Both moved to shared/media-hub/streamQuality.ts, and re-exported here so
// this module's own callers are unchanged: the renderer needs the identical
// answer to decide whether to warn before playing, and two implementations of
// "is this 1080p" would eventually disagree in the one way that matters —
// warning about a title that played perfectly well.
export { streamResolution, streamText }

function streamSizeGb(stream: StreamCandidate): number | null {
  const text = streamText(stream)
  const match = text.match(/([\d.]+)\s*(tb|gb|mb)\b/)
  if (match) {
    const amount = Number(match[1])
    return match[2] === 'tb' ? amount * 1024 : match[2] === 'mb' ? amount / 1024 : amount
  }
  const bytes = Number(stream.size || stream.sizeBytes)
  return Number.isFinite(bytes) && bytes > 0 ? bytes / 1024 ** 3 : null
}

export interface StreamLimits {
  maxResolution?: number
  maxSizeGb?: number
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
  // A file on the media server is exempt from all of this. Every penalty
  // below models one problem — the time it takes to pull a huge file over
  // the internet before playback can start — and that problem does not
  // exist for a file already sitting on a box one LAN hop away. Penalising
  // a local remux would be actively backwards: a remux is precisely the
  // kind of release someone keeps on their own server, and it is the case
  // the on-site tier handles best.
  if (stream.source === 'mediaserver') return 0
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

/**
 * How well seeded an UNCACHED release is — the one thing the scrapers have
 * always reported and the ranking has never read.
 *
 * Both add-ons put it in the same place, confirmed live against
 * `torrentio.strem.fun` and the Comet instance on 2026-08-29: a `👤 N` run
 * in the text streamText already builds. Torrentio carried one on all 66
 * results for a test title (5 to 2081, median 13); Comet on 807 of 1628.
 *
 * WHY IT MATTERS MORE THAN IT LOOKS. When nothing is cached, resolve does not
 * merely rank — it SUBMITS the winner to TorBox to start caching (see the
 * `queued` path). That choice was previously blind to whether a release had
 * two seeders or two thousand, so the app could commit somebody's account, and
 * their evening, to a torrent that was never going to arrive.
 *
 * ABSENCE IS NEUTRAL, WHICH IS NOT THE SAME AS ZERO — OR AS NOTHING. Half of
 * Comet's results carry no count at all, so scoring a missing count as "0
 * seeders" would systematically demote one whole add-on for saying nothing.
 * Awarding no bonus is just as wrong for the same reason: it would put an
 * unknown release below one advertising a single seeder, which is precisely
 * backwards. An unknown therefore scores the MIDPOINT of this term's own
 * range, so it loses to a well-seeded release, beats a barely-seeded one, and
 * a set where nothing reports a count is shifted by a constant and so ordered
 * exactly as it was before. The break-even is around nine seeders.
 *
 * UNCACHED ONLY. A cached candidate is already on TorBox's disk and needs no
 * peers whatsoever — and Comet's `👤 0` entries are largely debrid-account
 * results, which are exactly the most playable ones. Scoring them on seeders
 * would punish them for a number that does not apply to them.
 *
 * SATURATING, because the risk is not linear: 0 to 30 seeders is the whole
 * question and 500 to 5000 is noise. Above SEEDER_SATURATION the term stops
 * growing.
 */
const SEEDER_SATURATION = 100

/**
 * Below the SMALLEST gap between adjacent resolution steps, so this orders
 * candidates WITHIN a quality tier and can never quietly hand somebody a
 * lower tier than they asked for. Choosing between tiers on availability is
 * a bigger claim than this evidence supports.
 *
 * The bound was 900, checked against the 2160-to-1080 gap of 1080 — the
 * LARGEST step, and the only one the test covered. Every other step is much
 * smaller (RESOLUTION_STEPS is 480, 720, 1080, 1440, 2160, so the tightest
 * gap is 240), and 900 cleared three of them: a 720p release with 5000
 * seeders beat a 1080p one with none, which is exactly the swap the comment
 * said could not happen. Bounded by the smallest gap now, not the biggest.
 *
 * The break-even against an unknown count is unchanged at roughly nine
 * seeders — it is a ratio within this term, so it does not move with the
 * term's size.
 */
const SEEDER_WEIGHT = 200

/** The seeder count a release advertises, or null when it does not.
 *  Exported for the ranking test. */
export function streamSeeders(stream: StreamCandidate): number | null {
  const match = streamText(stream).match(/\u{1F464}\s*([\d,]+)/u)
  if (!match) return null
  const value = Number(match[1].replace(/,/g, ''))
  return Number.isFinite(value) && value >= 0 ? value : null
}

function seederBonus(stream: StreamCandidate): number {
  if (stream.cached !== false) return 0
  const seeders = streamSeeders(stream)
  if (seeders === null) return SEEDER_WEIGHT / 2
  const ratio = Math.log10(seeders + 1) / Math.log10(SEEDER_SATURATION + 1)
  return Math.round(SEEDER_WEIGHT * Math.min(1, ratio))
}

/**
 * Whether a release advertises executable content — its own name, or the
 * file listing some scraper add-ons put in `description` (see streamText).
 *
 * A media centre has no use for a torrent containing a .exe, and "film
 * plus dropper" is a standard delivery on public trackers, so this is a
 * hard exclusion rather than a ranking penalty: no quality score should
 * ever be able to outweigh it. Applied at discovery, which is what keeps
 * such a torrent from being submitted to TorBox in the first place —
 * once submitted, the whole payload gets fetched into the person's
 * account whether this app ever plays a byte of it or not.
 */
export function isUnsafeStream(stream: StreamCandidate): boolean {
  return releaseTextMentionsExecutable(streamText(stream))
}

/** Drops releases advertising executables, then ranks what's left with the
 *  person's audio-language preference applied. */
export function rankSafeStreams(
  streams: StreamCandidate[],
  preferredLanguage = 'en',
  limits: StreamLimits = {},
  sourcePreference: SourcePreference = 'balanced'
): StreamCandidate[] {
  return rankStreams(
    streams.filter((s) => !isUnsafeStream(s)),
    preferredLanguage,
    limits,
    sourcePreference
  )
}

/**
 * What a release in the wrong language costs it.
 *
 * Large enough that no resolution or cache advantage can outweigh it — a
 * 4K French dub must never beat a 1080p English copy — but a penalty
 * rather than an exclusion, because if the only copy of a film in
 * existence is the French dub, playing it beats playing nothing. It just
 * has to lose to anything English.
 */
const WRONG_LANGUAGE_PENALTY = 40000

/**
 * What a media-server copy is worth, relative to a TorBox one.
 *
 * This is the single knob the three kinds of user differ on, so it is a
 * setting rather than a constant:
 *
 *  - prefer-local: sized above WRONG_LANGUAGE_PENALTY's neighbours so the
 *    local copy wins essentially always. For the person on a slow link who
 *    put the file on the server precisely so it would be used.
 *  - balanced: 5000. Below the `cached` gate (20000), so a local copy
 *    never beats a "can actually be played right now" distinction, and
 *    above one resolution step (max 4320), so it wins ties and beats one
 *    tier down — a local 1080p is preferred to a remote 2160p, a local
 *    720p is not. Same sizing logic as REMUX_PENALTY above.
 *  - prefer-quality: 0. The local copy competes on pure merit and wins
 *    only an exact tie, which the `cached` term already decides its way.
 */
export type SourcePreference = 'prefer-local' | 'balanced' | 'prefer-quality'

const LOCAL_SOURCE_BONUS: Record<SourcePreference, number> = {
  'prefer-local': 60000,
  balanced: 5000,
  'prefer-quality': 0
}

export function rankStreams(
  streams: StreamCandidate[],
  preferredLanguage = 'en',
  limits: StreamLimits = {},
  sourcePreference: SourcePreference = 'balanced'
): StreamCandidate[] {
  const score = (s: StreamCandidate): number =>
    (s.exact === false ? 0 : 100000) +
    (s.cached === false ? 0 : 20000) +
    (s.compatible === false ? -50000 : 10000) +
    (s.source === 'mediaserver' ? LOCAL_SOURCE_BONUS[sourcePreference] : 0) +
    streamResolution(s) +
    // Only ever separates uncached candidates, and only within a resolution
    // tier — see seederBonus for both bounds and why absence is not zero.
    seederBonus(s) -
    streamingPenalty(s) -
    // Reported live: a film played with French audio and French subtitles.
    // Track selection can't fix that one — a dub is a different release,
    // and there was no English in the file to select. It has to be settled
    // here, when the release is chosen.
    (releaseLacksPreferredLanguage(streamText(s), preferredLanguage) ? WRONG_LANGUAGE_PENALTY : 0)
  const withinLimits = streams.filter((stream) => {
    const resolution = streamResolution(stream)
    const size = streamSizeGb(stream)
    return (
      (!limits.maxResolution || !resolution || resolution <= limits.maxResolution) &&
      (!limits.maxSizeGb || size === null || size <= limits.maxSizeGb)
    )
  })
  return [...withinLimits].sort((a, b) => score(b) - score(a))
}

/**
 * Rebuilds a candidate for the source a partial session was pulled from, so
 * the same release can be re-requested and its existing bytes resumed.
 *
 * Returns null when the release cannot be re-requested — no recorded
 * source (sessions predating sourceRef), or that source is no longer
 * configured. Falling through to the normal search is right in both cases:
 * better to fetch a different encode than to fail, and streamCache simply
 * declines to adopt the mismatched bytes.
 */
export function resumeCandidateFor(
  cached: {
    title: string
    resolution?: number
    sourceRef?: CacheSourceRef
  },
  torboxConnected: boolean,
  mediaServerConnected: boolean
): StreamCandidate | null {
  const ref = cached.sourceRef
  if (!ref) return null
  const base = {
    name: cached.title,
    resolution: cached.resolution,
    cached: true,
    compatible: true,
    exact: true
  }
  if (ref.source === 'mediaserver' && ref.itemId && ref.mediaSourceId) {
    if (!mediaServerConnected) return null
    return { ...base, source: 'mediaserver', itemId: ref.itemId, mediaSourceId: ref.mediaSourceId }
  }
  if (ref.source === 'torbox' && ref.infoHash) {
    if (!torboxConnected) return null
    return {
      ...base,
      source: 'torbox',
      infoHash: ref.infoHash,
      // Carried back so the resume picks the SAME file the first play did
      // (and can re-add the torrent with its trackers if TorBox dropped it).
      ...(ref.fileIdx != null ? { fileIdx: ref.fileIdx } : {}),
      ...(ref.sources?.length ? { sources: ref.sources } : {})
    }
  }
  return null
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
function normalizeMetaVideo(v: RawApiPayload, lightweight = false): Episode {
  const season = numberOr(v.season, 1)
  const episode = numberOr(v.episode ?? v.number, 1)
  return {
    id: v.id || `${season}:${episode}`,
    season,
    episode,
    number: episode,
    title: lightweight ? '' : v.title || v.name || `Episode ${episode}`,
    released: v.released || v.firstAired || '',
    description: lightweight ? '' : v.description || v.overview || '',
    thumbnail: lightweight ? '' : v.thumbnail || ''
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

/**
 * `lightweight` blanks the three per-episode fields nothing on a crawl path
 * ever reads — `title`, `description`, `thumbnail` — exactly as
 * normalizeKitsuAnime's own flag does, and for the same reason: the browse
 * catalog is stored as ONE cache row per kind and shipped to the renderer
 * whole, so per-episode prose is paid for on every catalog:list by every
 * series in the library. Cinemeta's series metas carry a full synopsis and a
 * thumbnail URL per episode; measured against the live catalog, dropping
 * them halves a series entry (5,960 -> 2,658 bytes).
 *
 * The array itself — one entry per episode, with real `season`/`episode`
 * numbers — is NOT shortened. Those positions are what the browse grid's
 * episode/season counts and its "Completed" badge are derived from
 * (adapters.ts's seasonEpisodeCounts and isSeriesCompleted); emptying it
 * would make every series read as "no episode data" and permanently hide a
 * badge someone earned. That exact regression was shipped and caught once
 * already on the anime side — see normalizeKitsuAnime.
 *
 * Safe to blank the prose specifically because no reader of a CATALOG
 * entry's videos ever shows it: the detail page's episode list comes from
 * metadata()'s own per-title fetch (full, unflagged, cached 24h), and
 * metadata()'s catalog-entry fallback explicitly discards `videos` and
 * refetches from Simkl rather than reusing them (`{ ...source, videos: [] }`
 * in catalog.ts). Defaults to false so that per-title path is untouched.
 */
export function normalizeMeta(
  meta: RawApiPayload,
  fallbackType?: MediaKind,
  lightweight = false
): CatalogItem {
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
    videos: Array.isArray(meta.videos)
      ? meta.videos.map((v) => normalizeMetaVideo(v, lightweight))
      : [],
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

/**
 * `lightweight` shrinks the two placeholder fields nothing at crawl time
 * ever reads (`id`, `title`) down to empty strings, instead of the
 * templated `"kitsu:12345:1:37"` / `"Episode 37"` this always generated.
 *
 * The array itself — one entry per episode, with real `season`/`episode`
 * numbers — is NOT skipped or shortened, even though the browse grid only
 * ever reads its `.length` (see CatalogItem.episodeCounts' doc comment):
 * those positions are also how a browse-grid "Completed" badge gets
 * computed (adapters.ts's isSeriesCompleted, via episodeWatchState
 * matching real watch-history season/episode pairs against this list) —
 * an empty array here would make every anime in the browse grid read as
 * "0 episodes aired," permanently hiding a completed badge someone
 * actually earned. Traced deliberately before shipping this: an earlier
 * version of this change did exactly that and would have shipped a real
 * regression.
 *
 * Defaults to false (full placeholder objects) because two real callers
 * still show the `title`/`id` text: metadata()'s per-title fetch, whose
 * placeholders are a genuine last-resort fallback if even
 * kitsuRealEpisodes comes back empty (see catalog.ts), and
 * buildGroupedAnimeVideos's equivalent per-season fallback
 * (animeSeasons.ts). Only the CRAWL paths — the ~1000-title popularity
 * crawl and free-text search — pass `lightweight: true`.
 */
export function normalizeKitsuAnime(record: RawApiPayload, lightweight = false): CatalogItem {
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
      id: lightweight ? '' : `${id}:1:${i + 1}`,
      season: 1,
      episode: i + 1,
      number: i + 1,
      title: lightweight ? '' : `Episode ${i + 1}`,
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

const STORY_ANIME_ROLES = new Set<AnimeStoryLink['relation']>(['sequel', 'prequel'])

/** Direct before/after entries from Kitsu. Side stories and recaps are not
 * useful answers to "what should I watch next?"; an absent sequel is never
 * treated as proof that a future season will not happen. */
export function animeStoryLinks(payload: RawApiPayload = {}): AnimeStoryLink[] {
  const included = new Map(
    (payload.included || [])
      .filter((x: RawApiPayload) => x.type === 'anime')
      .map((x: RawApiPayload) => [String(x.id), x])
  )
  const seen = new Set<string>()
  const links: AnimeStoryLink[] = []
  for (const rel of payload.data || []) {
    const relation = rel.attributes?.role
    if (!STORY_ANIME_ROLES.has(relation)) continue
    const destId = rel.relationships?.destination?.data?.id
    const dest = destId !== undefined ? included.get(String(destId)) : null
    if (!dest) continue
    const key = `${relation}:${destId}`
    if (seen.has(key)) continue
    seen.add(key)
    links.push({ relation, item: normalizeKitsuAnime(dest as RawApiPayload) })
  }
  return links
}

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

/**
 * One TMDB movie/tv record as a CatalogItem, keyed by the IMDb id the
 * caller has already resolved (every id in this app is IMDb-keyed, and
 * TMDB's own numeric id is useless to the rest of it).
 *
 * Handles both shapes from the one function because TMDB names the same
 * fields differently per media type — `title`/`release_date` for movies,
 * `name`/`first_air_date` for tv — and the similar-titles path (see
 * catalog.ts) needs both.
 *
 * `genres` is passed in rather than read off the record: list endpoints
 * return `genre_ids`, not names, so resolving them needs TMDB's separate
 * genre dictionary, which is the caller's job to fetch and cache once.
 */
export function normalizeTmdbTitle(
  record: RawApiPayload,
  imdbId: string,
  type: 'movie' | 'series',
  genres: string[] = []
): CatalogItem {
  const date = String(
    (type === 'series' ? record.first_air_date : record.release_date) || ''
  ).slice(0, 4)
  return {
    id: imdbId,
    type,
    title:
      (type === 'series' ? record.name || record.original_name : record.title) ||
      record.original_title ||
      'Untitled',
    poster: record.poster_path ? `https://image.tmdb.org/t/p/w500${record.poster_path}` : '',
    background: record.backdrop_path
      ? `https://image.tmdb.org/t/p/w780${record.backdrop_path}`
      : '',
    logo: '',
    year: date,
    description: record.overview || '',
    rating: String(record.vote_average || ''),
    runtime: '',
    genres,
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

/**
 * Fills the gaps in `into` from `from`, without ever overwriting something
 * already there.
 *
 * The two sources describe the same title but do not carry the same fields:
 * a Simkl trending entry has a simklId and no episode list at all, a
 * Cinemeta entry has the full episode list and no simklId. Whichever is
 * seen first should keep its position and its own values, and gain what it
 * was missing — which is exactly what the index's own upsert does with
 * COALESCE(NULLIF(...)), applied here so the two agree.
 *
 * Empty counts as missing, deliberately: `videos: []` and `poster: ''` are
 * how these normalizers say "this source has none", not "this source says
 * there are none".
 */
function fillMissing(into: CatalogItem, from: CatalogItem): CatalogItem {
  const merged: CatalogItem = { ...into }
  for (const key of [
    'poster',
    'background',
    'logo',
    'description',
    'status',
    'rating',
    'runtime',
    'year'
  ] as const) {
    if (!merged[key] && from[key]) merged[key] = from[key]
  }
  if (!merged.genres?.length && from.genres?.length) merged.genres = from.genres
  if (!merged.videos?.length && from.videos?.length) merged.videos = from.videos
  if (!merged.trailers?.length && from.trailers?.length) merged.trailers = from.trailers
  if (merged.simklId == null && from.simklId != null) merged.simklId = from.simklId
  if (!merged.episodeCounts && from.episodeCounts) merged.episodeCounts = from.episodeCounts
  if (!merged.groupedIds?.length && from.groupedIds?.length) merged.groupedIds = from.groupedIds
  return merged
}

/**
 * Merges the settled results of several catalog sources into one list, in
 * the order the sources were given, ignoring any that failed.
 *
 * Source order is the ranking: the first occurrence of an id keeps its
 * position, so a title present in both a trending feed and a top-rated
 * list keeps its trending position.
 *
 * A duplicate is COALESCED into the first occurrence rather than dropped,
 * which is a fix rather than a refinement. Measured live against the real
 * catalogs: 546 of Cinemeta's 1,999 series also appear in Simkl's trending
 * feeds, Simkl is read first for its ranking, and a Simkl entry carries
 * `videos: []`. Dropping the Cinemeta duplicate therefore threw away the
 * episode list for 546 titles — and not a random 546, but the most popular
 * ones, the top of the grid. Those titles showed no season or episode
 * counts, and could never earn a "Completed" badge, because the data that
 * answers both had been discarded on the way in.
 *
 * Position still comes from the first occurrence; only the gaps are filled.
 *
 * Separated out and given its own tests because the property that matters
 * here is a negative one: a source that fails must cost its own
 * contribution and nothing else. This is what preserves the guarantee the
 * old try-Simkl-then-fall-back-to-Cinemeta chain gave — an unreachable
 * Simkl still yields a Cinemeta-filled catalog, and vice versa — now that
 * both are read together rather than one being conditional on the other
 * failing.
 */
export function mergeCatalogSources(
  results: readonly PromiseSettledResult<CatalogItem[][]>[]
): CatalogItem[] {
  const order: string[] = []
  const byId = new Map<string, CatalogItem>()
  for (const result of results) {
    if (result.status !== 'fulfilled') continue
    for (const item of result.value.flat()) {
      const id = String(item?.id || '')
      // An idless entry is what a malformed source record normalizes to; it
      // can never be opened or played, so it takes no slot.
      if (!id) continue
      const existing = byId.get(id)
      if (existing) byId.set(id, fillMissing(existing, item))
      else {
        order.push(id)
        byId.set(id, item)
      }
    }
  }
  return order.map((id) => byId.get(id) as CatalogItem)
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
