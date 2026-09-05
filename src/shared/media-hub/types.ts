// Shared data-model contract for the media-hub backend integration —
// ported from r3v07v3r/r3v07v3r-media-hub (a separate, standalone
// TorBox-powered Electron app) into this project's main/preload/renderer
// split. Kept in one place, like ipc-types.ts, so main's real return
// shapes and the renderer's consumption of them can never silently drift.
//
// Field names intentionally mirror the original app's `core.cjs` /
// `database.cjs` normalize functions exactly (not renamed to fit this
// project's `MediaItem` type) — the mapping from these "media-hub" shapes
// to the dashboard's own `MediaItem` type happens explicitly at the
// renderer's data-fetching hooks (see routes/lib/mediaHubAdapters.ts),
// rather than silently here, so it's obvious where each field comes from.

export type MediaKind = 'movie' | 'series' | 'anime'

export interface Trailer {
  source: string
  type: string
  name: string
}

export interface Episode {
  id: string
  season: number
  episode: number
  number: number
  title: string
  released: string
  description?: string
  thumbnail?: string
  /** Set by disambiguateVideos (core.ts) for a duplicate-id/season/episode
   *  entry it moved into the synthetic "Specials" bucket — a promotional
   *  clip or similar with no real (season, episode) coordinate the
   *  scraper/TorBox pipeline can resolve a stream for. Consumers that pick
   *  a "next episode" or a play target must skip these; they're
   *  informational list entries only. */
  unplayable?: boolean
}

// The canonical normalized catalog item — union of every field any of the
// four normalize sources (Cinemeta, Kitsu, Simkl catalog, Simkl search,
// TMDB collection part) ever populate. Not every field is present from
// every source; treat all as optional except the ones every normalizer
// guarantees (id/title/type).
export interface CatalogItem {
  id: string
  simklId?: number
  title: string
  /** The source's own-language name when `title` is a translation — a
   *  Kitsu anime's romaji canonical title under its English one. Shown as
   *  a secondary line, searched alongside `title`, and matched against
   *  release names alongside it: releases are named in romaji, so without
   *  it an English title would find no stream at all. */
  originalTitle?: string
  type: MediaKind
  poster: string
  background: string
  logo: string
  year: string
  status?: string
  description: string
  rating: string
  /** Rotten Tomatoes critic score (0-100, as a plain number string, e.g.
   *  "87" — no "%" suffix, matching `rating`'s own bare-number convention),
   *  from OMDb (see main/media-hub/omdb.ts). Movie/series only — OMDb has no
   *  meaningful anime coverage, and anime CatalogItems have no real IMDb id
   *  to query it with anyway (see metadata()'s own gating in catalog.ts).
   *  Undefined whenever OMDb isn't connected or has no Rotten Tomatoes
   *  entry for this title, never a guessed/invented value. */
  rottenTomatoesRating?: string
  runtime: string
  genres: string[]
  /** Top-billed performers, best-known first. Populated by metadata() where
   *  a source has them (TMDB, for movie/series) — absent on catalog-list
   *  entries, and on anime, which credits voice actors per character rather
   *  than per title. See main/media-hub/credits.ts. */
  cast?: string[]
  /** Directors for a film, creators for a show, studios for anime. Same availability as `cast`. */
  creators?: string[]
  /** Story-type labels — TMDB keywords, or AniList tags for anime. The
   *  closest thing this catalog has to what KIND of story a title is,
   *  where `genres` only says which of five or six buckets it falls in. */
  keywords?: string[]
  videos: Episode[]
  trailers: Trailer[]
  /** Anime only — sibling Kitsu ids confirmed (via a shared TheTVDB series
   *  id, see animeSeasons.ts) to be later seasons of the same franchise as
   *  this item, sorted by season ascending, excluding this item's own id.
   *  Kitsu models each season/cour as its own top-level resource with no
   *  franchise grouping at all, unlike Simkl (series/movie), which already
   *  returns one id for a whole show — this is what lets the catalog grid
   *  collapse multi-season anime into one tile instead of one per season,
   *  and lets metadata() build a real multi-season episode list for it. */
  groupedIds?: string[]
  /**
   * Grouped anime only — an override for the season/episode counts the
   * browse grid shows, when `videos` alone would under-report them.
   *
   * A grouped multi-season anime's canonical CatalogItem (see
   * groupedIds above) still carries only its OWN season's placeholder
   * episodes in `videos` — the other seasons' episodes belong to sibling
   * ids that were folded into `groupedIds`, not merged into `videos`.
   * Deriving the browse-grid count from `videos.length` for a grouped
   * item therefore only ever reported its first season's episode count,
   * and `videos`' single synthesized season (always `season: 1`) meant
   * the season-count badge always read "1" too, regardless of how many
   * seasons the franchise actually has. This carries the real combined
   * totals instead, computed once at grouping time (animeSeasons.ts's
   * groupAnimeCatalog) from every member's own episode count.
   *
   * Optional and additive: every other normalizer (Cinemeta, Simkl,
   * TMDB), and every ungrouped anime, leaves this undefined, and
   * adapters.ts's seasonEpisodeCounts falls back to deriving from
   * `videos` exactly as it always did whenever it's absent.
   */
  episodeCounts?: { totalSeasons: number; totalEpisodes: number }
}

/** The direct sequel/prequel entries Kitsu lists for an anime release. */
/**
 * How a related anime stands to this one, in Kitsu's own vocabulary.
 *
 * `sequel` and `prequel` are the spine; the rest are the bridges — the film
 * between two seasons, the side story set alongside, the recap, the full
 * story a summary condensed — which are exactly what somebody following a
 * franchise in order needs to be shown and used to be filtered out.
 */
export type AnimeStoryRelation =
  'prequel' | 'parent_story' | 'full_story' | 'side_story' | 'spin_off' | 'summary' | 'sequel'

export interface AnimeStoryLink {
  relation: AnimeStoryRelation
  item: CatalogItem
}

/**
 * What one person has in this catalog.
 *
 * Split by role rather than merged, because the two answer different
 * questions: somebody who followed a director wants their films, somebody who
 * followed an actor wants their performances, and a single list ordered by
 * neither serves either.
 */
/**
 * One episode, on one day.
 *
 * Flat rather than grouped by date: the grouping is a presentation decision
 * (a week grid, a list, a "this week / next week" split) and baking one shape
 * into the payload would make every other shape a regrouping.
 */
export interface CalendarEntry {
  contentId: string
  type: MediaKind
  title: string
  poster: string
  season: number
  episode: number
  episodeTitle: string
  /** YYYY-MM-DD, in UTC — the granularity air dates are actually published
   *  at, so carrying a time would be inventing precision. */
  airsOn: string
}

/**
 * The film series a title belongs to.
 *
 * `parts` excludes the title itself — the question is what ELSE is in the
 * series — and every entry carries an IMDb id, because one that could not be
 * resolved back to this catalog would be a card nobody can open.
 */
export interface TitleCollectionResult {
  /** TMDB's own name for the series, e.g. "The Dune Collection". Empty when
   *  the title belongs to no collection, which is true of most films. */
  name: string
  /** Every film in the series, the one on screen included, in release order. */
  parts: CatalogItem[]
  /** The film the question was asked about — the panel marks it rather than
   *  dropping it, so the order reads as an order. */
  currentId?: string
}

export interface PersonCreditsResult {
  person: string
  cast: CatalogItem[]
  creators: CatalogItem[]
}

export interface AnimeStoryResult {
  links: AnimeStoryLink[]
  /** False only if the remote lookup failed without a cached answer. */
  checked: boolean
}

/**
 * Where a playable copy lives. Absent means 'torbox', so every candidate
 * already persisted in the stream cache stays valid without a migration —
 * the field was introduced when the media server was.
 *
 *  localcache  - already on this machine's disk; needs no network at all
 *  lancache    - the on-site pre-fetch daemon (main/media-hub/lanCache.ts)
 *  mediaserver - a configured Jellyfin library
 *  torbox      - the debrid service, over the internet
 *
 * PREFERENCE IS NOT A PROPERTY OF THIS TYPE. There was once a
 * STREAM_SOURCE_RANK here declaring a strict 0..3 ordering, described as
 * "read by resolve" — it never was, by resolve or anything else, and the
 * only thing that referenced it was a test asserting 0 < 1 < 2 < 3 against
 * the constant itself. What actually decides the source is split in two and
 * lives with the code that does it: torbox.ts's streamResolve short-circuits
 * on localcache and then lancache (each quality-gated), and core.ts's
 * rankStreams then SCORES mediaserver against torbox, weighted by the user's
 * SourcePreference — which on 'prefer-quality' deliberately stops caring
 * where a copy lives at all. A single numeric rank cannot express that, and
 * having one here invited exactly the wrong summary of it (see the README's
 * old "local → server → download" section).
 */
