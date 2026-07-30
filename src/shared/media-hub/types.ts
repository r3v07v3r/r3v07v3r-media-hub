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
  runtime: string
  genres: string[]
  videos: Episode[]
  trailers: Trailer[]
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
}

export interface PlaybackResult {
  ok: true
  player: 'embedded'
  tracks: MediaTracks
  url: string
  compatibility?: boolean
  engine?: string
  autoReason?: string
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
  partySyncUrl: string
  updateChannel: UpdateChannel
  /** How long to buffer ahead before playback starts — see shared/media-hub/playbackBuffer.ts. */
  playbackBuffer: string
  /** Decorative UI animation (idle ambient motion, not playback itself) — layered alongside, not replacing, the automatic motion-suspend-during-playback behavior in global.css. */
  uiAnimationsEnabled: boolean
}

export interface MediaHubSettingsSnapshot extends MediaHubPublicSettings {
  appVersion: string
  themes: Theme[]
  torboxConnected: boolean
  tmdbConnected: boolean
  osConnected: boolean
  partySyncConnected: boolean
  ffmpegAvailable: boolean
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

export interface SubtitleResult {
  id: string
  fileId: number
  fileName: string
  language: string
  releaseName: string
  downloadCount: number
  uploader: string
  hearingImpaired: boolean
}

export interface SubtitlesApplyResult {
  ok: true
  compatibility: boolean
  vttDataUrl?: string
  tracks?: MediaTracks
  url?: string
  engine?: string
}

// ---------------------------------------------------------------------
// Watch Party
// ---------------------------------------------------------------------

export interface PartyMemberSummary {
  id: string
  name: string
  isHost: boolean
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
}

export type PartyEventPayload =
  | { type: 'party-state'; members: PartyMemberSummary[] }
  | { type: 'queue-sync'; queue: PartyQueueEntry[] }
  | { type: 'message'; from: string; message: unknown }
  | { type: 'host-disconnected' }

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
  | { type: 'position'; position: number }

export interface NetworkInfoResult {
  lanIp: string
  hostname: string
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
