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

// TorBox `mylist` items matched against the cached catalogs by parsed
// release-name (see enrichTorBoxItem in core.ts).
export interface LibraryItem {
  id: string
  title: string
  type: 'library'
  mediaType: 'movie' | 'series'
  year: string
  season: number | null
  episode: number | null
  poster: string
  background: string
  description: string
  rating: string
  runtime: string
  genres: string[]
  metadataId: string
  raw: Record<string, unknown>
}

// A discovered stream candidate (from Meteor), after TorBox cache-checking
// and ranking merges in `cached`/`compatible`.
export interface StreamCandidate {
  infoHash: string
  name?: string
  title?: string
  sources?: string[]
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
export interface CacheSessionMeta {
  title: string
  posterUrl?: string
  catalogId?: string
  mediaKind?: 'movie' | 'series' | 'anime'
  seasonNumber?: number
  episodeNumber?: number
}

/** One entry in the Downloads page's "Cached Streams" list. */
export interface StreamCacheEntry extends CacheSessionMeta {
  token: string
  cachedBytes: number
  totalBytes: number | null
  isActive: boolean
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
}

export interface DislikedListResult {
  disliked: TrackedItem[]
}

export interface HomePersonalizedResult {
  tracked: TrackedItem[]
  updates: TrackedUpdate[]
  continueWatching: ContinueWatchingEntry[]
  recommendations: CatalogItem[]
  preferredGenres: string[]
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
}

export interface MediaHubSettingsSnapshot extends MediaHubPublicSettings {
  appVersion: string
  themes: Theme[]
  torboxConnected: boolean
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

export interface MalReconcilePreview {
  toMal: MalReconcileToMal[]
  toLocal: MalReconcileToLocal[]
  unmatched: unknown[]
}

export interface MalReconcileApplyResult {
  toLocal: string[]
  toMal: number[]
  errors: { kitsuId?: string; malId?: number; error: string }[]
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

export type PartyMode = 'direct' | 'relay'

export interface PartyHostResult {
  ok: true
  code: string
  port?: number
  wanAvailable?: boolean
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
}

export type PartyEventPayload =
  | { type: 'party-state'; members: PartyMemberSummary[]; allowMemberControl?: boolean }
  | { type: 'queue-sync'; queue: PartyQueueEntry[] }
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
}

export interface UpdateCheckResult {
  state: UpdateState
  version: string
}

/** What a friend is watching, shared only when they've opted in. */
export interface FriendActivity {
  mediaId: string
  kind: string
  title: string
  poster?: string
  /** Absolute position in seconds — lets the UI show "34 min in". */
  position: number
  paused: boolean
  /** Present when this friend is joinable right now. Carried in the
   *  announcement so the UI can offer "join their party" without a round
   *  trip; absent means they're watching but not hosting anything. */
  partyCode?: string
}

/** One member of a friends group, as this device currently sees them.
 *  Soft state with a TTL — see friends.ts, presence is announced, never
 *  authoritative. */
export interface FriendPresence {
  friendId: string
  name: string
  activity: FriendActivity | null
}

export interface FriendsStatus {
  inGroup: boolean
  code?: string
  selfId?: string
  /** Whether the persistent relay socket is up right now. */
  connected?: boolean
  /** This device's own opt-in for publishing what it's watching. */
  sharing: boolean
  friends: FriendPresence[]
}

/** Direct messages between friends, relayed through the group channel.
 *  Addressed by `toFriendId` — the relay fans out to everyone, so the
 *  recipient filters. There is nothing secret in them beyond what the
 *  group secret already protects. */
export type FriendMessage =
  // "Let me watch with you." Sent to someone who is watching but has no
  // party open, since a solo watcher has no code to hand out until asked.
  | { type: 'friend-join-request'; fromFriendId: string; toFriendId: string; fromName: string }
  // The answer, carrying a party the requester can actually join.
  | { type: 'friend-join-offer'; fromFriendId: string; toFriendId: string; partyCode: string }
  // Politely declining — they stopped watching, or hosting failed.
  | { type: 'friend-join-declined'; fromFriendId: string; toFriendId: string; reason: string }