export type StreamSource = 'localcache' | 'lancache' | 'mediaserver' | 'torbox'

// A discovered stream candidate (from a scraper add-on or a configured
// media server), after availability checking and ranking merge in
// `cached`/`compatible`.
export interface StreamCandidate {
  source?: StreamSource
  /** Torrent candidates only. Optional because a media-server item has no
   *  torrent behind it at all; play:stream requires it on the torbox
   *  branch and validates it is 40 hex there. */
  infoHash?: string
  /** Media-server candidates only — the Jellyfin item and which of its
   *  media sources (a library can hold more than one file per item). */
  itemId?: string
  mediaSourceId?: string
  /** localcache candidates only — which cache session holds the bytes, and
   *  whether it holds all of them. Only a complete session can be played
   *  without contacting any source. */
  cacheToken?: string
  complete?: boolean
  name?: string
  title?: string
  sources?: string[]
  /** The audio languages the file actually carries, when the source can
   *  say — only a media server can (jellyfin.ts). Strictly better than
   *  inferring them from the release name, and consulted first. */
  audioLanguages?: string[]
  resolution?: number
  cached?: boolean
  compatible?: boolean
  exact?: boolean
  /** The scraper add-on's own index into the torrent's file list for the
   *  specific episode/file this candidate is for — Torrentio provides this
   *  directly (Comet's results don't). Preferred over selectVideoFile's
   *  filename-regex guessing when it lines up with a real video file in
   *  TorBox's own listing (see torbox.ts's play:stream handler) — the
   *  guessing is the fallback, not the first resort, since a large batch
   *  torrent's filenames aren't always confidently parseable. */
  fileIdx?: number
  [key: string]: unknown
}

export interface StreamResolveResult {
  streams: StreamCandidate[]
  best: StreamCandidate | null
  /** True when nothing was cached on TorBox yet, but a real torrent
   *  candidate existed and was just submitted to start caching it (see
   *  torbox.ts's stream:resolve handler) — lets the renderer tell that
   *  apart from a genuine "nothing exists for this title anywhere" dead
   *  end, since only one of those is worth "try again in a few minutes." */
  queued?: boolean
}

export interface MediaTrack {
  ordinal: number
  index: number
  codec: string
  language: string
  title: string
  label: string
  default: boolean
  /** Video tracks only — mpv reports these as demux-w/demux-h. Not currently shown in the UI. */
  width?: number
  height?: number
}

export interface MediaTracks {
  video: MediaTrack[]
  audio: MediaTrack[]
  subtitle: MediaTrack[]
  probed: boolean
  // Total media duration from ffprobe's format section. VLC's
  // compatibility-mode stream is a live, unbounded HTTP push (no
  // Content-Length, no Duration element) — the <video> element itself
  // reports `duration: Infinity` for it, so the renderer needs this
  // independently-probed figure to render a real scrubber and compute seek
  // targets during compatibility playback. Undefined if ffprobe didn't
  // report a usable duration (e.g. probing failed).
  durationSeconds?: number
}

export interface PlaybackSelection {
  audio?: number
  subtitle?: number
  startTime?: number
  externalSubtitlePath?: string
  /** 0 (or omitted) means "no change to whatever's already active" — every restart (seek, track change, subtitle apply) round-trips through this same selection object, so upscale state has to stay sticky across all of them, not just the call that turned it on. Explicitly 0 from the player's own "Off" menu item is what actually turns it back off. */
  upscaleHeight?: number
}

/**
 * Live sub-status for the preparation overlay's third step ("Preparing the
 * stream"), pushed from main while `stream:play` is in flight.
 *
 * That one IPC call covers the entire real critical path for starting a
 * title — TorBox link request, ffprobe, opening the source, filling the
 * first chunks, and (when the source needs it) starting a transcode — and
 * can legitimately take a minute or more on a big remux. Reported live as
 * "it just sat on step 3": a single static label for that whole stretch is
 * indistinguishable from the app having hung. These events say which piece
 * is actually running right now, and how far through it is where that's
 * measurable.
 */
export interface PlaybackPrepareProgress {
  /** Which piece of the step is running. The renderer only renders
   *  `message`; this is here so a future UI (or a log) can tell the phases
   *  apart without parsing prose. */
  // 'probe', 'encoder' and 'transcode' went with the ffmpeg pipeline: there
  // is no separate probe pass, no hardware-encoder detection, and no transcode.
  step: 'link' | 'connect' | 'buffer'
  /** Ready-to-show text, built in main (which is the only side that knows
   *  the real byte counts, buffer settings and codec decisions). */
  message: string
}

/** A download the app refused to write to disk (see main/media-hub/downloadGuard.ts). */
export interface BlockedDownload {
  filename: string
  reason: string
  /** Host it came from. Deliberately not the full URL — a debrid download
   *  link carries an access token in its query string. */
  host: string
}

/** Metadata attached to a stream-cache session at start() time (see
 *  main/media-hub/streamCache.ts's meta.json) so the Downloads page can
 *  show a poster/title for it instead of a bare opaque token. `catalogId`
 *  is the bare catalog id (routable via /:segment/:id) — distinct from the
 *  composite `imdbId:season:episode` key used for stream resolution. */
/**
 * Identifies the exact release a cache session holds.
 *
 * Recorded so a PARTIAL session can be resumed against the same release it
 * was started from. Without it, adopting a partial session and resuming
 * from whatever the resolver picks this time can splice two different
 * encodes of the same film together — the failure the totalBytes check
 * used to prevent by refusing adoption outright.
 */
/**
 * Which part of the library a main-initiated write touched — see
 * rendererBridge.ts's notifyLibraryChanged.
 *
 *  - history: watched rows, positions, plays (Continue Watching, badges,
 *    history and stats all derive from these)
 *  - planned: the tracked / plan-to-watch list
 *  - ratings: personal scores
 *  - lists: named lists — the ones made here and the ones read from Trakt
 *    and Simkl (remoteLists.ts)
 *  - index: the catalog_index rows the browse grids page through
 *  - all: something re-keyed the library wholesale (ids remapped, a
 *    restore) — every hook should start over
 */
export type LibraryChangeScope = 'history' | 'planned' | 'ratings' | 'lists' | 'index' | 'all'

export interface LibraryChangedEvent {
  scopes: LibraryChangeScope[]
  /** Which job or handler wrote — for the log, not for deciding anything. */
  sources: string[]
}

export interface CacheSourceRef {
  source: StreamSource
  /** torbox */
  infoHash?: string
  /** torbox: the add-on's index of the file these bytes came from, so a
   *  resume re-selects it rather than guessing from filenames. Absent on
   *  sessions written before it was recorded. */
  fileIdx?: number
  /** torbox: tracker URLs to rebuild the magnet with — see StreamCandidate.sources. */
  sources?: string[]
  /** mediaserver */
  itemId?: string
  mediaSourceId?: string
}

/**
 * What is actually playing, for the player's Info panel: the release as the
 * scraper named it, its quality and size as read from that name, and which
 * tier the bytes come from.
 */
export interface PlaybackRelease {
  name: string
  resolution?: number
  sizeGb?: number
  source: StreamSource
  infoHash?: string
}

export interface CacheSessionMeta {
  title: string
  posterUrl?: string
  /** The release these bytes are, for the Info panel. */
  release?: PlaybackRelease
  catalogId?: string
  mediaKind?: 'movie' | 'series' | 'anime'
  seasonNumber?: number
  episodeNumber?: number
  /** The episode's own name ("Ghosts"), alongside the coordinates above.
   *  The player overlay's badge and title line render it; absent for
   *  movies and for sessions written before it existed. */
  episodeTitle?: string
  /** Which release these bytes are. Absent on sessions written before this
   *  existed — those stay partial-adoption-ineligible, which is the old
   *  behaviour and safe. */
  sourceRef?: CacheSourceRef
  /** Resolution tier of the cached copy, so the quality target can be
   *  applied to it without re-contacting any source. */
  resolution?: number
}

/** One entry in the Downloads page's "Cached Streams" list. */
export interface StreamCacheEntry extends CacheSessionMeta {
  token: string
  cachedBytes: number
  totalBytes: number | null
  isActive: boolean
}

/**
 * What the local cache holds, and what is left where it lives.
 *
 * freeBytes is null where the platform will not say (statfs is not
 * universal) — rendered as an absence rather than as a zero, because
 * "0 bytes free" is alarming and wrong.
 */
export interface StreamCacheUsage {
  usedBytes: number
  freeBytes: number | null
  /** Where it is, for the one line that says so. */
  directory: string
}

export interface PlaybackResult {
  ok: true
  player: 'embedded'
  tracks: MediaTracks
  /** StreamCache's local server URL for this title. The player opens it
   *  directly; nothing in the renderer loads it anymore. */
  url: string
  /** Which audio track the player resolved for this session. mpv picks it from
   *  the language preference against the container, and "the container's
   *  default" and "the track you are hearing" are routinely different, so the
   *  audio menu has no other way to know what to mark. */
  selection?: { audio?: number }
}

// Tracked-show entry as persisted (normalizeTitle shape) — matches
// CatalogItem's identity fields but is stored/returned independently since
// a tracked item may be stale relative to the live catalog.
/**
 * What this app knows about a title beyond its genres — see
 * main/media-hub/credits.ts for where each field comes from.
 *
 * Declared here rather than in that module because the ranking consumes
 * it, and the ranking is shared code that must not import from main.
 */
export interface TitleCredits {
  /** Top-billed performers, best-known first. Empty for anime, which credits voice actors per character rather than per title. */
  cast: string[]
  /** Directors for a film, creators for a show, studios for anime. */
  creators: string[]
  /** Story-type labels: TMDB keywords, or AniList tags. */
  keywords: string[]
}

/**
 * Why one title was suggested — the signal that actually put it where it
 * is in the ranking, not a caption written over the result.
 *
 * Emitted by the ranker itself (see catalog-logic.ts's
 * rankPersonalizedRecommendationsScored) for exactly that reason: a reason
 * derived afterwards would be a second, independently-wrong opinion about
 * an ordering it did not produce, and would drift the moment the scoring
 * changed. This one is the same comparison the score is made of.
 *
 * Kept OFF CatalogItem deliberately. A catalog item is a fact about a
 * title and is cached as one, shared across every profile on the machine;
 * a reason is a fact about one person's history, and filing it on the
 * title would put one profile's viewing into a row the next profile reads.
 */
export interface RecommendationReason {
  /** Which signal won — see RECOMMENDATION_REASON_ORDER in catalog-logic.ts. */
  kind: 'continues' | 'creator' | 'cast' | 'genre' | 'new'
  /**
   * The evidence, in the person's own terms: the title they finished, the
   * name they keep coming back to, the genre they watch. Always something
   * that was really matched — never a guess, and never a placeholder, so a
   * reason with nothing to point at is simply not emitted.
   */
  detail: string
}

/**
 * One viewing brought in from somewhere else — a Trakt history row, and
 * whatever import comes after it.
 *
 * `watchedAt` is the WHOLE point and the reason this is not just a
 * TrackedItem. An import that stamps everything "now" puts a decade of
 * somebody's viewing at the top of their recently-watched, and teaches the
 * cadence profile (see catalog-logic.ts) that they watch everything at
 * whatever time of day they happened to press Import.
 */
export interface ImportedPlay {
  id: string
  type: MediaKind
  title: string
  year?: string
  /** Null for a film. Season 0 is the specials convention and is not null. */
  season?: number | null
  episode?: number | null
  /** ISO 8601, as the source recorded it. */
  watchedAt: string
}

/** What an import actually changed. Every field is a count of NEW rows, not of rows offered. */
export interface ImportSummary {
  /** Viewings written. Excludes anything already recorded — an import is repeatable. */
  plays: number
  /** Ratings written. Excludes titles already rated here, which are not overwritten. */
  ratings: number
  /** Rows the source offered that could not be matched to a title this app knows. */
  skipped: number
}

export interface TrackedItem {
  id: string
  simklId: number | null
  type: MediaKind
  title: string
  poster: string
  background: string
  logo: string
  year: string
  genres: string[]
  description: string
  rating: string
  runtime: string
  trailers: Trailer[]
}

export type AiringState = 'airing' | 'upcoming' | 'ended' | 'unknown' | ''

export interface TrackedItemEnriched extends TrackedItem {
  newEpisodeCount: number
  airing: AiringState
}

export interface TrackedUpdate extends TrackedItem {
  newEpisodeCount: number
  latestEpisode: Episode
}

export interface HistoryEntry extends Partial<TrackedItem> {
  id: string
  type: MediaKind
  season: number | null
  episode: number | null
  // Nullable because Simkl's "all items" sync omits last_watched_at for
  // some movies — see watchedFromAllItems in main/media-hub/simkl.ts.
  watchedAt: string | null
}

/**
 * One viewing, from the append-only `plays` table.
 *
 * Distinct from HistoryEntry above, which is one row per title-and-episode
 * (the "have I seen this" index). A title watched three times has one
 * HistoryEntry and three PlayRecords, which is the difference the history
 * view exists to show.
 */
export interface PlayRecord {
  playId: number
  contentId: string
  type: MediaKind
  title: string
  season: number | null
  episode: number | null
  watchedAt: string
  poster: string
}

/**
 * What somebody's viewing adds up to.
 *
 * Computed from `plays` and the metadata stored alongside each row, so it
 * needs no catalog and no network — a stat page that could not be drawn
 * offline would be a strange thing to have.
 */
export interface ViewingStats {
  /** Every recorded viewing, including rewatches. */
  totalPlays: number
  /** Distinct titles, so a series binged for a month counts once. */
  totalTitles: number
  /**
   * Estimated hours, from each title's stored runtime.
   *
   * ESTIMATED is the honest word and the UI says so. A play records what was
   * watched and when, not for how long — somebody who stopped at 85% is
   * counted for the whole runtime, and a title whose metadata carries no
   * runtime at all contributes nothing. The alternative, storing a duration
   * per play, is a schema change for a number nobody reads to the minute.
   */
  estimatedHours: number
  /** How many plays fall in each of the last twelve months, oldest first. */
  byMonth: { month: string; plays: number }[]
  /** Most-watched genres, by play count, highest first. */
  topGenres: { genre: string; plays: number }[]
  /** Plays split by kind, for the three the catalog has. */
  byKind: { kind: MediaKind; plays: number }[]
  /**
   * Titles with something in them seen more than once, and how many times.
   *
   * Counted per EPISODE rather than per title: two different episodes of a
   * series are not a rewatch, and grouping by title alone would report every
   * show anybody has watched two of as "seen again". For a film the two are
   * the same thing.
   */
  mostPlayed: { contentId: string; title: string; plays: number }[]
}

/**
 * A named collection somebody made themselves.
 *
 * Distinct from My List, which is the watchlist the tracking services sync
 * against and which every profile has exactly one of. These are arbitrary —
 * "Rewatch with Dad", "Halloween", "Started and gave up" — and belong to
 * nobody but the person who made them.
 */
/** A named list somebody built in Trakt or Simkl. Read-only here: a
 *  named list has an author, and the first version of this feature
 *  should not be able to reorder or empty one. */
export interface RemoteList {
  /** Service-qualified — two services can both have a list called
   *  "Watchlist" and they are not the same list. */
  id: string
  service: 'simkl' | 'trakt'
  name: string
  description?: string
  items: RemoteListEntry[]
}

export interface RemoteListEntry {
  id: string
  type: MediaKind
  title: string
  year?: string
}

export interface CustomList {
  id: string
  name: string
  /** How many titles are in it, so the picker can say so without a second
   *  read per list. */
  count: number
  createdAt: string
}

export interface CustomListItem {
  contentId: string
  title: string
  poster: string
  type: MediaKind
  addedAt: string
}

export interface ContinueWatchingEntry extends CatalogItem {
  continueSeason: number
  continueEpisode: number
  watchedCount: number
  totalCount: number
  lastWatchedAt: string
}

export interface TrackingListResult {
  tracked: TrackedItemEnriched[]
  history: HistoryEntry[]
  /**
   * Which tracking services have each planned title on their own list,
   * keyed by media id.
   *
   * Sent with the list rather than fetched separately because every
   * surface that draws a planned title wants to tag it, and a second
   * round trip per card is not a thing to build. Absent ids are simply
   * local-only, which is the ordinary case for anything marked here.
   */
  plannedSources: Record<string, PlannedServiceId[]>
}

/** Services with both a login in this app and a personal list to read.
 *  Kitsu is deliberately absent: it is a public catalog here, with no
 *  account, so there is no list of yours to fetch. */
export type PlannedServiceId = 'simkl' | 'trakt' | 'mal'

/** What one service's watchlist pull did. Reported per service because
 *  the failure that matters is the quiet one: two lists arriving and a
 *  third erroring looks exactly like a short list unless somebody says. */
export interface PlannedServiceReport {
  service: PlannedServiceId
  connected: boolean
  pulled: number
  /** Entries dropped for want of an id this app could file them under —
   *  anime, in practice. Counted so the gap is visible. */
  unmapped: number
  error?: string
}

export interface PlannedSyncReport {
  at: number
  services: PlannedServiceReport[]
  added: number
  /** Titles removed locally because they left every service that had
   *  them — only ever titles this app pulled in itself. See
   *  docs/WATCHLIST-SYNC.md rule 2. */
  removed: number
}

export interface DislikedListResult {
  disliked: TrackedItem[]
}

/**
 * One shelf of suggestions that share a reason — "Because you watched
 * Dune", "With Zendaya", "More Sci-Fi" — see groupRecommendationRails in
 * catalog-logic.ts. What turns one row of guesses into something that can
 * be browsed: the same ranking, shelved by the evidence behind it.
 */
export interface RecommendationRail {
  /** `<kind>:<detail>`, stable across rebuilds — a React key and a rail id. */
  id: string
  reason: RecommendationReason
  /** Best-first, in the ranking's own order. */
  items: CatalogItem[]
}

export interface HomePersonalizedResult {
  tracked: TrackedItem[]
  updates: TrackedUpdate[]
  continueWatching: ContinueWatchingEntry[]
  recommendations: CatalogItem[]
  /**
   * Why each suggestion is there, by title id — see RecommendationReason.
   *
   * A sidecar map rather than a field on the items, so every existing
   * consumer of `recommendations` is untouched and the reasons stay out of
   * the shared, profile-blind catalog cache. Sparse on purpose: a title
   * that matched nothing in particular has no entry, and the card simply
   * shows no chip rather than one saying nothing.
   */
  recommendationReasons: Record<string, RecommendationReason>
  /**
   * The same ranking shelved by reason, for the For You page — drawn from
   * the whole stored buffer rather than the served row, which is what
   * gives the shelves depth. Empty until the background rebuild has
   * produced reasons to shelve by.
   */
  recommendationRails: RecommendationRail[]
  preferredGenres: string[]
  /**
   * Which tracking services have each planned title on their own list.
   *
   * Carried on the home feed because that is the payload the app already
   * derives its planned set from, so a card can be tagged without a
   * second round trip per title. Sparse: an id with no entry is planned
   * here and nowhere else, which is the ordinary case.
   */
  plannedSources: Record<string, PlannedServiceId[]>
}

/**
 * Payload of the recommendationsChanged push event. Deliberately just a
 * notification, not the list: every consumer of the Home feed already has
 * a refetch path (home:personalized), and shipping the rows through the
 * event as well would give two sources of truth for the same row.
 */
export interface RecommendationsChanged {
  /** When the stored list was rebuilt. */
  builtAt: number
  /** How many ranked titles were stored — the buffer, not the number shown. */
  count: number
}

export interface MarkWatchedResult {
  ok: true
  simklSynced: boolean
  simklError?: string
  malSynced: boolean
  malError?: string
}

/** A resume bookmark for one movie/episode — where playback left off last
 *  time, in seconds, plus the duration it was measured against (so a
 *  consumer can sanity-check the position still makes sense if the same
 *  title somehow resolves to a different-length source next time). */
export interface PlaybackPositionResult {
  positionSeconds: number
  durationSeconds: number | null
  /** Playback volume in use when the bookmark was written, as the same
   *  0-2 multiplier the player speaks (1 = the source's own level).
   *  Optional because only the single-bookmark read carries it: the
   *  episode grid's list read has no use for a volume and does not ask
   *  for one, and absent is the honest way to say that. */
  volume?: number | null
}

/** Every resume bookmark stored for one title, in one read — the
 *  per-episode equivalent of PlaybackPositionResult above. The detail
 *  page's episode grid needs the bookmark for EVERY episode it renders
 *  at once (to draw each tile's "N min left" sliver); asking
 *  tracking:get-position once per episode would be a season's worth of
 *  round-trips for what is a single indexed query on content_id. Movies
 *  come back with season/episode both null, exactly as they're stored. */
export interface EpisodePlaybackPosition extends PlaybackPositionResult {
  season: number | null
  episode: number | null
}

// ---------------------------------------------------------------------
// Watch-status reconciliation — movies only for now (see
// main/media-hub/tracking.ts's computeMovieDiscrepancies for why). The
// local database is the source of truth for what the app displays (see
// trackingList/homePersonalized), so this exists purely to catch and let
// someone resolve the rarer case where the local record and Simkl's own
// remote record genuinely disagree — a mark that never successfully
// pushed, a watch recorded from another device, or similar.
// ---------------------------------------------------------------------

export interface WatchStatusDiscrepancy {
  id: string
  type: MediaKind
  title: string
  poster: string
  year: string
  /** Whether EACH side currently considers this watched — always exactly
   *  one true and one false; a discrepancy where both agree is never
   *  surfaced in the first place. */
  localWatched: boolean
  remoteWatched: boolean
  /**
   * False when this row's id cannot be expressed to Simkl as a real id
   * (mockData's m-* demo ids, or anything else unmappable), which makes
   * "Use Local" structurally unable to stick: the push would go out as a
   * title/year guess whose outcome can neither be verified nor ever
   * satisfy the id-joined diff, so the row would return after every
   * resolution — seen live as three demo-id duplicates surviving five
   * days of clicks. The row is still shown, because "Use Simkl" resolves
   * it for real (it rewrites the LOCAL record — for a ghost duplicate,
   * deleting it), and hiding it would leave that corrupt row in history
   * forever with no way to clean it. Optional so older cached results
   * read as pushable, which was the previous behaviour.
   */
  pushable?: boolean
}

export interface ReconcileCheckResult {
  /** False when the cooldown window (see tracking.ts) skipped this check
   *  entirely — no Simkl request was made, `discrepancies` is always `[]`
   *  in that case and callers should treat it as "nothing new to show,"
   *  not "confirmed everything agrees." */
  ran: boolean
  discrepancies: WatchStatusDiscrepancy[]
}

export type ReconcileResolution = 'use-local' | 'use-remote' | 'ignore'

export interface ReconcileResolveResult {
  ok: true
  /** True when the decision was written to the pending-push queue rather
   *  than applied entirely locally — i.e. a "keep local" pick, whose push
   *  to the tracking services happens on the queue's own schedule (see
   *  main/media-hub/tracking.ts) and reports back over
   *  `trackingReconcileSync`, not in this reply. False for a "keep local"
   *  pick means the decision could NOT be recorded and nothing will
   *  happen on its own — the caller has to say so rather than let the
   *  choice disappear. */
  queued: boolean
}

/** One "keep local" decision waiting to be pushed out to every connected
 *  tracking service. Persisted rather than held in memory, so a decision
 *  outlives a failed push, being offline at the time, or the app being
 *  closed before the batch went out — the whole point being that a title
 *  someone has already ruled on never comes back to be ruled on again. */
export interface PendingWatchStatusPush {
  id: string
  type: MediaKind
  title: string
  year: string
  /** What the REMOTE side said when the decision was made. The local
   *  side is deliberately not snapshotted here: "keep local" is a ruling
   *  about which side wins, not a copy of a value, and the value can
   *  still change before a delayed or retried push goes out (queue a
   *  watched movie while offline, unmark it an hour later). The flush
   *  re-reads local history for the value to send, and uses this only to
   *  spot a disagreement that has since resolved itself. */
  remoteWatched: boolean
  /** Failed flush attempts so far — see PENDING_PUSH_MAX_ATTEMPTS. */
  attempts: number
}

/** Outcome of one flush of that queue, pushed to the renderer so a sync
 *  that silently didn't happen is something the person actually hears
 *  about instead of only finding out when the same titles reappear. */
export interface ReconcileSyncReport {
  /** Titles now confirmed on every connected service. */
  pushed: string[]
  /** Titles whose push failed this round and stay queued for a retry. */
  retrying: string[]
  /** Titles dropped after too many failed attempts — nothing retries these. */
  abandoned: string[]
  /** The most recent failure message, for the notification text. */
  error?: string
}

// ---------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------

/** Renderer-facing profile shape — never carries pinSalt/pinHash, only
 *  whether one is set (see main/media-hub/profiles.ts's ProfileRecord for
 *  the main-process-only shape that does carry those fields). */
export interface ProfilePublic {
  id: string
  name: string
  avatarInitial: string
  avatarTint: [string, string]
  isKid: boolean
  hasPin: boolean
}

export interface ProfilesListResult {
  profiles: ProfilePublic[]
  activeProfileId: string
}

export interface ProfileSetActiveResult {
  ok: true
  activeProfileId: string
}

export interface ProfileVerifyPinResult {
  ok: boolean
}

// ---------------------------------------------------------------------
// Settings / connection status
// ---------------------------------------------------------------------

/**
 * A filter combination somebody named and kept.
 *
 * `query` is the serialised search-param string the browse pages already use
 * for their filter state — so a saved view is applied by navigating to it,
 * and anything the filter bar learns to express is saveable for free with no
 * second schema to keep in step.
 */
export interface SavedFilter {
  id: string
  name: string
  /** Which browse page it belongs to. A runtime filter means nothing on the
   *  series page, so a saved view is only offered on the kind it was made on. */
  kind: MediaKind
  query: string
}

export interface Theme {
  id: string
  name: string
  description: string
}

export type UpdateChannel = 'stable' | 'preview'

export interface MediaHubPublicSettings {
  theme: string
  simklClientId: string
  subtitleLanguage: string
  /** Which audio track to play when a release carries more than one, and
   *  which releases to prefer when several exist. Separate from
   *  `subtitleLanguage` on purpose: "Japanese audio, English subtitles" is
   *  the normal way to watch anime, and a single combined setting couldn't
   *  express it. Defaults to English. */
  audioLanguage: string
  partySyncUrl: string
  /** Last display name used to host or join a Watch Party — remembered so it doesn't need retyping each time. */
  partyDisplayName: string
  updateChannel: UpdateChannel
  /** How far ahead the player keeps reading — see shared/media-hub/playbackBuffer.ts
   *  and mpv.ts's BUFFERING note. Not a pre-roll delay: playback starts
   *  immediately and the buffer fills behind it, including while paused. */
  playbackBuffer: string
  /** GPU scaling quality — see shared/media-hub/videoScaling.ts. */
  videoScaling: string
  /** On by default: fetches and applies an OpenSubtitles match (in
   *  `subtitleLanguage` below) automatically as soon as a title starts,
   *  same as picking the first OpenSubtitles search result manually would
   *  — see PlaybackOverlay.tsx's own "Always have subtitles" effect. */
  autoSubtitlesEnabled: boolean
  /** On by default: reaching the end of an episode offers the next one on a
   *  post-play card and starts it when the countdown runs out (see
   *  AUTOPLAY_NEXT_COUNTDOWN_SECONDS in shared/media-hub/player.ts). Movies
   *  and the last episode of a title have nothing to advance to and are
   *  unaffected either way. A party FOLLOWER never advances on its own
   *  whatever this says — the host owns what plays there. */
  autoplayNextEnabled: boolean
  /**
   * Named filter combinations, per browse page.
   *
   * Device-level rather than per-profile, deliberately, and sitting beside
   * hideWatchedDefault for the same reason: these describe how somebody likes
   * to BROWSE rather than what they have watched. Keeping them out of the
   * profile-scoped store also keeps them out of a boundary this codebase has
   * already had to get right in several places.
   */
  savedFilters: SavedFilter[]
  /** Whether a new episode of a tracked show raises a desktop notification.
   *  Off by default: an app that starts notifying because it was updated has
   *  made a decision that was not its to make. */
  notificationsEnabled: boolean
  /** Which country "where to watch" answers for, ISO 3166-1 alpha-2. Always a
   *  real value in the snapshot: an unset setting resolves to the machine's
   *  locale before it gets here, so the Settings pane shows what is in use
   *  rather than an empty field. */
  watchRegion: string
  /** Decorative UI animation (idle ambient motion, not playback itself) — layered alongside, not replacing, the automatic motion-suspend-during-playback behavior in global.css. */
  uiAnimationsEnabled: boolean
  /** Whether the Home dashboard's live CPU/GPU/RAM/network gauges (PerformanceWidget) are shown. Device/UI preference, not account data — survives logout like uiAnimationsEnabled. */
  performancePanelVisible: boolean
  /** Upper bounds used when choosing a release. Zero means unrestricted. */
  maxStreamResolution: number
  maxStreamSizeGb: number
  /** How much local disk the local rolling playback cache (streamCache.ts) may use — separate from maxStreamSizeGb above, which filters which releases get selected, not how they're cached once playing. Zero (an explicit choice) means unbounded/drive-limited (still subject to a free-space safety margin). Undefined means never configured — the backend's actual enforced default is 10GB (see playbackSession.ts's resolveStreamCacheMaxBytes), NOT unbounded, so this must stay undefined here rather than being coerced to 0 — the renderer falls back to the same 10 to display the true default. */
  streamCacheMaxGb?: number
  /** Folder the local rolling playback cache is stored under (e.g. a secondary drive) — undefined means the default app-data location. streamCache.ts always nests its own 'stream-cache' subfolder inside this. Changing it does not move already-cached data from the old location. */
  streamCacheDir?: string
  /** Last measured downstream speed. Informational; the test is only run on demand. */
  connectionSpeedMbps?: number
  /** Default state for the Movies/Series/Anime pages' "Hide Watched/Completed/Disliked" filters (see categoryFilters.ts) — a browse page starts from these unless the person has explicitly toggled that filter on this page before (see CategoryPage.tsx), and Home's Mood Browser / My Stuff apply them directly with no per-page override. Device/browsing preference, not account data — survives logout like uiAnimationsEnabled. */
  hideWatchedDefault: boolean
  hideCompletedDefault: boolean
  hideDislikedDefault: boolean
  /** Address of the local Ollama instance the AI features talk to, e.g.
   *  "http://127.0.0.1:11434" — '' when there is none. Not a credential: it
   *  is a machine on the person's own network, stored in plain text like
   *  partySyncUrl. See shared/media-hub/ollama.ts.
   *
   *  In the settings:get snapshot this is the address in USE, which is not
   *  always the one on disk: with nothing configured, an Ollama answering
   *  at the default address is picked up on its own (main/media-hub/
   *  ollamaService.ts's detectOllama), and the Settings pane has to show
   *  what is actually being asked rather than two empty fields. */
  ollamaBaseUrl: string
  /** Which installed model is being used, e.g. "llama3.2:3b". '' when there
   *  is none. Both this and ollamaBaseUrl must be set before anything in
   *  the app will call a model at all. Detected alongside the address, on
   *  the same terms. */
  ollamaModel: string
  /** Whether the app may still look for an Ollama at the default address on
   *  its own. False only after a deliberate Disconnect — pressing Connect
   *  turns it back on. The Settings pane says so, since an app that finds a
   *  local model by itself and then stops doing it owes an explanation. */
  ollamaAutoDetect: boolean
  /** How much a copy on the configured media server is worth relative to a
   *  TorBox one. See core.ts's LOCAL_SOURCE_BONUS for the sizing, and the
   *  Settings pane for the wording shown to the person. */
  sourcePreference: SourcePreference
  /** 'disk' keeps the rolling chunk cache on disk (the default). 'memory'
   *  holds it in RAM only and writes nothing about the media to disk at
   *  any point — for a fast connection, or where a file on the machine is
   *  the thing being avoided. */
  cacheMode: CacheMode
  /** Bound on the in-memory buffer, in MB. Only meaningful in memory mode. */
  memoryCacheMaxMb: number
  /**
   * Whether this install may keep MEDIA on the disk at all.
   *
   * false is a promise, not a preference: cacheMode is forced to memory
   * behind it (see preferences.ts effectiveCacheMode), so the disk stays
   * clean whatever the saved mode says. The app's own library, history and
   * settings are unaffected — this is about video, not about forgetting
   * what you watched.
   */
  storeMedia: boolean
  /** Whether watchlist changes travel both ways — see
   *  docs/WATCHLIST-SYNC.md. */
  watchlistTwoWay: boolean
}

export type CacheMode = 'disk' | 'memory'

/** Mirrors core.ts's SourcePreference. Declared here as well because the
 *  renderer must not import from main/. */
export type SourcePreference = 'prefer-local' | 'balanced' | 'prefer-quality'

export interface MediaHubSettingsSnapshot extends MediaHubPublicSettings {
  appVersion: string
  themes: Theme[]
  torboxConnected: boolean
  /** Whether a media server is configured, enabled, and has credentials.
   *  Playback is gated on having at least one of this and torboxConnected
   *  — either source alone is a complete setup. */
  mediaServerConnected: boolean
  tmdbConnected: boolean
  omdbConnected: boolean
  osConnected: boolean
  subdlConnected: boolean
  partySyncConnected: boolean
  /** Whether the bundled player binary was found (see mpv.ts's findMpv). Was
   *  `ffmpegAvailable` while playback depended on an ffmpeg transcode; ffmpeg
   *  is no longer involved in playing anything. */
  playerAvailable: boolean
  /** Both an address and a model are saved. The renderer gates every AI
   *  feature on this: with no model linked, the assistant says so instead
   *  of inventing an answer, and "Recommend Next ..." falls back to its own
   *  catalog pick rather than pretending a model chose it. */
  ollamaConnected: boolean
  /** Whether the storage question has ever been answered. False on a fresh
   *  install and nowhere else — this is what the first-run prompt keys on,
   *  which is why it is distinct from storeMedia being true or false. */
  storagePolicyChosen: boolean
  /** Whether the welcome flow (pick a name, connect a playback source) has
   *  been finished or skipped. False only on a fresh install: installs that
   *  predate the flow are grandfathered in via the storage answer, which
   *  every active install has necessarily given. Gates WelcomeSetup. */
  setupComplete: boolean
}

/** What a probe of an Ollama instance found — see main/media-hub/ollamaService.ts. */
export interface OllamaStatus {
  /** A model has been picked AND its server address is saved. Says nothing about whether that server is up right now — that's `reachable`. */
  connected: boolean
  baseUrl: string
  model: string
  /** Whether the probe just reached an Ollama instance at `baseUrl`. */
  reachable: boolean
  /** Model tags installed there. Empty when it could not be reached. */
  models: string[]
  /** Why the probe failed, in words worth showing someone. */
  error?: string
}

export interface OllamaAskResult {
  reply: string
  /** Titles the model suggested as worth trying next, in the order it gave
   *  them. Names only, and not necessarily titles this app has — the
   *  renderer looks each one up in the catalog and shows only the ones it
   *  can actually open (see resolveSimilarTitles). */
  similar?: string[]
  /** True when the request was abandoned before it finished (the panel was
   *  closed, or a newer question replaced it — see the ollamaCancel
   *  channel). `reply` is empty and the caller should ignore the whole
   *  result rather than treating it as a failed answer. */
  cancelled?: boolean
}

export interface OllamaRecommendResult {
  /** Catalog id of the title the model picked, or '' when it answered with something that wasn't on the list it was given. */
  id: string
  /** The model's own one-line justification, or '' if it didn't give one. */
  reason: string
  /** True when the request was abandoned before it finished — the panel that
   *  asked for it was unmounted. The caller must not act on the result: a
   *  recommendation ends by navigating, and navigating on behalf of a page
   *  the person has already left is worse than not answering. */
  cancelled?: boolean
  /** True when no model is connected, so no model was asked. Reported rather
   *  than thrown because this button has a non-AI fallback and needs to know
   *  to use it — and because the renderer can't decide this for itself while
   *  its settings snapshot is still loading. Distinct from an empty `id`,
   *  which means a model DID answer, just not with anything on the list. */
  unavailable?: boolean
}

export interface ConnectResult {
  ok: boolean
  message?: string
}

export interface TorBoxConnectResult extends ConnectResult {
  user?: Record<string, unknown>
}

export interface BootstrapResult {
  configured: boolean
  user?: Record<string, unknown>
  library?: Record<string, unknown>[]
  error?: string
}

export interface SimklStatus {
  connected: boolean
  clientId: string
  user?: Record<string, unknown>
  error?: string
}

export interface SimklPinStart {
  user_code: string
  verification_url?: string
  verification_uri?: string
  expires_in: number
  interval: number
  [key: string]: unknown
}

export interface SimklPollResult {
  connected: boolean
  user?: Record<string, unknown>
  pending?: boolean
  message?: string
}

export interface TraktStatusResult {
  connected: boolean
  /** Both halves of the app credential are saved. Sign-in is not offered
   *  until this is true, because the device flow needs the secret. */
  configured: boolean
  username?: string
}

export interface TraktStartResult {
  /** What the person types into trakt.tv. */
  userCode: string
  verificationUrl: string
  /** Seconds Trakt asks the app to wait between polls. */
  interval: number
  expiresIn: number
}

export interface TraktPollResult {
  state: 'pending' | 'connected' | 'expired' | 'denied' | 'error'
  message?: string
}

export interface MalStatus {
  connected: boolean
  clientId: string
  user?: Record<string, unknown>
  error?: string
}

export interface MalStartPayload {
  clientId: string
  clientSecret?: string
}

export interface MalReconcileToLocal {
  kitsuId: string
  title: string
  fromEpisode: number
  toEpisode: number
}

export interface MalReconcileToMal {
  kitsuId: string
  malId: number
  title: string
  watchedEpisodes: number
}

/** A MAL rating to pull in locally — targetId is the canonical grouped show
 *  id (see catalog.ts's resolveAnimeGroupTarget), not the raw kitsuId MAL's
 *  entry matched to, since a rating belongs to the whole show. */
export interface MalReconcileRatingToLocal {
  targetId: string
  title: string
  score: number
}

export interface MalReconcilePreview {
  toMal: MalReconcileToMal[]
  toLocal: MalReconcileToLocal[]
  ratingsToLocal: MalReconcileRatingToLocal[]
  unmatched: unknown[]
}

export interface MalReconcileApplyResult {
  toLocal: string[]
  toMal: number[]
  ratings: string[]
  errors: { kitsuId?: string; malId?: number; targetId?: string; error: string }[]
}

/** Which online subtitle service a SubtitleResult came from. The two are
 *  searched together and merged into one list (see subtitlesService.ts), so
 *  every result has to say where it came from — the download step differs
 *  per provider and cannot be inferred from the row's other fields. */
export type SubtitleProvider = 'opensubtitles' | 'subdl'

export interface SubtitleResult {
  id: string
  provider: SubtitleProvider
  /** OpenSubtitles only — the integer file id posted to its /download
   *  endpoint. 0 for SubDL results. */
  fileId: number
  /** SubDL only — the root-relative archive path (`/subtitle/<id>.zip`)
   *  resolved against dl.subdl.com at download time. '' for OpenSubtitles
   *  results. Validated as an SSRF boundary before use, since it makes the
   *  round trip through the renderer — see subdl.ts's
   *  resolveSubdlDownloadUrl. */
  downloadPath: string
  fileName: string
  language: string
  releaseName: string
  downloadCount: number
  uploader: string
  hearingImpaired: boolean
  /** True when this row was matched to the exact release being played, via
   *  the OpenSubtitles/moviehash algorithm — see main/media-hub/movieHash.ts
   *  — rather than to the title in general. Always false for SubDL, which
   *  has no hash-matching endpoint. A hash match is frame-accurate by
   *  construction: no manual delay nudging needed, because it is keyed to
   *  the same bytes on screen rather than to the title's IMDb id. */
  hashMatch: boolean
}

/** The provider-identifying subset of a SubtitleResult that the renderer
 *  hands back to subtitles:apply. Deliberately not the whole result: the
 *  main process only needs to know which service to ask and for what, and
 *  narrowing the payload keeps the rest of the row (display-only text) out
 *  of the trust boundary entirely. */
export type SubtitleSelection = Pick<SubtitleResult, 'provider' | 'fileId' | 'downloadPath'>

export interface SkipInterval {
  start: number
  end: number
}

/** Anime-only (see main/media-hub/aniskip.ts) — undefined fields mean no known skip window for that segment, not "unknown/loading". */
export interface SkipTimes {
  intro?: SkipInterval
  credits?: SkipInterval
}

/** Applying a subtitle is now a one-way operation: the .srt is written to the
 *  subtitle cache and handed to the player, which loads and selects it in
 *  place. The old shape carried a `vttDataUrl` for the renderer to mount on a
 *  <track> element, plus `url`/`engine`/`tracks` for the branch that restarted
 *  the ffmpeg transcode to burn subtitles in — neither exists anymore. */
export interface SubtitlesApplyResult {
  ok: true
  /** Ordinal of the newly added subtitle track, so the menu can mark it
   *  active without waiting for the track-list push to arrive. */
  ordinal: number
}

// ---------------------------------------------------------------------
// Watch Party
// ---------------------------------------------------------------------

export interface PartyMemberSummary {
  id: string
  name: string
  isHost: boolean
  /** Whether this member currently has a player open on the party's title.
   *  Being IN a party and WATCHING it are different things — someone can
   *  join and keep browsing, still be resolving their own stream, have had
   *  their resolve fail, or have closed the player and stayed for the chat.
   *  The synced-seek quorum has to wait only on members who can actually
   *  answer it; before this existed it waited on the whole roster, so any
   *  non-watching member stalled every seek until the 20s safety timeout
   *  fired. Undefined means "not reported yet" and is treated as watching,
   *  so a member on an older build is never silently excluded. */
  watching?: boolean
}

export interface PartyQueueEntry {
  queueId: string
  item: { id: string; type: string; title: string; poster?: string; year?: string }
  suggestedBy: string
  votes: Record<string, 1 | -1>
}

/** A short-lived message in the current watch room. Messages deliberately live
 *  with the room rather than the user profile: closing a room clears the
 *  conversation, and the relay carries the same encrypted envelope as the
 *  playback protocol. */
export interface PartyChatMessage {
  id: string
  senderId: string
  senderName: string
  text: string
  sentAt: number
}

export type PartyMode = 'direct' | 'relay'

/** What the watch party is currently watching, as carried on party-state
 *  broadcasts — enough to offer "Join the film" and name it, nothing more.
 *  The full replayable announcement (episode coordinates, position) stays
 *  host-side and is delivered as a real nowPlaying message. */
export interface PartyNowPlayingSummary {
  id: string
  type: string
  title: string
  poster?: string
}

export interface PartyHostResult {
  ok: true
  code: string
  port?: number
  wanAvailable?: boolean
  /** Whether the R3-Party-Sync relay attached — hosting opens every
   *  transport it can, so this reports what the single invite code covers
   *  rather than reflecting a chosen mode. */
  relayAttached?: boolean
}

export interface PartyStatusResult {
  inParty: boolean
  role?: 'host' | 'client'
  mode?: PartyMode
  members?: PartyMemberSummary[]
  selfId?: string
  selfName?: string
  hostName?: string
  /** Host-controlled: when true, every member's own play/pause/seek controls apply and sync to the group, not just the host's. */
  allowMemberControl?: boolean
  /** See PartyNowPlayingSummary; null when nothing is playing. */
  nowPlaying?: PartyNowPlayingSummary | null
}

export type PartyEventPayload =
  | {
      type: 'party-state'
      members: PartyMemberSummary[]
      allowMemberControl?: boolean
      nowPlaying?: PartyNowPlayingSummary | null
    }
  | { type: 'queue-sync'; queue: PartyQueueEntry[] }
  | { type: 'chat'; chat: PartyChatMessage }
  | { type: 'message'; from: string; message: unknown }
  | { type: 'host-disconnected' }
  | { type: 'play-request'; item: { id: string; type: string; title: string; poster?: string } }

/** Sent by the host the moment someone picks a title, BEFORE the host has
 *  resolved a stream for it.
 *
 *  `nowPlaying` can only be announced once the host's own resolve has
 *  finished, because that's when there's something real to announce — and
 *  resolving means a stream search plus a buffer wait, which is easily
 *  several seconds. For that whole window every other member's app sat
 *  completely inert with nothing to indicate anything was happening. This
 *  is the "we're starting something, hold on" signal that fills it.
 *
 *  A null `item` means "stop waiting" — the host's own resolve failed, so
 *  no nowPlaying is ever coming. Without it a failed host resolve would
 *  leave every follower showing a loading state forever. */
export interface PartyPreparingPayload {
  item: { id: string; type: string; title: string; poster?: string } | null
}

export interface PartyNowPlayingPayload {
  infoHash: string
  sources: string[]
  mediaId: string
  item: { id: string; type: string; title: string; poster?: string }
  season?: number
  episode?: number
  position: number
}

export type PartyPlaybackAction =
  | { type: 'play' | 'pause' }
  | { type: 'seek'; position: number }
  // Host heartbeat. `paused` makes it self-describing: without it a
  // follower cannot tell "the host is paused" from "the host went away",
  // and would keep extrapolating a position nobody is at. See
  // shared/media-hub/partySync.ts.
  | { type: 'position'; position: number; paused?: boolean }
  // Synced-seek protocol (host-only to send, like 'seek' above): host
  // announces a seek and holds everyone at paused-and-buffering instead
  // of playing immediately, so a slow connection doesn't watch alone
  // ahead of (or behind) everyone else.
  | { type: 'seek-sync'; position: number; requestId: string }
  // Client -> host (and, via the same relay, visible to every other
  // client too): "my own buffer for this seek is ready." The host is the
  // only one who actually acts on this (aggregating everyone's
  // readiness) — see PlaybackOverlay's checkPartySeekReady.
  | { type: 'ready'; requestId: string }
  // Presence, not control: any member may send it, like 'ready'. Announced
  // when a player mounts/unmounts so the host knows who the seek quorum can
  // legitimately wait on.
  | { type: 'watching'; watching: boolean }
  // Host -> everyone: UI-only status update naming who it's still
  // waiting on, so followers can render the same "waiting for X" banner
  // the host sees, not just a generic spinner.
  | { type: 'seek-waiting'; requestId: string; waitingIds: string[] }
  // Host -> everyone: released together (after a short fixed delay on
  // every peer, including the host, to give this message itself time to
  // actually arrive over the network before anyone starts playing).
  | { type: 'seek-go'; requestId: string }
  // Member -> host: "catch me up" — the hub's Join-the-film button for
  // someone who closed their player but stayed in the party. Answered with
  // the stored nowPlaying (see watchParty's handlePartyMessage); every
  // other member deduplicates the replay as already-playing.
  | { type: 'resync-request' }

export interface NetworkInfoResult {
  lanIp: string
  hostname: string
}

export interface ConnectionTestResult {
  speedMbps: number
  testedBytes: number
  recommendedResolution: number
  recommendedSizeGb: number
}

/** One mounted drive as the cache-disk probe saw it. */
export interface CacheDiskDrive {
  /** Filesystem root, e.g. 'C:\\' on Windows or '/' elsewhere. */
  root: string
  freeGb: number
  totalGb: number
  /** Whether the current stream-cache directory lives on this drive. */
  isCacheDrive: boolean
}

/** What the welcome flow's tuning step sizes the cache from — where the
 *  cache currently lives and how much room each drive actually has. */
export interface CacheDiskProbeResult {
  /** The effective cache root right now (the default app-data location
   *  when streamCacheDir is unset). */
  cacheDir: string
  drives: CacheDiskDrive[]
}

// ---------------------------------------------------------------------
// Auto-update
// ---------------------------------------------------------------------

export type UpdateState =
  'development' | 'checking' | 'available' | 'downloading' | 'ready' | 'current' | 'error'

export interface UpdateStatusPayload {
  state: UpdateState
  version?: string
  percent?: number
  message?: string
  /** What the OFFERED version changes, from the release body electron-updater
   *  already carries — so an update can be read about before it is installed.
   *  Absent on states that describe no particular version. */
  releaseNotes?: string
}

/** What the About card shows under the version. */
export interface ReleaseNotesResult {
  /** The running build's own note, or '' when it shipped without one (any
   *  build made outside the release workflow). */
  current: string
  version: string
}

export interface UpdateCheckResult {
  state: UpdateState
  version: string
}

/** What a friend is watching, shared only when they've opted in. */
export interface RoomActivity {
  mediaId: string
  kind: string
  title: string
  poster?: string
  /** Absolute position in seconds — lets the UI show "34 min in". */
  position: number
  /** The title's length in seconds, when the player knows it — what turns
   *  position into a percentage ("62% in"). Optional: an older build's
   *  announcements simply don't carry it, and the UI falls back to the
   *  absolute reading. */
  duration?: number
  paused: boolean
  /** Present when this member is joinable right now. Carried in the
   *  announcement so the UI can offer "join their party" without a round
   *  trip; absent means they're watching but not hosting anything. */
  partyCode?: string
}

/** One member of a room, as this device currently sees them. Soft state
 *  with a TTL — see rooms.ts, presence is announced, never authoritative. */
export interface RoomMemberPresence {
  friendId: string
  name: string
  activity: RoomActivity | null
}

/** One room as the renderer shows it. */
export interface RoomView {
  roomId: string
  name: string
  code: string
  /** Whether this room's relay socket is up right now. */
  connected: boolean
  /** Whether THIS device created the room. */
  isAdmin: boolean
  /** False for rooms that predate admins — the migrated friends group,
   *  and rooms joined by an old v2 code. Nothing hides that; the UI says
   *  the room has no admin rather than inventing one. */
  hasAdmin: boolean
  /** Per-room: whether this device publishes what it's watching here. */
  sharing: boolean
  /** Which path the room's socket took: straight to the relay, or
   *  through the household's cache server as the network's single
   *  connection for this room. */
  transport: 'relay' | 'cache-hop'
  members: RoomMemberPresence[]
}

export interface RoomsStatus {
  /** This install's stable identity, same in every room. */
  selfId: string
  rooms: RoomView[]
}

/** Direct messages between members, relayed through a room's channel.
 *  Addressed by `toFriendId` — the relay fans out to everyone, so the
 *  recipient filters. The wire `type` strings still say "friend": members
 *  on pre-rooms versions of the app are in the migrated room speaking
 *  this dialect, and renaming the wire would split the room into two
 *  populations that cannot see each other. */
export type RoomMessage =
  // "Let me watch with you." Sent to someone who is watching but has no
  // party open, since a solo watcher has no code to hand out until asked.
  | { type: 'friend-join-request'; fromFriendId: string; toFriendId: string; fromName: string }
  // The answer, carrying a party the requester can actually join.
  | { type: 'friend-join-offer'; fromFriendId: string; toFriendId: string; partyCode: string }
  // Politely declining — they stopped watching, or hosting failed.
  | { type: 'friend-join-declined'; fromFriendId: string; toFriendId: string; reason: string }

/** A peer message as delivered to the renderer: the room it arrived on
 *  rides along so the reply goes back through the same room. */
export interface RoomInboundMessage {
  roomId: string
  message: RoomMessage
}

/**
 * One piece of work the central scheduler is currently running — see
 * src/main/media-hub/taskScheduler.ts.
 */
export interface ActivityTask {
  label: string
  /** Which upstream's budget it is spending (kitsu, simkl, cinemeta, ...). */
  lane: string
  priority: 'interactive' | 'visible' | 'background' | 'maintenance'
  startedAt: number
}

/** One registered recurring job and when it is next due — see
 *  src/main/media-hub/backgroundJobs.ts. */
export interface ActivityJob {
  name: string
  label: string
  dueAt: number
  running: boolean
}

/**
 * Everything the work manager is doing, for the Downloads page's activity
 * panel. This is the answer to "why does the app feel busy right now",
 * which before this existed could only be got at by reading the source.
 */
export interface ActivitySnapshot {
  /** How loaded the app currently considers itself. `critical` means
   *  playback is running and background work is suspended. */
  pressure: 'idle' | 'busy' | 'critical'
  running: ActivityTask[]
  queued: number
  queuedByPriority: Record<'interactive' | 'visible' | 'background' | 'maintenance', number>
  jobs: ActivityJob[]
}

/**
 * A catalog:list response, and whether anything actually fetched it.
 *
 * `stale` is true when every live source failed and the rows came from an
 * EXPIRED cache entry instead (see main/media-hub/catalog.ts's fallback
 * chain). The rows are real and worth showing — that fallback exists so
 * a dead upstream doesn't empty the app — but nothing re-fetched them,
 * and a caller that cannot tell will present them as current: no offline
 * warning, and, for anything that dates what it stores, a renewal of rows
 * that could be arbitrarily old.
 */
export interface CatalogListing {
  items: CatalogItem[]
  stale: boolean
}

/** The browse grid's sort orders. Mirrors the renderer's own SortKey — the
 *  same six the sort dropdown offers — because the sort is now applied by
 *  SQL over catalog_index rather than in memory over a loaded array. */
export type CatalogSortKey =
  'trending' | 'title-asc' | 'year-desc' | 'rating-desc' | 'runtime-asc' | 'runtime-desc'

/**
 * One page of the browse grid, as a question for the database.
 *
 * Every field is the URL-facing value the category page already carries in
 * its query string (see the renderer's CategoryFilterState), so a filter
 * bar's state maps to one of these directly rather than through a
 * translation layer that could reinterpret it.
 *
 * Absent and null both mean "not filtering on this". A bucket value that no
 * longer exists means "matches nothing", NOT "no filter" — a stale bookmark
 * should show an empty grid rather than silently show everything.
 */
export interface CatalogQuery {
  kind: MediaKind
  genre?: string | null
  /** As a string, matching the URL. Compared against the stored year. */
  year?: string | null
  minRating?: number | null
  /** Bucket `value`s from shared/media-hub/catalogFilters. */
  runtimeBucket?: string | null
  seasonsBucket?: string | null
  episodeLengthBucket?: string | null
  episodesBucket?: string | null
  status?: string | null
  /**
   * The three watch-state exclusions, applied by the SAME query rather than
   * by the caller afterwards.
   *
   * This is not an optimisation. Filtering a returned page client-side makes
   * pages shrink unpredictably — ask for 30, render 22 — and makes `total` a
   * number that does not describe what the person is looking at. Both are
   * invisible while the whole catalog is in memory and immediately wrong
   * once it is paged.
   */
  hideWatched?: boolean
  hideCompleted?: boolean
  hideDisliked?: boolean
  sort?: CatalogSortKey
  offset?: number
  limit?: number
}

export interface CatalogQueryResult {
  items: CatalogItem[]
  /** How many titles match the filters in total, ignoring offset/limit.
   *  This is what the category hero should quote — the size of the result,
   *  not the size of the page that came back. */
  total: number
  /**
   * Which of `items` count as finished, resolved against watch history.
   *
   * Returned separately rather than set on the CatalogItems because a
   * CatalogItem describes a title and this describes one profile's
   * relationship to it — the same row is complete for one person and not for
   * another. `watched` and `disliked` are deliberately NOT here: the
   * renderer already holds those id sets globally, and only `completed`
   * needs a denominator (aired episodes) that lives in the database.
   */
  completedIds: string[]
}

/**
 * The values that actually occur in the library for one kind, for the filter
 * bar's dropdowns.
 *
 * Replaces deriving the option lists from whatever happened to be loaded.
 * That was the only thing available while the whole catalog lived in one
 * array, but it meant the genre list described the loaded slice rather than
 * the library — and the deeper the catalog got, the more the two diverged.
 */
export interface CatalogFacets {
  genres: string[]
  /** Newest first, matching the dropdown's own order. */
  years: number[]
  statuses: string[]
}

/** What one press of the deep-scan button did — see catalog:deepScan.
 *  Depth goes to the INDEX only; the candidate pool never grows. */
/** catalog:byIds' answer. completedIds rides along because index rows
 *  carry no episode data — completion is only derivable in SQL, and
 *  without it every id-fetched show would read as un-completed. */
export interface CatalogByIdsResult {
  items: CatalogItem[]
  completedIds: string[]
}

export interface DeepScanReport {
  kind: MediaKind
  /** Titles the scanned stretch returned, before dedup and skips. */
  scanned: number
  /** Titles the index had never seen and now holds. */
  added: number
  /** The kind's whole index after the chunk — the library's new size. */
  indexTotal: number
  /** Where the NEXT press will start reading. */
  offset: number
  /** The stretch came back entirely empty: the upstream catalog has no
   *  more to give, and the button should say so rather than invite
   *  another press at the void. */
  exhausted: boolean
}

/** Progress while a deep-scan chunk runs, pushed per page-group. */
export interface DeepScanEvent {
  kind: MediaKind
  pagesDone: number
  pagesTotal: number
  added: number
}
