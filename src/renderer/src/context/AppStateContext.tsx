'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  AppNotification,
  AssistantState,
  ContinueWatchingItem,
  MediaItem,
  Recommendation,
  UIActivityState
} from '@renderer/types'
import { USER_PROFILES } from '@renderer/data/mockData'
import type {
  CatalogItem,
  MediaHubSettingsSnapshot,
  OllamaAskResult,
  MediaKind,
  MediaTracks,
  PartyHostResult,
  PartyChatMessage,
  PartyQueueEntry,
  PartyStatusResult,
  PlaybackResult,
  ProfilePublic,
  ReconcileResolution,
  WatchStatusDiscrepancy
} from '@shared/media-hub/types'
import {
  mediaItemToTrackablePayload,
  catalogItemToMediaItem,
  catalogItemToTitleRef,
  indexHistoryById
} from '@renderer/lib/mediaHub/adapters'
import {
  PlaybackPreparationCancelledError,
  playbackPreparationErrorMessage,
  runPlaybackPreparationStage,
  type PlaybackPreparationStage
} from '@renderer/lib/mediaHub/playbackPreparation'
import { forgetContinueWatching, rememberTrackedId } from '@renderer/lib/mediaHub/startupSnapshot'
import {
  startupContinueWatchingFallback,
  startupTrackedIdsFallback,
  useMediaHubBrowseCatalog,
  useMediaHubDislikedIds,
  useMediaHubRatings,
  useMediaHubHomeFeed,
  useMediaHubWatchedIds,
  type CatalogKindState
} from '@renderer/lib/mediaHub/hooks'
import type { CategoryKind } from '@renderer/lib/mediaHub/categoryFilters'
import { MAX_PROMPT_TITLES } from '@shared/media-hub/ollama'
import { episodeToStart, episodeWatchKey } from '@shared/media-hub/nextEpisode'
import {
  isNoticeablyBelowCeiling,
  resolutionLabel,
  streamResolution
} from '@shared/media-hub/streamQuality'
import { mediaItemToTitleRef } from '@renderer/lib/mediaHub/adapters'
import {
  recentlyWatchedRefs,
  relatedToItem,
  resolveSimilarTitles,
  searchAppCatalog
} from '@renderer/lib/mediaHub/assistantSearch'
import { buildMediaId } from '@renderer/lib/mediaHub/streamId'
import {
  captureBrowsingOrigin,
  deriveBrowsingLabel,
  isDetailRoute,
  type BrowsingOrigin
} from '@renderer/lib/mediaHub/browsingContext'
import { useOverlayActions } from '@renderer/context/OverlayContext'
import type { PlannedServiceId } from '@shared/media-hub/types'

/** How many steps back the contextual trail remembers. A drill-down chain
 *  this long is already pathological (each step is a title opened from
 *  another title's page); the cap exists so the trail cannot grow without
 *  bound, not because anyone is expected to reach it. Oldest entries drop
 *  first, so the most recent steps — the ones anyone actually presses Back
 *  through — always survive. */
const MAX_TRAIL = 20

/** movie/series/anime -> the route each one's detail page lives at — the
 *  same plural/singular forms App.tsx's own /movies, /series, /anime
 *  category routes already use. */
function mediaKindToDetailPath(media: MediaItem): string {
  // Same fallback PlaybackOverlay.tsx's own `kind` derivation uses:
  // mediaKind is real backend data (undefined for some mock items), and
  // MediaType has no 'anime' member at all (see adapters.ts's toMediaType)
  // so a plain mediaType check can only ever tell movie from everything
  // else.
  const kind = media.mediaKind ?? (media.mediaType === 'series' ? 'series' : 'movie')
  const segment = kind === 'movie' ? 'movies' : kind
  return `/${segment}/${media.id}`
}

/** Only used when window.api.mediaHub is unavailable (e.g. rendered outside
 *  Electron) — real profile data comes from main/media-hub/profiles.ts via
 *  refreshProfiles below, matching every other "real backend, mock
 *  fallback" pattern already used in this file (catalog, home feed, ...). */
const FALLBACK_PROFILES: ProfilePublic[] = USER_PROFILES.map((p) => ({
  id: p.id,
  name: p.name,
  avatarInitial: p.avatarInitial,
  avatarTint: p.avatarTint,
  isKid: Boolean(p.isKid),
  hasPin: false
}))

interface AppStateValue {
  // Profiles — real backend-persisted data (main/media-hub/profiles.ts).
  profiles: ProfilePublic[]
  activeProfileId: string
  /** Non-null while a PIN-locked profile is awaiting its PIN — render a prompt keyed on this. */
  profilePinPrompt: ProfilePublic | null
  switchProfile: (id: string, pin?: string) => void
  cancelProfilePinPrompt: () => void
  createProfile: (payload: { name: string; isKid?: boolean; pin?: string }) => Promise<void>
  updateProfile: (payload: {
    id: string
    name?: string
    isKid?: boolean
    pin?: string | null
  }) => Promise<void>
  deleteProfile: (id: string) => Promise<void>

  // Watch Party — one shared slice so the topbar button/panel and the
  // Settings card can never disagree about whether we're in a party (see
  // main/media-hub/watchParty.ts for the real backend this is wired to).
  partyStatus: PartyStatusResult | null
  partyQueue: PartyQueueEntry[]
  /** Ephemeral, encrypted room conversation. Cleared when the room ends. */
  partyChat: PartyChatMessage[]
  /** Only known right after hosting (party:host's own response — party:status never returns it) — cleared on leave. */
  partyHostCode: string | null
  /** Whether hosting's own best-effort UPnP router port-mapping succeeded
   *  (see watchParty.ts's attemptPortMapping) — null before/after hosting,
   *  never re-derivable from party:status. false means the party code is
   *  only reachable by someone on this same network; UPnP genuinely fails
   *  on a lot of real routers (disabled, unsupported, or the ISP uses
   *  CGNAT), so this is disclosed rather than silently discovered only
   *  when a remote join times out. */
  partyWanAvailable: boolean | null
  /** The local port the party server is actually listening on — surfaced
   *  alongside partyWanAvailable so a host who wants to try manual router
   *  port-forwarding instead has the number they'd need. */
  partyHostPort: number | null
  partyPanelOpen: boolean
  setPartyPanelOpen: Dispatch<SetStateAction<boolean>>
  refreshPartyStatus: () => void
  hostParty: (name: string) => Promise<PartyHostResult>
  joinParty: (code: string, name: string) => Promise<void>
  leaveParty: () => Promise<void>
  suggestToParty: (item: {
    id: string
    type?: string
    title?: string
    poster?: string
    year?: string
  }) => Promise<void>
  voteQueue: (queueId: string, direction: 1 | -1) => Promise<void>
  removeFromQueue: (queueId: string) => Promise<void>
  sendPartyChat: (text: string) => Promise<void>

  // My List — a Set of media ids. Kept centrally so the hero, the
  // carousel, continue-watching, and the detail modal all agree on
  // whether something is saved. Backed by the media-hub backend's local
  // tracking store (tracking:toggle) when window.api.mediaHub is
  // available — see the media-hub feed effect below — with an
  // optimistic local update on toggle so the UI doesn't wait on the IPC
  // round trip.
  myList: Set<string>
  toggleMyList: (media: MediaItem) => void
  /**
   * Which tracking services have each planned title on their own list.
   *
   * Read straight off the home feed rather than kept as state: nothing in
   * the app edits it, so a copy here would only be somewhere for it to go
   * stale. Sparse — an id with no entry is planned here and nowhere else,
   * which is what everything marked in this app looks like.
   */
  plannedSources: Record<string, PlannedServiceId[]>

  // "Not interested" — mirrors myList's shape/optimistic-update pattern
  // exactly, backed by the media-hub backend's local disliked store
  // (disliked:add/remove) instead of tracking:toggle. Drives
  // MediaItem.disliked (see adapters.ts) and the Hide Disliked filter.
  dislikedIds: Set<string>
  /** What the active profile has scored each title, 1-10, keyed by content id.
   *  Absent means unrated — see shared/media-hub/rating.ts on why that is not
   *  the same as a low score. */
  ratings: Map<string, number>
  /** Records a score, or clears it with 0. `media` is optional and only used
   *  to push the score onward to Trakt, which files movies and shows
   *  separately and cannot tell them apart from an IMDb id. */
  rateMedia: (
    id: string,
    score: number,
    media?: { type: MediaKind; title: string }
  ) => Promise<void>
  /**
   * Identifies the library currently on screen — the active profile, plus a
   * counter that moves whenever the rows underneath it are replaced wholesale.
   *
   * Anything reading profile-scoped data through IPC should depend on this
   * rather than on the profile id: restoring a backup replaces every row while
   * usually leaving the id untouched.
   */
  libraryKey: string
  /** Call after replacing the library wholesale (a restore), so every view
   *  derived from it re-reads. */
  reloadLibrary: () => void
  /** Re-reads the profile list. Needed after a restore as well as after a
   *  create/delete: a backup from another machine carries that machine's
   *  profile ids, and they are merged into settings by the import. */
  refreshProfiles: () => void
  toggleDisliked: (media: MediaItem) => void

  // Continue Watching — seeded from the media-hub backend's
  // home:personalized (episode-level watch tracking, not a mock array —
  // see hooks.ts's useMediaHubHomeFeed) when available, else the row this
  // app last really showed (startupSnapshot.ts), so a relaunch resumes on
  // what you were actually watching instead of a demo placeholder.
  // "mark watched/unwatched" and "remove from row" write through to the
  // real tracking:mark-watched/tracking:toggle handlers (best-effort —
  // local state updates immediately either way).
  continueWatching: ContinueWatchingItem[]
  /** `media` is required for anything not currently sitting in the
   *  Continue Watching row (a fully-watched title, or one never started)
   *  — see markContinueWatching's own implementation comment for why. */
  markContinueWatching: (id: string, watched: boolean, media?: MediaItem) => void
  removeContinueWatching: (id: string) => void

  // Watch-status reconciliation — see tracking.ts's own header comment.
  // Movies only, surfaced a few seconds after startup when the local and
  // Simkl records disagree; never auto-applied in either direction.
  syncDiscrepancies: WatchStatusDiscrepancy[]
  syncReviewOpen: boolean
  setSyncReviewOpen: Dispatch<SetStateAction<boolean>>
  /** The control centre — the settings/system surface that folds down from
   *  the top bar (see components/controlcentre/ControlCentre.tsx). Global
   *  rather than local to the top bar because two other things open it: the
   *  sidebar's Settings entry, and the /settings route, which exists now
   *  only to deep-link into this. */
  controlCentreOpen: boolean
  setControlCentreOpen: Dispatch<SetStateAction<boolean>>
  resolveSyncDiscrepancy: (
    discrepancy: WatchStatusDiscrepancy,
    resolution: ReconcileResolution
  ) => void

  // The flat "browse everything" pool (movies + series + anime, real
  // catalog:list data when available, the previous session's remembered
  // catalog otherwise — see hooks.ts's useMediaHubBrowseCatalog) — shared here so
  // MoodBrowser/My Stuff/the AI-recommend actions all fetch it once
  // instead of each mounting their own copy of the hook.
  catalog: MediaItem[]
  catalogLoading: boolean
  /** True once at least one catalog kind has returned real rows this run
   *  — false means `catalog` is entirely remembered from the previous
   *  session (bridge missing, still loading, or every kind's fetch
   *  failed). Not a promise that every item is fresh: a kind that is
   *  still loading contributes its remembered rows. See hooks.ts. */
  /** Per-kind catalog availability — see hooks.ts's CatalogKindState.
   *  There is deliberately no global "the catalog is live" flag: the
   *  three kinds are fetched independently, so one would hide a failed
   *  kind behind a successful one. Ask about the kind you are showing. */
  catalogKindStates: Record<MediaKind, CatalogKindState>
  refreshCatalog: () => void
  /** Adapts backend CatalogItems with this context's own watch/list/
   *  dislike state — see the useCallback of the same name. Pages that
   *  fetch their own rows (catalog:query) MUST use this rather than
   *  calling the adapter bare, or their badges drift from the app's. */
  adaptCatalogItems: (items: CatalogItem[], completedIds?: string[]) => MediaItem[]
  /** Ids with any watched history — exposed for the id-matching
   *  surfaces (My Stuff's Watched tab) that fetch rows from the index
   *  by id since stage 4 instead of scanning a loaded array for its
   *  baked-in flags. */
  watchedIds: Set<string>

  // home:personalized's recommendations/featured pool (see
  // useMediaHubHomeFeed) — `homeFeedLive` tells a consumer whether these
  // are real or should fall back to its own mock data, since (unlike
  // `catalog` above) there's no mock blended in here.
  recommendations: Recommendation[]
  featured: MediaItem[]
  homeFeedLive: boolean
  /** The home:personalized fetch is still out. Distinct from
   *  `homeFeedLive`, which stays false for a remembered-but-not-yet-
   *  refetched feed — a consumer with nothing to show needs to know
   *  whether to render a loading placeholder or an honest empty state,
   *  and those are two different questions. */
  homeFeedLoading: boolean
  /** The last home:personalized attempt threw — see hooks.ts's
   *  HomeFeedResult.error for why an empty feed alone can't be read as
   *  "nothing to recommend yet". */
  homeFeedError: boolean
  /** Retries home:personalized. */
  refreshHomeFeed: () => void

  // Snapshot of the media-hub backend's settings (torboxConnected,
  // simklClientId, theme, ...) — read by the playback gate below and by
  // the Settings page's TorBox/Simkl/MAL/... sections. `null` until the
  // first fetch resolves (or forever, if window.api.mediaHub is absent).
  mediaHubSettings: MediaHubSettingsSnapshot | null
  refreshMediaHubSettings: () => void

  // Global AI assistant state machine, shared between the top-bar search
  // field and the compact assistant panel so only one "listens" at a
  // time.
  assistantState: AssistantState
  setAssistantState: (s: AssistantState) => void
  assistantQuery: string
  setAssistantQuery: (q: string) => void
  assistantResponse: string | null
  /** What the app's OWN catalog search found for the current question —
   *  real, openable titles, filled in before the model has said anything
   *  and shown whether or not one is connected. This is the answer to
   *  "which film is that": the model's prose is commentary on top of it. */
  assistantResults: MediaItem[]
  /** Titles the model suggested next, each one looked up in the catalog so
   *  it can actually be opened. Falls back to the first result's own
   *  related titles when the model named nothing this app has. */
  assistantSimilar: MediaItem[]
  /** Which of those two things assistantSimilar actually is. The row says
   *  so out loud, in the same spirit as the Recommend Next buttons
   *  labelling a random pick as random — "the model suggested these" and
   *  "these are related to the first result" are different claims, and
   *  only one of them is about you. */
  assistantSimilarSource: 'model' | 'catalog' | null
  /** The catalog search is still out. Distinct from assistantState
   *  'processing', which covers the model — the results row and the prose
   *  arrive separately and each shows its own waiting state. */
  assistantSearching: boolean
  runAssistantQuery: (query: string) => void
  closeAssistant: () => void

  // The top-bar search field's category-page mode (see topbar/
  // AIAssistantInput.tsx, which is route-aware): when the current route is
  // /movies, /series, or /anime, typing + Enter calls catalog:search(kind,
  // query) — a real backend search (main/media-hub/catalog.ts's
  // catalogSearch handler, Simkl for movies/series, Kitsu for anime) —
  // instead of the fake assistant response Home's search still uses.
  // `kind` doubles as "is a category search currently active" — a
  // CategoryPage only renders the search-results view when this matches
  // its own kind, so navigating away from the page that started the
  // search implicitly stops that search from affecting anything.
  categorySearch: {
    kind: CategoryKind | null
    query: string
    results: MediaItem[]
    loading: boolean
    error: boolean
  }
  runCategorySearch: (kind: CategoryKind, query: string) => void
  clearCategorySearch: () => void

  // Toasts
  pushNotification: (n: Omit<AppNotification, 'id' | 'createdAt'>) => void
  dismissNotification: (id: string) => void

  // "Opening a title" navigates to its real detail page (/movies/:id,
  // /series/:id, /anime/:id) rather than opening a modal over the current
  // page — openDetail captures a BrowsingOrigin snapshot of wherever it
  // was called from (current route+filters, scroll position, focused
  // card, any visible rail's scroll position) before navigating, so the
  // detail page's contextual back control can return to exactly that
  // spot. See lib/mediaHub/browsingContext.ts and
  // lib/mediaHub/useRestoreBrowsingOrigin.ts (the page-side half of this).
  //
  // Those snapshots form a TRAIL, not a single slot, because a title page
  // can open another title page (Rest of the series, Similar, Story) — so
  // "where Back goes" is a stack that unwinds one step per press, and
  // popBrowsingOrigin is how a page takes that step.
  /** The top of the trail — where a Back press goes next, and the title it
   *  is labelled with. Null once the chain is fully unwound. */
  browsingOrigin: BrowsingOrigin | null
  /** `originLabelOverride`: only needed when opening a title from within
   *  another detail page — see the implementation's own comment. */
  openDetail: (media: MediaItem, originLabelOverride?: string) => void
  /** Opens what else this catalog has of one person's — see routes/PersonPage.
   *  A drill-down from a title page, not a nav destination. */
  openPerson: (name: string) => void
  /** Steps one level back out, returning where to navigate to (null when
   *  there is nowhere left, so the caller can fall back to its category
   *  page). Also parks that entry as `pendingRestore` for the destination. */
  popBrowsingOrigin: () => BrowsingOrigin | null
  /** What the last Back press stepped out of, for the page it landed on to
   *  restore its scroll/rail/focus from. Consumed once, then cleared. */
  pendingRestore: BrowsingOrigin | null
  clearPendingRestore: () => void

  // Resolving a stream (stream:resolve, "searching" for a cached source)
  // and starting it (stream:play, "buffering" — spinning up the proxy or
  // ffmpeg transcode session) both take a real network round trip.
  // Previously PlaybackOverlay opened immediately on click and did this
  // work itself, showing a mostly-blank full-screen takeover the whole
  // time (and, on a no-source/error outcome, staying open just to show
  // that one line of text) — now startPlayback does the resolving here,
  // BEFORE the overlay ever mounts, so any Play button can show its own
  // inline "Searching…"/"Buffering…" state instead, and a failure never
  // opens anything at all (just a notification, staying on whatever page
  // the person was already looking at). `resolvingMedia` is a single
  // shared slot (only one title can be starting at a time) — a Play
  // button anywhere in the app compares its own media.id against it to
  // know whether IT is the one currently loading.
  // `detail` is main's live narration of whatever the current stage is
  // actually doing right now (see PlaybackPrepareProgress) — the stage
  // labels alone can't say "downloading 2.4 MB of 4 MB" or "converting
  // TRUEHD audio", and the buffering stage in particular can legitimately
  // run for a minute or more, which without this reads as a hang.
  resolvingMedia: {
    id: string
    title: string
    stage: PlaybackPreparationStage
    detail?: string
  } | null
  cancelPlaybackPreparation: () => void
  playbackMedia: MediaItem | null
  playbackResult: PlaybackResult | null
  playbackTracks: MediaTracks | null
  // Dispatch<SetStateAction<T>>, not a plain setter — PlaybackOverlay's
  // seek/track-selection restart logic (selectTrack/handleSeek) updates
  // these via the functional-updater form (`setResult(prev => ...)`),
  // which only a real useState dispatch (passed straight through here)
  // supports.
  setPlaybackResult: Dispatch<SetStateAction<PlaybackResult | null>>
  setPlaybackTracks: Dispatch<SetStateAction<MediaTracks | null>>
  startPlayback: (media: MediaItem) => Promise<boolean>
  /** `watched` deletes this title's local stream cache outright on close instead of leaving it for the idle sweep — see PlaybackOverlay's markedWatchedRef, which is the only thing that should ever pass true. */
  stopPlayback: (watched?: boolean) => void
  /** Re-fetches both watch-status sources (tracking:list's history and home:personalized's continueWatching) — call after anything changes what tracking:list reports for an id, so grids/badges/Continue Watching/next-episode don't go stale until some unrelated refetch happens to pick it up. Same pair markContinueWatching below already refreshes after a manual toggle. */
  refreshWatchStatus: () => void
  /** Bumped every time refreshWatchStatus() runs — MediaDetailPage keeps its own separate per-episode `history` fetch (tracking:list scoped to just the current id, for its watchedKeys/nextEpisode computation) and has no other way to know a mark-watched happened elsewhere, e.g. PlaybackOverlay's 80%-progress auto-mark. Depend on this in any effect that needs to re-fetch when watch status changes anywhere in the app. */
  watchStatusVersion: number
  /** Same as startPlayback, but (host only) also announces the title to the party so followers resolve their own stream of it. */
  startPartyPlayback: (
    media: MediaItem,
    opts?: { season?: number; episode?: number }
  ) => Promise<void>
  /** Follower-only: the title the host is currently getting ready, from the moment they pick it until this member's own stream actually starts. Null when nothing is pending. Drives PartyLoadingOverlay. */
  partyPreparing: { title: string; poster: string } | null
  /** Absolute position (seconds) a follower should seek to once their own independently-resolved stream is ready — set from an incoming `nowPlaying` announcement, consumed once by PlaybackOverlay. */
  partyPendingSeek: number | null
  consumePartyPendingSeek: () => void
  /** Host-only, broadcast to every member: unlocks everyone's own play/pause/seek controls instead of just the host's. */
  setPartyMemberControl: (allow: boolean) => Promise<void>
  /** Any member can call this to start a suggested queue item playing for the whole party — the host resolves and starts it (directly if this device IS the host, otherwise by asking the host over the party channel). */
  requestPartyPlay: (item: {
    id: string
    type: string
    title: string
    poster?: string
  }) => Promise<void>

  openContextMenu: (x: number, y: number, media: MediaItem) => void
  closeContextMenu: () => void

  activeMood: string | null
  setActiveMood: (moodId: string | null) => void
  combinedMoods: string[]
  toggleCombinedMood: (moodId: string) => void

  // Single global "what is the system doing" signal for the motion
  // system — derived from assistantState/playback rather than tracked
  // separately, so nothing can drift out of sync with the state it's
  // supposed to reflect. Components read this instead of inventing their
  // own idle/active interpretation.
  uiActivity: UIActivityState
}

// Generous on purpose: this is not "how long a load should take", it's
// the point past which a follower is certainly waiting on a host that is
// never going to answer. A cold stream search plus a buffer wait can
// legitimately run well over a minute on a slow link, and cutting the
// card off early would be worse than leaving it a while — it would look
// like the party had started without them.
const PARTY_PREPARING_TIMEOUT_MS = 3 * 60 * 1000

/** Structural equality for the small, flat IPC payloads this file holds in
 *  state (party status, party queue). Deliberately not a deep-equality
 *  library: these are plain JSON round-tripped across the process
 *  boundary, so key order is stable and a stringify comparison is both
 *  correct and cheaper than the re-render it prevents. */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

const AppStateContext = createContext<AppStateValue | null>(null)

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  // Safe to call here: App.tsx nests <AppStateProvider> inside <HashRouter>,
  // so this provider always renders within a Router context.
  const location = useLocation()
  const navigate = useNavigate()
  const [profiles, setProfiles] = useState<ProfilePublic[]>(FALLBACK_PROFILES)
  const [activeProfileId, setActiveProfileIdState] = useState(FALLBACK_PROFILES[0].id)
  const [profilePinPrompt, setProfilePinPrompt] = useState<ProfilePublic | null>(null)
  const [partyStatus, setPartyStatus] = useState<PartyStatusResult | null>(null)
  const [partyQueue, setPartyQueue] = useState<PartyQueueEntry[]>([])
  const [partyChat, setPartyChat] = useState<PartyChatMessage[]>([])
  const [partyHostCode, setPartyHostCode] = useState<string | null>(null)
  const [partyWanAvailable, setPartyWanAvailable] = useState<boolean | null>(null)
  const [partyHostPort, setPartyHostPort] = useState<number | null>(null)
  const [partyPanelOpen, setPartyPanelOpen] = useState(false)
  const [partyPendingSeek, setPartyPendingSeek] = useState<number | null>(null)
  const [partyPreparing, setPartyPreparing] = useState<{ title: string; poster: string } | null>(
    null
  )
  // Seeded from the remembered set, not empty — see startupHomeFeedFallback
  // in hooks.ts. An empty My List alongside remembered titles is not a
  // neutral starting point: it renders saved titles as unsaved, and the
  // Add control it produces calls a toggle that removes them.
  const [myList, setMyList] = useState<Set<string>>(startupTrackedIdsFallback)
  const [dislikedIds, setDislikedIds] = useState<Set<string>>(new Set())
  // Seeded from the same remembered feed useMediaHubHomeFeed falls back
  // to, so the row this component owns and the row that hook reports
  // agree from the first frame rather than the panel showing demo titles
  // until home:personalized answers. See hooks.ts.
  const [continueWatching, setContinueWatching] = useState<ContinueWatchingItem[]>(
    startupContinueWatchingFallback
  )
  // Bumped by reloadLibrary below. Part of the key rather than a separate
  // dependency so there is one value to pass around and one thing to get
  // wrong — see the note above useMediaHubWatchedIds.
  const [libraryEpoch, setLibraryEpoch] = useState(0)
  const libraryKey = `${activeProfileId}:${libraryEpoch}`
  const reloadLibrary = useCallback(() => setLibraryEpoch((n) => n + 1), [])

  const homeFeed = useMediaHubHomeFeed(libraryKey)
  const watchedIdsResult = useMediaHubWatchedIds(libraryKey)
  const dislikedIdsResult = useMediaHubDislikedIds(libraryKey)
  const ratingsResult = useMediaHubRatings(libraryKey)
  const browseCatalog = useMediaHubBrowseCatalog(
    myList,
    watchedIdsResult.watchedIds,
    watchedIdsResult.history,
    dislikedIds,
    // Whether those two sets are answers yet or just their initial
    // emptiness — see WatchedIdsResult.loaded. Only the remembered rows
    // care, and only so an unread set can't wipe a badge they already had.
    { watched: watchedIdsResult.loaded, disliked: dislikedIdsResult.loaded }
  )

  // Reseeds local optimistic state whenever a fresh disliked:list fetch
  // resolves (initial load, or a manual dislikedIdsResult.refresh()) — same
  // "backend snapshot resets local optimistic edits" tradeoff myList/
  // homeFeed above already accepts, not treated differently here.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDislikedIds(dislikedIdsResult.dislikedIds)
  }, [dislikedIdsResult.dislikedIds])
  const [mediaHubSettings, setMediaHubSettings] = useState<MediaHubSettingsSnapshot | null>(null)
  const [assistantState, setAssistantState] = useState<AssistantState>('idle')
  const [assistantQuery, setAssistantQuery] = useState('')
  const [assistantResponse, setAssistantResponse] = useState<string | null>(null)
  // The RAW rows behind the assistant's two title rows, for the same reason
  // categorySearchRaw below keeps rows rather than MediaItems: the watched/
  // My List/disliked badges are baked in at conversion time, and an answer
  // panel that outlives a mark-watched made from the title it opened would
  // otherwise keep showing the old badge.
  const [assistantFindings, setAssistantFindings] = useState<{
    results: CatalogItem[]
    similar: CatalogItem[]
    similarSource: 'model' | 'catalog' | null
    searching: boolean
  }>({ results: [], similar: [], similarSource: null, searching: false })
  // A STACK, not a slot. Opening a title from another title (the Rest of
  // the series / Similar / Story panels) pushes a second origin, and a
  // single slot meant the first one was simply overwritten: after
  // Movie 1 -> its sequel, backing out of the sequel returned to Movie 1
  // and then pointed the button at Movie 1's own route, so pressing Back
  // again navigated to the page already on screen. The trail was one deep
  // and the way out of a franchise was a loop.
  const [browsingTrail, setBrowsingTrail] = useState<BrowsingOrigin[]>([])
  // The entry a Back press just consumed, handed to the destination page
  // so it can restore scroll/rail/focus. Separate from the trail because
  // the trail is "where Back goes next" while this is "what just
  // happened" — and because it is only ever written by an actual Back,
  // never by openDetail, which is what keeps a page from matching an
  // origin captured for itself (see useRestoreBrowsingOrigin's own note
  // on the self-consumption bug that shape used to cause).
  const [pendingRestore, setPendingRestore] = useState<BrowsingOrigin | null>(null)
  const browsingOrigin = browsingTrail.length > 0 ? browsingTrail[browsingTrail.length - 1] : null
  // Titles the person has already agreed to watch below their quality
  // ceiling. Session-scoped and deliberately not persisted: it exists so a
  // 480p series does not re-ask on every autoplayed episode, not to record
  // a preference.
  const acceptedLowQuality = useRef<Set<string>>(new Set())
  const [resolvingMedia, setResolvingMedia] = useState<{
    id: string
    title: string
    stage: PlaybackPreparationStage
    detail?: string
  } | null>(null)
  const playbackPreparationRef = useRef<{ generation: number; controller: AbortController } | null>(
    null
  )
  const playbackPreparationGeneration = useRef(0)
  const [playbackMedia, setPlaybackMedia] = useState<MediaItem | null>(null)
  const [playbackResult, setPlaybackResult] = useState<PlaybackResult | null>(null)
  const [playbackTracks, setPlaybackTracks] = useState<MediaTracks | null>(null)
  const [activeMood, setActiveMood] = useState<string | null>(null)
  const [combinedMoods, setCombinedMoods] = useState<string[]>([])
  // The RAW backend rows behind categorySearch, not the MediaItems the rest
  // of the app reads. Those carry watched/completed/disliked/inMyList flags
  // baked in at the moment they were mapped, and a search now outlives the
  // detail page opened from it — so a result marked watched on that page and
  // returned to would otherwise still show its old badge, and still slip
  // past Hide Watched, until the search was retyped. Keeping the rows and
  // re-deriving below is the same shape useMediaHubBrowseCatalog already
  // uses for the browse grid, and for the same reason.
  const [categorySearchRaw, setCategorySearchRaw] = useState<{
    kind: CategoryKind | null
    query: string
    items: CatalogItem[]
    loading: boolean
    error: boolean
  }>({
    kind: null,
    query: '',
    items: [],
    loading: false,
    error: false
  })

  // Grouped once per history change rather than re-scanned per item — see
  // CatalogItemAdapterContext.historyById.
  const searchHistoryById = useMemo(
    () => indexHistoryById(watchedIdsResult.history),
    [watchedIdsResult.history]
  )

  // The one sanctioned way for a page to turn backend CatalogItems into
  // MediaItems: the adapter plus THIS context's id-sets, so watched/list/
  // disliked badges on a paged grid agree with every other surface. The
  // optional completedIds are the catalog:query result's own — computed
  // in SQL against the aired-episode counts only the database holds — and
  // when present they OVERRIDE the adapter's history-derived guess, which
  // is precisely why the backend returns them.
  const adaptCatalogItems = useCallback(
    (items: CatalogItem[], completedIds?: string[]): MediaItem[] => {
      const completedSet = completedIds ? new Set(completedIds) : null
      return items.map((item) => {
        const adapted = catalogItemToMediaItem(item, {
          trackedIds: myList,
          watchedIds: watchedIdsResult.watchedIds,
          historyById: searchHistoryById,
          dislikedIds
        })
        return completedSet ? { ...adapted, completed: completedSet.has(item.id) } : adapted
      })
    },
    [myList, watchedIdsResult.watchedIds, searchHistoryById, dislikedIds]
  )

  // Re-derived whenever the watch/dislike/My List state behind it moves, so
  // a standing search's badges and the Hide Watched/Completed/Disliked
  // filters always reflect what is true now rather than what was true when
  // the person pressed Enter. Every dependency is a useState value or a memo
  // of one, so this recomputes when the data actually changes and not on
  // every render — which matters, because MediaGrid resets its lazy reveal
  // batch whenever its `items` array identity changes.
  const categorySearch = useMemo<AppStateValue['categorySearch']>(
    () => ({
      kind: categorySearchRaw.kind,
      query: categorySearchRaw.query,
      results: categorySearchRaw.items.map((item) =>
        catalogItemToMediaItem(item, {
          trackedIds: myList,
          watchedIds: watchedIdsResult.watchedIds,
          historyById: searchHistoryById,
          dislikedIds
        })
      ),
      loading: categorySearchRaw.loading,
      error: categorySearchRaw.error
    }),
    [categorySearchRaw, myList, watchedIdsResult.watchedIds, searchHistoryById, dislikedIds]
  )
  // Same derivation, and the same reasoning, as categorySearch just above.
  const assistantResults = useMemo(
    () =>
      assistantFindings.results.map((item) =>
        catalogItemToMediaItem(item, {
          trackedIds: myList,
          watchedIds: watchedIdsResult.watchedIds,
          historyById: searchHistoryById,
          dislikedIds
        })
      ),
    [assistantFindings.results, myList, watchedIdsResult.watchedIds, searchHistoryById, dislikedIds]
  )
  const assistantSimilar = useMemo(
    () =>
      assistantFindings.similar.map((item) =>
        catalogItemToMediaItem(item, {
          trackedIds: myList,
          watchedIds: watchedIdsResult.watchedIds,
          historyById: searchHistoryById,
          dislikedIds
        })
      ),
    [assistantFindings.similar, myList, watchedIdsResult.watchedIds, searchHistoryById, dislikedIds]
  )

  // Which assistant question is the current one. A local model can take a
  // while to answer, so an answer that lands after the person has asked
  // something else — or closed the panel — must be dropped rather than
  // shown. Same guard, same reason, as searchGeneration just below; it
  // replaces the ref that used to hold a fake think-time timer.
  const assistantGeneration = useRef(0)
  // The id main is currently generating an answer under, so it can be told
  // to stop (see abandonAssistantRequest). null whenever nothing is in
  // flight. Derived from assistantGeneration, which only ever counts up
  // within one mount of this provider — that is the whole lifetime of the
  // app, and the only thing a repeat could do is abandon a request whose
  // answer was already going to be discarded.
  const assistantRequestId = useRef<string | null>(null)
  // Guards against an in-flight search resolving after a newer one
  // started (or after clearCategorySearch) — only the most recent call's
  // result is ever applied.
  const searchGeneration = useRef(0)

  // Seed myList/continueWatching from the real backend once
  // home:personalized actually resolves — before that (bridge missing,
  // still loading, or the fetch failed) both keep whatever they already
  // had, which is the empty Set / the remembered Continue Watching row
  // they were initialized with, per "keep dashboard visible" (see
  // hooks.ts).
  useEffect(() => {
    if (!homeFeed.live) return
    // Deliberate effect-based sync, not derivable inline: myList/
    // continueWatching are locally mutable (toggleMyList/markContinueWatching
    // apply optimistic updates on top of whatever was last seeded here), so
    // they can't just be `= homeFeed.trackedIds` on every render — only
    // reseeded when a fresh backend snapshot actually arrives.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMyList(homeFeed.trackedIds)

    setContinueWatching(homeFeed.continueWatching)
  }, [homeFeed.live, homeFeed.trackedIds, homeFeed.continueWatching])

  const refreshMediaHubSettings = useCallback(() => {
    const api = window.api?.mediaHub
    if (!api) return
    api.settings
      .get()
      .then(setMediaHubSettings)
      .catch(() => {})
  }, [])

  useEffect(() => {
    refreshMediaHubSettings()
    // A TorBox 401 anywhere in the backend clears the stored token — pull
    // a fresh settings snapshot so `torboxConnected` (the playback gate
    // below) flips back to false instead of staying stale.
    return window.api?.mediaHub?.torbox.onUnauthorized(() => refreshMediaHubSettings())
  }, [refreshMediaHubSettings])

  // Main looks for an Ollama at its default address on its own, and that
  // look can land after this snapshot was read — so the answer to "is a
  // model connected?" changes underneath us, and every AI surface gates on
  // it. Without this the assistant would keep saying nothing is connected
  // with a model sitting ready behind it.
  useEffect(() => {
    return window.api?.mediaHub?.ollama?.onChanged(() => refreshMediaHubSettings())
  }, [refreshMediaHubSettings])

  const refreshProfiles = useCallback(() => {
    const api = window.api?.mediaHub?.profiles
    if (!api) return
    api
      .list()
      .then(({ profiles: list, activeProfileId: active }) => {
        setProfiles(list)
        setActiveProfileIdState(active)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    refreshProfiles()
  }, [refreshProfiles])

  const refreshPartyStatus = useCallback(() => {
    const api = window.api?.mediaHub?.party
    if (!api) return
    // Keep the previous object when nothing actually changed. This refetches
    // on EVERY incoming party-state message (see the effect below for why
    // refetching beats merging), and each response is freshly deserialized
    // from IPC — so without this comparison an unchanged party still handed
    // down a new identity, re-rendering every consumer and tearing down and
    // re-establishing two IPC subscriptions each time. During an active
    // party that churn runs continuously, which is exactly when the machine
    // is already busy decoding video. The payloads are small flat objects,
    // so stringifying them is far cheaper than the render it avoids.
    api
      .status()
      .then((next) => setPartyStatus((prev) => (prev && sameJson(prev, next) ? prev : next)))
      .catch(() => {})
    api
      .queue()
      .then(({ queue }) => setPartyQueue((prev) => (sameJson(prev, queue) ? prev : queue)))
      .catch(() => {})
  }, [])

  // Toasts and the card menu live in OverlayProvider (see
  // context/OverlayContext.tsx). These four are stable for the life of the
  // app, so re-exporting them in this context keeps every existing
  // `useAppState().pushNotification` call site working, without putting the
  // notifications array — which changes constantly — back into this
  // context’s value and re-rendering all 43 subscribers for a toast.
  // Declared here (rather than right before its first use further down) so
  // every effect in this component, including the party-status one right
  // below, can reference pushNotification — the lint rule that enforces
  // hook-result declare-before-use ordering doesn't care that a closure
  // only actually reads it later, at event time.
  const { pushNotification, dismissNotification, openContextMenu, closeContextMenu } =
    useOverlayActions()

  useEffect(() => {
    const api = window.api?.mediaHub?.party
    if (!api) return
    refreshPartyStatus()
    return api.onEvent((event) => {
      if (event.type === 'party-state') {
        // Was a local merge keyed off the previous state (`prev ? {...} :
        // prev`) — silently a no-op whenever `partyStatus` hadn't finished
        // its first load yet (a real window: refreshPartyStatus() below is
        // itself async, and a party-state push — e.g. the host toggling
        // "anyone can control playback" moments after someone joins — can
        // easily land before that first fetch resolves). The dropped
        // update was never retried, so allowMemberControl could stay wrong
        // client-side for the rest of the session even though the host's
        // own toggle and the main process's own party state were both
        // correct — confirmed as the real cause of a live report where a
        // member couldn't seek despite the host having enabled it.
        // Refetching the authoritative status instead of merging a partial
        // event locally is a few hundred ms slower but can't go stale this
        // way, and also picks up every other field (role, selfId, ...)
        // consistently rather than only members/allowMemberControl.
        refreshPartyStatus()
      } else if (event.type === 'queue-sync') {
        setPartyQueue(event.queue)
      } else if (event.type === 'chat') {
        setPartyChat((previous) => {
          // Relay rooms can echo a local host's message back after the local
          // confirmation. The message id makes that harmless instead of
          // rendering a duplicate line in the room conversation.
          if (previous.some((message) => message.id === event.chat.id)) return previous
          return [...previous, event.chat].slice(-200)
        })
      } else if (event.type === 'host-disconnected') {
        setPartyHostCode(null)
        setPartyWanAvailable(null)
        setPartyHostPort(null)
        refreshPartyStatus()
        // Found live: this silently dropped a member back to the "Host a
        // party / Join a party" form with zero indication anything had
        // happened — the analogous 'preparing-cancelled' failure below
        // already does the right thing here.
        pushNotification({ tone: 'warning', message: 'Lost connection to the watch party host.' })
      }
    })
  }, [refreshPartyStatus, pushNotification])

  const toggleMyList = useCallback(
    (media: MediaItem) => {
      setMyList((prev) => {
        const next = new Set(prev)
        if (next.has(media.id)) next.delete(media.id)
        else next.add(media.id)
        return next
      })
      // Bug fix: this used to skip the homeFeed.refresh() every other
      // tracking mutation here (toggleDisliked, markContinueWatching,
      // refreshWatchStatus) calls after its own write. Without it, a
      // home:personalized fetch already in flight for an unrelated reason
      // (e.g. another tab's mount, a mark-watched refresh) has nothing to
      // supersede it — useMediaHubHomeFeed only cancels a stale in-flight
      // fetch when refresh() bumps its generation. That stale fetch can
      // resolve *after* this toggle's own optimistic Set update, and the
      // "reseed myList from homeFeed.trackedIds" effect above then
      // overwrites the optimistic change back to the pre-toggle value —
      // found live as "clicking Follow doesn't stick." Calling refresh()
      // here, same as the sibling mutations, ensures any such stale fetch
      // gets cancelled and a fresh one (reflecting this toggle's already-
      // completed, synchronous db write) supersedes it.
      window.api?.mediaHub?.tracking
        .toggle(mediaItemToTrackablePayload(media))
        .then((result) => {
          // Persisted from the toggle's own answer rather than waiting for
          // the refresh below to carry it. That refresh throws whenever
          // every catalog source is down — precisely when someone is most
          // likely to restart mid-outage and find this title offering the
          // opposite action, which reverses the write that just succeeded.
          if (typeof result?.tracked === 'boolean') rememberTrackedId(media.id, result.tracked)
          // Untracking is also what drops a title out of Continue Watching
          // (see removeContinueWatching, which has no other channel to
          // call). So unfollowing something in progress has to clear it
          // from that row too — the same write, reached from a different
          // control. Left behind, it came back on the next launch and its
          // Remove button toggled tracking the other way, re-adding what
          // was just untracked.
          if (result?.tracked === false) {
            setContinueWatching((prev) => prev.filter((c) => c.media.id !== media.id))
            forgetContinueWatching(media.id)
          }
          homeFeed.refresh()
        })
        .catch(() => {
          // Best-effort — the optimistic local toggle above already reflects
          // the user's intent; a failed write just means it won't survive a
          // refresh, not a broken UI in the moment.
        })
    },
    [homeFeed]
  )

  const toggleDisliked = useCallback(
    (media: MediaItem) => {
      const api = window.api?.mediaHub
      setDislikedIds((prev) => {
        const next = new Set(prev)
        if (next.has(media.id)) {
          next.delete(media.id)
          api?.disliked.remove(media.id).catch(() => {})
        } else {
          next.add(media.id)
          const payload = mediaItemToTrackablePayload(media)
          api?.disliked.add(payload).catch(() => {})
        }
        return next
      })
      // Recommendations exclude disliked ids server-side (see tracking.ts's
      // home:personalized) — refresh so a newly-disliked item actually drops
      // out of the rail instead of lingering until some unrelated refetch.
      homeFeed.refresh()
    },
    [homeFeed]
  )

  const markContinueWatching = useCallback(
    (id: string, watched: boolean, media?: MediaItem) => {
      const entry = continueWatching.find((c) => c.media.id === id)
      setContinueWatching((prev) =>
        prev.map((c) =>
          c.media.id === id
            ? {
                ...c,
                media: {
                  ...c.media,
                  watched,
                  completed: watched,
                  progressPercentage: watched ? 100 : c.media.progressPercentage
                }
              }
            : c
        )
      )
      const api = window.api?.mediaHub
      // `entry` only exists for a title currently "in progress" — the
      // Continue Watching row DROPS a title the moment it's fully
      // watched, so the single most common reason to call this
      // (un-marking something you didn't actually finish, exactly the
      // reported case) is also the one where `entry` is guaranteed
      // absent. Before this, that meant the whole call silently no-op'd
      // below — the optimistic update above updated nothing real (no
      // matching row to map over) and the IPC call never fired, so
      // nothing anywhere ever actually changed. `media`, passed by every
      // caller that already has the full item in hand (ContextMenu.tsx),
      // covers exactly that gap.
      const source = media ?? entry?.media
      if (!api || !source) return
      // A series/anime title has no single valid watched/unwatched key
      // without a real episode to attach it to — see ContextMenu.tsx's own
      // guard on this, which is the normal caller and where the person
      // actually gets told why (this function runs well before
      // pushNotification is in scope in this component — see its own
      // comment further down — so this backstop stays silent, same as the
      // `!api || !source` guard right above it). Without this, a future
      // caller missing that same check would write a bogus `id:movie:movie`
      // history row (and an equally bogus Simkl entry) instead of tracking
      // anything real. Movies are unaffected — season/episode were never
      // meaningful for them.
      if (
        source.mediaType !== 'movie' &&
        (source.seasonNumber == null || source.episodeNumber == null)
      ) {
        return
      }
      const item = mediaItemToTrackablePayload(source)
      const playback = { season: source.seasonNumber, episode: source.episodeNumber }
      const call = watched ? api.tracking.markWatched : api.tracking.unmarkWatched
      call({ item, playback })
        .then(() => {
          homeFeed.refresh()
          // Watching/unwatching here changes what tracking:list's history
          // reports for this id too — refresh so the plain catalog grids'
          // own watched/completed badges (see watchedIdsResult, threaded
          // into browseCatalog above) don't go stale until some unrelated
          // catalog refetch happens to pick it up.
          watchedIdsResult.refresh()
        })
        .catch(() => {})
    },
    [continueWatching, homeFeed, watchedIdsResult]
  )

  const removeContinueWatching = useCallback(
    (id: string) => {
      const entry = continueWatching.find((c) => c.media.id === id)
      setContinueWatching((prev) => prev.filter((c) => c.media.id !== id))
      const api = window.api?.mediaHub
      if (!api || !entry) return
      // No dedicated "remove from continue watching" channel — untracking
      // is what actually drops it from home:personalized's list.
      api.tracking
        .toggle(mediaItemToTrackablePayload(entry.media))
        .then((result) => {
          // Written straight to the snapshot rather than waiting for the
          // refresh below, which throws during exactly the outage where
          // this local write still succeeds. Without it the row came back
          // on restart, and a second Remove toggled tracking the other way
          // and re-added it.
          forgetContinueWatching(id)
          if (typeof result?.tracked === 'boolean') rememberTrackedId(id, result.tracked)
          homeFeed.refresh()
        })
        .catch(() => {})
    },
    [continueWatching, homeFeed]
  )

  // A refused download is never routine — it's either something hostile
  // reaching for the disk or a bug in this app, and both are worth saying
  // out loud rather than only writing to a log nobody reads. Warning tone
  // rather than error: nothing is broken, the guard did its job.
  useEffect(() => {
    return window.api?.mediaHub?.downloads?.onBlocked((item) => {
      pushNotification({
        tone: 'warning',
        message: `Blocked a download: "${item.filename}" from ${item.host}. ${item.reason}`
      })
    })
  }, [pushNotification])

  // Watch-status reconciliation — see tracking.ts's own header comment on
  // why this only ever runs occasionally and never on the critical path
  // of opening the app: fired once, a few seconds after mount, so it
  // never competes with the app actually becoming usable, and the main
  // process itself enforces a cooldown between real attempts (see
  // RECONCILE_COOLDOWN_MS) regardless of how often this effect happens to
  // run — repeatedly closing and reopening the app can't turn into
  // repeated Simkl requests.
  const [syncDiscrepancies, setSyncDiscrepancies] = useState<WatchStatusDiscrepancy[]>([])
  const [syncReviewOpen, setSyncReviewOpen] = useState(false)
  const [controlCentreOpen, setControlCentreOpen] = useState(false)

  // Discarded when the library underneath them changes — a profile switch, or
  // a restore. A discrepancy is a claim about ONE profile's history against
  // Simkl's, and resolving a stale one would either rewrite the newly active
  // profile's history or push the previous profile's decision to the account.
  // Reset during render rather than from an effect, which would cascade a
  // render and leave one frame in which the panel could still be acted on.
  const [discrepanciesFor, setDiscrepanciesFor] = useState(libraryKey)
  if (discrepanciesFor !== libraryKey) {
    setDiscrepanciesFor(libraryKey)
    setSyncDiscrepancies([])
    setSyncReviewOpen(false)
  }

  useEffect(() => {
    const api = window.api?.mediaHub?.tracking
    if (!api) return
    const timer = setTimeout(() => {
      api
        .reconcileCheck()
        .then((result) => {
          if (!result.discrepancies.length) return
          setSyncDiscrepancies(result.discrepancies)
          pushNotification({
            tone: 'info',
            message:
              result.discrepancies.length === 1
                ? `"${result.discrepancies[0].title}" is out of sync with Simkl.`
                : `${result.discrepancies.length} titles are out of sync with Simkl.`,
            action: { label: 'Review', run: () => setSyncReviewOpen(true) }
          })
        })
        .catch(() => {})
    }, 8000)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately once per app session, not re-armed by pushNotification identity
  }, [])

  const resolveSyncDiscrepancy = useCallback(
    (discrepancy: WatchStatusDiscrepancy, resolution: ReconcileResolution) => {
      // Optimistic — the list is meant to shrink as each item is handled,
      // and there is no useful "undo" state to roll back to. A "keep
      // local" pick is now recorded in main before this call returns and
      // pushed out to the tracking services as a batch a few seconds
      // later (see tracking.ts's pending queue), so the row leaving here
      // means the decision is kept, not that the push already succeeded —
      // the push's real outcome arrives on the onReconcileSync effect
      // below.
      setSyncDiscrepancies((prev) => prev.filter((d) => d.id !== discrepancy.id))
      window.api?.mediaHub?.tracking
        .reconcileResolve({ discrepancy, resolution })
        .then((result) => {
          // A "keep local" pick that main couldn't record is the one case
          // where the optimism above is wrong: nothing is queued, nothing
          // will retry, and staying quiet would put us right back to a
          // choice silently going nowhere. Put the row back and say so.
          if (resolution === 'use-local' && !result?.queued) {
            setSyncDiscrepancies((prev) =>
              prev.some((d) => d.id === discrepancy.id) ? prev : [...prev, discrepancy]
            )
            pushNotification({
              tone: 'error',
              message: `Could not keep your choice for "${discrepancy.title}". Nothing was changed — try again.`
            })
            return
          }
          watchedIdsResult.refresh()
          homeFeed.refresh()
        })
        .catch(() => {})
    },
    [watchedIdsResult, homeFeed, pushNotification]
  )

  // The other half of that: a queued batch going out (or not) is the only
  // moment anyone can find out whether their decision actually reached
  // the services. Silence here is what let the same titles come back on
  // every launch, so each outcome gets said out loud — including the
  // "still retrying" case, which is genuinely fine but shouldn't look
  // like success.
  useEffect(() => {
    const api = window.api?.mediaHub?.tracking
    if (!api?.onReconcileSync) return
    return api.onReconcileSync((report) => {
      const list = (titles: string[]): string =>
        titles.length === 1 ? `"${titles[0]}"` : `${titles.length} titles`
      // Not an else-if chain: one batch can carry both, and hearing only
      // about the titles that were given up on leaves the others looking
      // like they went through.
      if (report.abandoned.length) {
        pushNotification({
          tone: 'error',
          message: `Could not sync ${list(report.abandoned)} to your tracking services after several tries — no longer flagging ${report.abandoned.length === 1 ? 'it' : 'them'}.${report.error ? ` ${report.error}` : ''}`
        })
      }
      if (report.retrying.length) {
        pushNotification({
          tone: 'warning',
          message: `${list(report.retrying)} could not be synced yet — this will be retried.${report.error ? ` ${report.error}` : ''}`
        })
      }
      if (report.pushed.length) {
        pushNotification({
          tone: 'success',
          message: `Synced ${list(report.pushed)} to your tracking services.`
        })
      }
    })
  }, [pushNotification])

  const cancelProfilePinPrompt = useCallback(() => setProfilePinPrompt(null), [])

  const switchProfile = useCallback(
    (id: string, pin?: string) => {
      const target = profiles.find((p) => p.id === id)
      if (!target) return
      const api = window.api?.mediaHub?.profiles
      if (!api) {
        // No bridge (e.g. rendered outside Electron) — nothing to persist,
        // just reflect the choice locally like every other mock fallback.
        setActiveProfileIdState(id)
        setProfilePinPrompt(null)
        return
      }
      if (target.hasPin && pin === undefined) {
        setProfilePinPrompt(target)
        return
      }
      api
        .setActive(id, pin)
        .then(({ activeProfileId: active }) => {
          setActiveProfileIdState(active)
          setProfilePinPrompt(null)
        })
        .catch((error: unknown) => {
          pushNotification({
            tone: 'error',
            message: error instanceof Error ? error.message : 'Could not switch profile.'
          })
        })
    },
    [profiles, pushNotification]
  )

  const createProfile = useCallback(
    async (payload: { name: string; isKid?: boolean; pin?: string }) => {
      const api = window.api?.mediaHub?.profiles
      if (!api) throw new Error("Profiles aren't available outside the desktop app.")
      await api.create(payload)
      refreshProfiles()
    },
    [refreshProfiles]
  )

  const updateProfile = useCallback(
    async (payload: { id: string; name?: string; isKid?: boolean; pin?: string | null }) => {
      const api = window.api?.mediaHub?.profiles
      if (!api) throw new Error("Profiles aren't available outside the desktop app.")
      await api.update(payload)
      refreshProfiles()
    },
    [refreshProfiles]
  )

  const deleteProfile = useCallback(
    async (id: string) => {
      const api = window.api?.mediaHub?.profiles
      if (!api) throw new Error("Profiles aren't available outside the desktop app.")
      await api.remove(id)
      refreshProfiles()
    },
    [refreshProfiles]
  )

  const hostParty = useCallback(
    async (name: string) => {
      const api = window.api?.mediaHub?.party
      if (!api) throw new Error("Watch Party isn't available outside the desktop app.")
      // No transport choice: hosting opens the direct listener and, when
      // R3-Party-Sync is configured, the relay too — one code, every door.
      const result = await api.host(name)
      setPartyHostCode(result.code)
      // "Reachable beyond the LAN", not literally "WAN port mapped": the
      // relay attaching makes the hybrid invite work across the internet
      // even when UPnP failed, and the reachability banner must not tell a
      // host to configure the relay they are already attached to.
      setPartyWanAvailable((result.wanAvailable ?? false) || (result.relayAttached ?? false))
      setPartyHostPort(result.port ?? null)
      setPartyChat([])
      setPartyPanelOpen(true)
      refreshPartyStatus()
      return result
    },
    [refreshPartyStatus]
  )

  const joinParty = useCallback(
    async (code: string, name: string) => {
      const api = window.api?.mediaHub?.party
      if (!api) throw new Error("Watch Party isn't available outside the desktop app.")
      await api.join(code, name)
      setPartyHostCode(null)
      setPartyWanAvailable(null)
      setPartyHostPort(null)
      setPartyChat([])
      setPartyPanelOpen(true)
      refreshPartyStatus()
    },
    [refreshPartyStatus]
  )

  const leaveParty = useCallback(async () => {
    const api = window.api?.mediaHub?.party
    if (!api) throw new Error("Watch Party isn't available outside the desktop app.")
    await api.leave()
    setPartyHostCode(null)
    setPartyWanAvailable(null)
    setPartyHostPort(null)
    setPartyChat([])
    setPartyPanelOpen(false)
    setPartyStatus(null)
    setPartyQueue([])
    setPartyChat([])
  }, [])

  const suggestToParty = useCallback(
    async (item: { id: string; type?: string; title?: string; poster?: string; year?: string }) => {
      const api = window.api?.mediaHub?.party
      if (!api) throw new Error("Watch Party isn't available outside the desktop app.")
      await api.suggest(item)
      refreshPartyStatus()
    },
    [refreshPartyStatus]
  )

  const sendPartyChat = useCallback(async (text: string) => {
    const api = window.api?.mediaHub?.party
    if (!api) throw new Error("Watch Party isn't available outside the desktop app.")
    const trimmed = text.trim()
    if (!trimmed) return
    await api.chat({ id: crypto.randomUUID(), text: trimmed, sentAt: Date.now() })
  }, [])

  const voteQueue = useCallback(
    async (queueId: string, direction: 1 | -1) => {
      const api = window.api?.mediaHub?.party
      if (!api) return
      await api.vote(queueId, direction)
      refreshPartyStatus()
    },
    [refreshPartyStatus]
  )

  const removeFromQueue = useCallback(
    async (queueId: string) => {
      const api = window.api?.mediaHub?.party
      if (!api) return
      await api.remove(queueId)
      refreshPartyStatus()
    },
    [refreshPartyStatus]
  )

  // Stops main generating an answer nobody is waiting for any more. The
  // generation counter alone only discards the answer when it eventually
  // arrives; the model keeps running for up to two minutes on the person's
  // own hardware, and a replacement question ends up queued behind work
  // that was explicitly dismissed. See ollamaService.ts's inFlightAsks.
  const abandonAssistantRequest = useCallback(() => {
    const pending = assistantRequestId.current
    if (!pending) return
    assistantRequestId.current = null
    window.api?.mediaHub?.ollama?.cancel(pending).catch(() => {})
  }, [])

  const closeAssistant = useCallback(() => {
    // Abandons any answer still being generated, or a closed panel reopens
    // itself with the answer to a question nobody is waiting for any more.
    assistantGeneration.current += 1
    abandonAssistantRequest()
    setAssistantState('idle')
    setAssistantResponse(null)
    setAssistantQuery('')
    setAssistantFindings({ results: [], similar: [], similarSource: null, searching: false })
  }, [abandonAssistantRequest])

  // Centralized here (every "open a title" call site — card, hero,
  // continue-watching row, context menu — already just calls
  // openDetail(media) with no extra args) rather than threading capture
  // logic through each of them individually: this one place can read
  // "where are we right now" (location, active category search/mood) and
  // "what's on screen right now" (focused card, rail scroll positions,
  // via captureBrowsingOrigin's own DOM inspection) without every caller
  // needing to know or supply any of it.
  //
  // `originLabelOverride` is the one exception: when a detail page opens
  // ANOTHER title (the Similar Content panel), the current location is
  // itself a detail route (/movies/abc123), which deriveBrowsingLabel
  // can't turn into a meaningful label on its own (a URL has the id, not
  // the title) — the caller supplies just this title (e.g. "Attack on
  // Titan") in that one case, same as the plain kind/genre/sort labels
  // deriveBrowsingLabel itself returns — ContextBackButton is what prepends
  // "Back to " for every label, override or not, so this must NOT include
  // that prefix itself (it doubled up as "Back to Back to X" before this
  // comment was written). Every other call site omits it and gets the
  // auto-derived label, same as before.
  const openPerson = useCallback(
    (name: string) => {
      const trimmed = String(name || '').trim()
      if (trimmed) navigate(`/people/${encodeURIComponent(trimmed)}`)
    },
    [navigate]
  )

  const openDetail = useCallback(
    (media: MediaItem, originLabelOverride?: string) => {
      const route = `${location.pathname}${location.search}`
      const label =
        originLabelOverride ??
        deriveBrowsingLabel({
          pathname: location.pathname,
          searchParams: new URLSearchParams(location.search),
          categorySearch,
          activeMood
        })
      const captured = captureBrowsingOrigin(route, label)
      setBrowsingTrail((trail) =>
        // Opening a title from ANOTHER title extends the chain already in
        // progress; opening one from a grid, Home or search starts a fresh
        // chain, which is also what keeps the trail from accumulating
        // stale entries across a session when someone leaves a detail page
        // by the nav rail instead of the back button.
        (isDetailRoute(location.pathname) ? [...trail, captured] : [captured]).slice(-MAX_TRAIL)
      )
      // A new drill-down invalidates any restore the last Back left pending.
      setPendingRestore(null)
      closeContextMenu()
      navigate(mediaKindToDetailPath(media))
    },
    [location.pathname, location.search, categorySearch, activeMood, navigate, closeContextMenu]
  )

  /**
   * Takes one step back out: pops the trail and returns the entry that was
   * on top, having also parked it as `pendingRestore` for the page about to
   * mount. Null when the trail is empty — the caller (a detail page opened
   * by deep link, or one whose chain has been fully unwound) falls back to
   * its own category route.
   *
   * The pop and the navigate are deliberately one action. Leaving the entry
   * on the trail until the destination "used" it worked for a browse page,
   * which remounts and consumes it, but not for a destination that is
   * itself a detail page: /movies/:id does not remount when only the id
   * changes, so nothing ever consumed it and Back stayed pointed at the
   * page it had just returned to.
   */
  const popBrowsingOrigin = useCallback((): BrowsingOrigin | null => {
    if (!browsingOrigin) return null
    setBrowsingTrail((trail) => trail.slice(0, -1))
    setPendingRestore(browsingOrigin)
    return browsingOrigin
  }, [browsingOrigin])

  const clearPendingRestore = useCallback(() => setPendingRestore(null), [])

  // Playback gate (spec decision: keep the dashboard visible without a
  // TorBox connection, only gate actual playback). `mediaHubSettings ===
  // null` (bridge missing, or the first settings fetch hasn't resolved
  // yet) is treated as "allow" rather than "block" — the resolve call
  // below degrades to a clear notification if it turns out there's no
  // real backend to resolve a stream from, which is a better first
  // impression than silently refusing to open at all.
  //
  // Does the actual stream:resolve ("searching") + stream:play
  // ("buffering") round trip itself now, rather than handing an
  // unresolved title straight to PlaybackOverlay and letting IT show a
  // full-screen "resolving"/"no source" state — see resolvingMedia's own
  // doc comment on the AppStateValue interface for why. playbackMedia
  // (and therefore the overlay) is only ever set once there's a real,
  // playable PlaybackResult in hand; a no-source or error outcome just
  // pushes a notification and leaves the person exactly where they were.
  const cancelPlaybackPreparation = useCallback(() => {
    const pending = playbackPreparationRef.current
    if (!pending) return
    pending.controller.abort()
    playbackPreparationRef.current = null
    setResolvingMedia(null)
    // A stream:play IPC request may have reached the main process already.
    // Stop is idempotent and prevents a late result leaving an orphan proxy
    // or ffmpeg process behind after the UI has cancelled it.
    window.api?.mediaHub?.playback.stop().catch(() => {})
  }, [])

  // Main narrates the long stages as it works through them (see
  // PlaybackPrepareProgress). Subscribed for the app's whole lifetime
  // rather than per-preparation: these arrive from a session that's
  // already in flight, and a subscription set up alongside it would race
  // the first few events. Anything that lands while nothing is being
  // prepared — the identical ffmpeg restarts a seek performs mid-playback
  // — falls through the `prev ? ... : prev` and changes nothing.
  useEffect(() => {
    return window.api?.mediaHub?.playback.onPrepareProgress((payload) => {
      setResolvingMedia((prev) => (prev ? { ...prev, detail: payload.message } : prev))
    })
  }, [])

  // Continue Watching, readable from a callback without making that callback
  // change identity every time the home feed refreshes. resolvePlaybackTarget
  // below is the only reader, and it wants the latest row, not the one that
  // existed when it was last rebuilt.
  const continueWatchingRef = useRef<ContinueWatchingItem[]>(continueWatching)
  useEffect(() => {
    continueWatchingRef.current = continueWatching
  }, [continueWatching])

  /**
   * Which episode a bare "play this" actually means.
   *
   * A title card carries a SHOW, not an episode: nothing on it says where in
   * the show you are. Everything downstream of here needs a coordinate, and
   * the one it used to get was buildMediaId's `?? 1` fallback — so pressing
   * Play on a series card you were four seasons into started season 1,
   * episode 1. The detail page never had that problem because it computes
   * first-unwatched itself; the cards, the hero and the context menu did.
   *
   * THE EPISODE LIST IS THE SOURCE OF TRUTH, not the Continue Watching row,
   * even though the row is already in memory and free to read. The row's
   * `continueSeason/continueEpisode` is core.ts's first-unwatched over the
   * WHOLE of `videos`, future-dated entries included — so for a show still
   * airing that somebody is caught up on, it names next week's episode. That
   * is a real answer to "where are you in this show" and the wrong one for
   * "what should start now": nothing has been released, so the stream search
   * would find nothing and give up. episodeToStart applies the same aired
   * rule the progress bars count by, and needs the list to do it.
   *
   * So the row is the FALLBACK, taken only when the metadata or history call
   * fails, where a possibly-unaired coordinate still beats S1E1.
   *
   * An explicit coordinate from the caller always wins — the detail page, the
   * episode grid and party follow-along all know exactly what they mean and
   * must not be second-guessed. Movies are returned untouched.
   *
   * Total failure is not fatal either: the media comes back as it went in and
   * the old `?? 1` fallback applies exactly as before.
   */
  const resolvePlaybackTarget = useCallback(async (media: MediaItem): Promise<MediaItem> => {
    const kind = media.mediaKind ?? (media.mediaType === 'series' ? 'series' : 'movie')
    if (kind === 'movie') return media
    if (media.seasonNumber != null && media.episodeNumber != null) {
      // The caller named its coordinates — respect them. But a coordinate
      // without the episode's NAME leaves the player badge half-blank, so
      // when the name is missing it is looked up from the (cached)
      // metadata: a map lookup in the common case, and a failure returns
      // the media untouched rather than delaying playback.
      if (media.episodeTitle) return media
      try {
        const meta = await window.api?.mediaHub?.catalog.meta(kind, media.id)
        const picked = meta?.videos?.find(
          (video) => video.season === media.seasonNumber && video.episode === media.episodeNumber
        )
        return picked?.title ? { ...media, episodeTitle: picked.title } : media
      } catch {
        return media
      }
    }

    const api = window.api?.mediaHub
    if (api) {
      try {
        const [meta, tracking] = await Promise.all([
          api.catalog.meta(kind, media.id),
          api.tracking.list()
        ])
        const watchedKeys = new Set<string>()
        for (const row of tracking.history) {
          if (String(row.id) !== String(media.id)) continue
          if (row.season == null || row.episode == null) continue
          watchedKeys.add(episodeWatchKey(row.season, row.episode))
        }
        if (meta?.videos?.length) {
          const target = episodeToStart(meta.videos, watchedKeys)
          // The picked episode's own name rides along — it is what the
          // player's badge shows under "S2 · E5".
          const picked = meta.videos.find(
            (video) => video.season === target.season && video.episode === target.episode
          )
          return {
            ...media,
            seasonNumber: target.season,
            episodeNumber: target.episode,
            episodeTitle: picked?.title
          }
        }
      } catch {
        // Falls through to the Continue Watching row below.
      }
    }

    const entry = continueWatchingRef.current.find((row) => row.media.id === media.id)
    if (entry?.media.seasonNumber != null && entry.media.episodeNumber != null) {
      return {
        ...media,
        seasonNumber: entry.media.seasonNumber,
        episodeNumber: entry.media.episodeNumber,
        episodeTitle: entry.media.episodeTitle
      }
    }
    return media
  }, [])

  const startPlaybackRef = useRef<(media: MediaItem) => Promise<boolean>>(async () => false)
  // Same forward-reference trick as startPlaybackRef above, for the same
  // reason: the player's ui-event listener is subscribed before
  // startPartyPlayback is defined, and re-subscribing it on every identity
  // change would drop events raised in the gap.
  const startPartyPlaybackRef = useRef<
    (media: MediaItem, opts?: { season?: number; episode?: number }) => Promise<void>
  >(async () => {})
  /**
   * The whole start-a-title path, reporting WHICH title it actually started
   * as well as whether it started.
   *
   * Split out of startPlayback (which is now a thin boolean wrapper over it)
   * so that resolving "which episode" happens INSIDE the cancellation
   * generation established below, not before it. When two bare series cards
   * are pressed in quick succession, each resolution is a metadata + history
   * round trip that can finish out of order; whichever call reaches here
   * second owns the generation, and the first one's late resolution is
   * discarded at the isCurrent() check rather than cancelling the newer
   * preparation and starting the title nobody asked for last.
   *
   * `target` is what the party path needs: it announces a season and episode
   * to followers, and that has to be the episode that actually started.
   */
  const runPlayback = useCallback(
    async (requested: MediaItem): Promise<{ started: boolean; target: MediaItem }> => {
      // Either source alone is a complete setup — TorBox, a media server,
      // or both. Only having neither blocks playback.
      if (
        mediaHubSettings &&
        !mediaHubSettings.torboxConnected &&
        !mediaHubSettings.mediaServerConnected
      ) {
        pushNotification({
          tone: 'warning',
          message: 'Connect TorBox or a media server in Settings to start playback.'
        })
        return { started: false, target: requested }
      }
      const api = window.api?.mediaHub
      if (!api) {
        pushNotification({
          tone: 'error',
          message: "Playback isn't available outside the desktop app."
        })
        return { started: false, target: requested }
      }
      closeContextMenu()
      cancelPlaybackPreparation()
      const generation = ++playbackPreparationGeneration.current
      const controller = new AbortController()
      playbackPreparationRef.current = { generation, controller }
      const isCurrent = (): boolean =>
        playbackPreparationRef.current?.generation === generation && !controller.signal.aborted
      // Which episode "play this series" means, resolved before anything is
      // built from the coordinate. Inside the spinner rather than before it:
      // this can be a round trip for metadata and history, and a Play button
      // that sits dead for it looks broken. Idempotent — a caller that
      // already named an episode gets its own answer straight back, so the
      // party path below can resolve first and reach here for free.
      setResolvingMedia({ id: requested.id, title: requested.title, stage: 'resolving' })
      const media = await resolvePlaybackTarget(requested)
      if (!isCurrent()) return { started: false, target: requested }
      const kind = media.mediaKind ?? (media.mediaType === 'series' ? 'series' : 'movie')
      const mediaId = buildMediaId(kind, media.id, media.seasonNumber, media.episodeNumber)
      // For series, the stream search itself needs to know which episode is
      // wanted, not just which show — passing the bare show id (found
      // live, via a "No matching video file" error) meant the addon had no
      // episode context at all and could rank a completely different
      // season's pack as "best". `mediaId`'s imdbId:season:episode is
      // exactly the convention Cinemeta-style addons expect for this.
      //
      // Anime doesn't work the same way: Kitsu ids are already scoped to a
      // single season/cour (there's no cross-season id the way IMDb has),
      // so anime addons expect kitsuId:episode with NO season segment at
      // all — confirmed live, `mediaId`'s kitsuId:season:episode form
      // returned zero results even for a title with real, cached releases
      // under the correct kitsuId:episode form.
      const resolveId = kind === 'anime' ? `${media.id}:${media.episodeNumber ?? 1}` : mediaId
      try {
        const resolved = await runPlaybackPreparationStage(
          api.stream.resolve(kind, resolveId, media.title, {
            catalogId: media.id,
            seasonNumber: media.seasonNumber,
            episodeNumber: media.episodeNumber
          }),
          'resolving',
          30_000,
          controller.signal
        )
        if (!isCurrent()) return { started: false, target: media }
        setResolvingMedia({ id: media.id, title: media.title, stage: 'safety-checking' })
        if (!resolved.best) {
          // `queued` (see StreamResolveResult's own doc comment) means a
          // real torrent existed but nothing was cached yet, and the
          // backend just submitted it to TorBox to start downloading —
          // genuinely different from "nothing exists for this title
          // anywhere," and worth telling apart rather than one generic
          // failure message for both.
          pushNotification({
            tone: resolved.queued ? 'warning' : 'error',
            message: resolved.queued
              ? "This title wasn't cached yet, so TorBox has started downloading it — try again in a few minutes."
              : 'No sources were found for this title yet — try again later.'
          })
          return { started: false, target: media }
        }

        // An old film that only exists at 480p is still worth watching — the
        // player upscales — so a shortfall is never a refusal, only a
        // question. Asked once per title per session: without that, a 480p
        // series would ask again on every autoplayed episode, which is how a
        // useful prompt becomes one nobody reads.
        const ceiling = mediaHubSettings?.maxStreamResolution ?? 0
        const got = streamResolution(resolved.best)
        if (isNoticeablyBelowCeiling(got, ceiling) && !acceptedLowQuality.current.has(media.id)) {
          if (
            !window.confirm(
              `The best copy of ${media.title} available right now is ${resolutionLabel(got)}, ` +
                `below the ${resolutionLabel(ceiling)} you allow. It will be scaled to fit your ` +
                `screen.\n\nPlay it anyway?`
            )
          ) {
            setResolvingMedia(null)
            return { started: false, target: media }
          }
          // Recorded ONLY on a real acceptance. This used to run on every
          // resolve, including the ones that met the ceiling and asked
          // nothing — and since the key is the series rather than the
          // episode, a first episode that played at full quality silently
          // bought consent for a later one that only exists at 480p.
          // Playing a copy that was fine is not agreement to anything.
          acceptedLowQuality.current.add(media.id)
        }

        setResolvingMedia({ id: media.id, title: media.title, stage: 'buffering' })
        const playTask = api.stream.play(resolved.best, mediaId, kind, resolveId, {
          catalogId: media.id,
          title: media.title,
          posterUrl: media.posterUrl,
          mediaKind: kind,
          seasonNumber: media.seasonNumber,
          episodeNumber: media.episodeNumber,
          episodeTitle: media.episodeTitle
        })
        // If cancellation/timeout wins the race, a late successful IPC result
        // must not leave its newly-created backend playback session running.
        void playTask.then(
          () => {
            if (!isCurrent()) api.playback.stop().catch(() => {})
          },
          () => {
            // The awaited, deadline-bounded branch below owns user feedback.
          }
        )
        // This one IPC call (stream:play) covers the whole real critical
        // path for starting a title, not just the transcode: TorBox's own
        // requestdl round trip, torbox.ts's retry-once wrapper around it
        // (a full second attempt, on top of the first, when the initial
        // link comes back not-yet-servable), then preparePlayback's own
        // probeMedia (up to 15s — probeMedia's own execFile timeout) and,
        // when the source needs it, a real ffmpeg transcode start (up to
        // 25s for audio-only compatibility mode, or 60s when a forced
        // video re-encode is engaged — see createFfmpegTranscoder's own
        // budget in vlc.ts). Summed, that worst case alone already reaches
        // or exceeds the previous 45s budget here — found live as the
        // actual cause of "playback fails and I have to try again": this
        // stage was timing out and showing an error for a start that the
        // backend would have finished seconds later, throwing away
        // real progress and forcing a full from-scratch retry (new probe,
        // new transcode) instead of just waiting a bit longer for one
        // already under way. 90s gives real margin over that summed worst
        // case while the ordinary fast path (a few seconds) is completely
        // unaffected — this is a ceiling, not a typical wait.
        const played = await runPlaybackPreparationStage(
          playTask,
          'buffering',
          90_000,
          controller.signal
        )
        if (!isCurrent()) return { started: false, target: media }
        setResolvingMedia({ id: media.id, title: media.title, stage: 'starting' })
        setPlaybackResult(played)
        setPlaybackTracks(played.tracks)
        setPlaybackMedia(media)
        // The two upfront warnings that used to fire here are gone with the
        // engine, not merely relocated. `videoCodecWarning` existed because
        // video was only ever stream-copied to a <video> element, so an HEVC or
        // VC-1 source could fail to decode minutes in; mpv decodes all of them.
        // `tracksWarning` existed because a failed ffprobe left the session with
        // no track data at all; the player reports its own track list, so if the
        // file opened there is a real list, and if it did not, that is a hard
        // error reported directly rather than a silent degradation.
        return { started: true, target: media }
      } catch (error) {
        if (error instanceof PlaybackPreparationCancelledError)
          return { started: false, target: media }
        pushNotification({
          tone: 'error',
          message: playbackPreparationErrorMessage(error),
          action: {
            label: 'Retry',
            run: () => {
              void startPlaybackRef.current(media)
            }
          }
        })
        return { started: false, target: media }
      } finally {
        if (playbackPreparationRef.current?.generation === generation) {
          playbackPreparationRef.current = null
          setResolvingMedia(null)
        }
      }
    },
    [
      mediaHubSettings,
      pushNotification,
      closeContextMenu,
      cancelPlaybackPreparation,
      resolvePlaybackTarget
    ]
  )
  /** The public shape: everything outside this file only wants to know
   *  whether a title started. */
  const startPlayback = useCallback(
    async (media: MediaItem): Promise<boolean> => (await runPlayback(media)).started,
    [runPlayback]
  )
  useEffect(() => {
    startPlaybackRef.current = startPlayback
  }, [startPlayback])
  const stopPlayback = useCallback((watched?: boolean) => {
    // The one place that genuinely means "playback is over" — every close
    // path routes through here. PlaybackOverlay's unmount deliberately no
    // longer does this; see the comment there for why doing it per-title
    // destroyed the session that had just been created. `watched` (passed
    // from PlaybackOverlay's markedWatchedRef at its three real-close call
    // sites) tells the backend whether to delete this title's local
    // stream-cache directory outright rather than leaving it for the idle
    // sweep — see playbackSession.ts's stopPlayback.
    window.api?.mediaHub?.playback.stop({ watched }).catch(() => {})
    setPlaybackMedia(null)
    setPlaybackResult(null)
    setPlaybackTracks(null)
  }, [])

  const [watchStatusVersion, setWatchStatusVersion] = useState(0)
  const refreshWatchStatus = useCallback(() => {
    homeFeed.refresh()
    watchedIdsResult.refresh()
    setWatchStatusVersion((v) => v + 1)
  }, [homeFeed, watchedIdsResult])

  // The main-window half of the player bridge. The controls live in their own
  // window now (mpv's native surface composites above web content, so they
  // cannot be drawn over it in this one — see main/media-hub/playerWindow.ts),
  // and that window has no access to this context. Anything it raises whose
  // effect belongs to THIS window's state arrives here.
  //
  // mark-watched in particular stays on this side because it needs the full
  // MediaItem to build its trackable payload, and that record lives here —
  // shipping it across the boundary and back would be strictly worse.
  // Keeps main's picture of the party panel in step with this window's, by
  // reporting it rather than letting main infer it. Main has to know and cannot
  // see React state: mpv's window sits over this window's content area, so
  // while the panel is up the video has to be handed the back and the app the
  // front, and when the panel goes the video takes the front back. Without this
  // the Party button appeared to do nothing at all.
  //
  // Both edges are reported now, whatever is playing. That is what lets main
  // hold mainWindowUiOpen across a stop rather than clearing it there — see its
  // comment in playerBridge.ts. The old close report only fired during
  // playback, so the flag had to be cleared on every stop to keep it from
  // sticking, and clearing it is what let a title played from the still-open
  // queue cover the panel that started it.
  //
  // The open edge is re-reported whenever the playing title changes, so a flag
  // that has drifted the other way is repaired by the next thing played rather
  // than staying wrong. The first run always reports, even with nothing yet to
  // report: main outlives a renderer reload and this window comes back with the
  // panel closed, and that opening "closed" is what stops a panel that was open
  // before the reload from keeping the video down forever. Between them there
  // is no state main can be left holding that this window does not correct.
  //
  // Outside playback both reports are no-ops on main's side — there is no
  // video child to hide or reveal, and no overlay to go with it.
  const partyPanelReportedOpen = useRef<boolean | null>(null)
  useEffect(() => {
    const reported = partyPanelReportedOpen.current
    partyPanelReportedOpen.current = partyPanelOpen
    const player = window.api?.mediaHub?.player
    if (!player) return
    if (partyPanelOpen) player.uiEvent({ type: 'party-panel-open' }).catch(() => {})
    else if (reported !== false) player.uiEvent({ type: 'party-panel-closed' }).catch(() => {})
  }, [partyPanelOpen, playbackMedia])

  // Held in refs, not dependencies: refreshWatchStatus's identity changes
  // whenever the home feed or watched-ids query refreshes, and re-subscribing
  // the IPC listener on every one of those would drop events raised in the gap.
  const playbackMediaForEventsRef = useRef(playbackMedia)
  const stopPlaybackRef = useRef(stopPlayback)
  const refreshWatchStatusRef = useRef(refreshWatchStatus)
  useEffect(() => {
    playbackMediaForEventsRef.current = playbackMedia
    stopPlaybackRef.current = stopPlayback
    refreshWatchStatusRef.current = refreshWatchStatus
  }, [playbackMedia, stopPlayback, refreshWatchStatus])
  useEffect(() => {
    const api = window.api?.mediaHub?.player
    if (!api) return
    return api.onUiEvent((event) => {
      switch (event.type) {
        case 'stop-playback':
          stopPlaybackRef.current(event.watched)
          return
        case 'mark-watched': {
          const media = playbackMediaForEventsRef.current
          if (!media) return
          window.api?.mediaHub?.tracking
            .markWatched({
              item: mediaItemToTrackablePayload(media),
              playback: { season: media.seasonNumber, episode: media.episodeNumber }
            })
            .then(() => refreshWatchStatusRef.current())
            .catch(() => {})
          return
        }
        case 'play-next': {
          const media = playbackMediaForEventsRef.current
          if (!media) return
          // Revalidated rather than trusted, even though the only sender is our
          // own overlay: these two numbers go straight into a stream resolve,
          // and a non-integer would produce a mediaId no addon can answer and a
          // failure the person could not explain.
          const season = Number(event.season)
          const episode = Number(event.episode)
          if (!Number.isInteger(season) || !Number.isInteger(episode)) return
          if (season < 0 || episode < 1) return
          // startPartyPlayback, not startPlayback: outside a room it is the
          // same call, and inside one it announces the episode so the room
          // follows the host into it exactly as it would from a click. A
          // follower never reaches here — the overlay does not offer the card.
          void startPartyPlaybackRef.current(media, { season, episode })
          return
        }
        case 'scrobble': {
          // The event's OWN subject, never playbackMedia. During a title
          // change this window's media has usually already been replaced by
          // the time the overlay's stop arrives, so reading it here sent the
          // outgoing title's stop for the incoming episode — ending a scrobble
          // that had just begun and leaving the previous one running.
          const subject = event.media
          if (!subject?.id) return
          // Fire and forget. A scrobble is a courtesy to a third-party
          // service; nothing in this app waits on it, and a failure is logged
          // in main rather than shown over the video.
          window.api?.mediaHub?.simkl
            .scrobble(
              event.action,
              {
                id: subject.id,
                type: subject.kind,
                title: subject.title,
                year: ''
              },
              { season: subject.seasonNumber, episode: subject.episodeNumber },
              event.progress
            )
            .catch(() => {})
          return
        }
        case 'refresh-watch-status':
          refreshWatchStatusRef.current()
          return
        case 'notify':
          pushNotification({ tone: event.tone, message: event.message })
          return
        case 'set-party-panel-open':
          setPartyPanelOpen(event.open)
          return
        default:
          // set-interactive never reaches the renderer — main handles it on
          // the window itself.
          return
      }
    })
  }, [pushNotification])

  // Host-only: same resolve+play as startPlayback, then (once a real
  // stream is actually playing) announces the title to the party so every
  // follower resolves their OWN independent stream of it — see
  // watchParty.ts's party:now-playing handler, which only ever broadcasts
  // outward and never echoes back to the host's own renderer, so the host
  // applies this to itself via the plain startPlayback call above rather
  // than waiting on its own announcement.
  const startPartyPlayback = useCallback(
    async (media: MediaItem, opts?: { season?: number; episode?: number }) => {
      const target = opts
        ? {
            ...media,
            seasonNumber: opts.season ?? media.seasonNumber,
            episodeNumber: opts.episode ?? media.episodeNumber,
            // The name belonged to the coordinates being REPLACED — the
            // autoplay chain spreads the episode that just ended, and its
            // title must not label the one about to start.
            // resolvePlaybackTarget re-resolves it from cached metadata.
            episodeTitle: undefined
          }
        : media
      const partyApi = window.api?.mediaHub?.party
      // Hosting from a title card can happen in the same click that creates a
      // room. Read main's live snapshot here instead of waiting for React's
      // asynchronous status refresh, otherwise that first title would start
      // locally without announcing itself to the room.
      const livePartyStatus = partyApi
        ? await partyApi.status().catch(() => partyStatus)
        : partyStatus
      const isHosting = !!partyApi && !!livePartyStatus?.inParty && livePartyStatus.role === 'host'
      const partyKind = media.mediaKind ?? (media.mediaType === 'series' ? 'series' : 'movie')
      // Announce BEFORE resolving, not after. runPlayback below is a
      // stream search plus a buffer wait — seconds, sometimes many — and
      // the nowPlaying announcement can only go out once it finishes,
      // because only then is there something real to announce. That left
      // every other member's app completely inert for the whole window
      // with no sign anything was happening. This tells them immediately.
      // Fire-and-forget on purpose: a follower's loading card is not worth
      // delaying or failing the host's own playback over.
      if (isHosting) {
        partyApi
          .preparing({
            item: {
              id: media.id,
              type: partyKind,
              title: media.title,
              poster: media.posterUrl ?? ''
            }
          })
          .catch(() => {})
      }
      // runPlayback rather than startPlayback, for the season and episode it
      // reports back. A bare series card names no episode, and the
      // announcement below has to carry the one that ACTUALLY started or every
      // follower resolves a different stream from the host's. Resolving it
      // here first would have been the obvious way to get it and the wrong
      // one: it would put a metadata round trip in front of the cancellation
      // generation, so two quick clicks could finish out of order and let the
      // older one cancel and replace the newer.
      const { started, target: playing } = await runPlayback(target)
      if (!started) {
        // The host found no source, so no nowPlaying is ever coming —
        // release the followers rather than leaving them spinning.
        if (isHosting) partyApi.preparing({ item: null }).catch(() => {})
        return
      }
      const api = partyApi
      if (!api || !isHosting) return
      const kind = partyKind
      const season = playing.seasonNumber
      const episode = playing.episodeNumber
      api
        .nowPlaying({
          infoHash: '',
          sources: [],
          mediaId: buildMediaId(kind, media.id, season, episode),
          item: { id: media.id, type: kind, title: media.title, poster: media.posterUrl ?? '' },
          season,
          episode,
          position: 0
        })
        .catch(() => {})
    },
    [runPlayback, partyStatus]
  )
  useEffect(() => {
    startPartyPlaybackRef.current = startPartyPlayback
  }, [startPartyPlayback])

  // Read through refs inside the party handlers below, so those
  // subscriptions don't tear down and re-establish every time playback
  // position or settings change — they only care about the values at the
  // moment a message actually arrives.
  const playbackMediaRef = useRef(playbackMedia)
  const hostPartyRef = useRef(hostParty)
  const mediaHubSettingsRef = useRef(mediaHubSettings)
  useEffect(() => {
    playbackMediaRef.current = playbackMedia
    hostPartyRef.current = hostParty
    mediaHubSettingsRef.current = mediaHubSettings
  }, [playbackMedia, hostParty, mediaHubSettings])
  // The nowPlaying replay currently being resolved (type:id:season:episode),
  // for the whole gap where playbackMedia is still null — see the follower
  // unwrap's dedupe below.
  const nowPlayingInFlightRef = useRef<string | null>(null)

  // Follower side of the above: unwrap an incoming `nowPlaying` (see
  // watchParty.ts's handlePartyMessage — every message type other than
  // suggest/vote falls through to the generic `{type:'message', message}`
  // relay, so this is only ever received by clients, never echoed to the
  // host that sent it) into a real MediaItem via the same catalog:meta +
  // catalogItemToMediaItem path MediaDetailPage would use, then plays it
  // through the ordinary startPlayback — each party member genuinely
  // resolves their own stream from their own TorBox account; only this
  // metadata + the play/pause/seek control signals below are ever shared.
  useEffect(() => {
    const api = window.api?.mediaHub?.party
    if (!api) return
    return api.onEvent((event) => {
      if (event.type !== 'message' || partyStatus?.role !== 'client') return
      const msg = event.message as {
        type?: string
        item?: { id?: string; type?: string; title?: string; poster?: string }
        season?: number
        episode?: number
        position?: number
      }
      // "The host has picked something and is working on it" — arrives
      // well before nowPlaying (see PartyPreparingPayload). This is the
      // only thing a follower has to go on until their own stream starts,
      // so it stays up across BOTH waits: the host's resolve and then
      // this member's own.
      if (msg?.type === 'preparing' && msg.item?.title) {
        setPartyPreparing({ title: msg.item.title, poster: msg.item.poster || '' })
        return
      }
      if (msg?.type === 'preparing-cancelled') {
        setPartyPreparing(null)
        pushNotification({
          tone: 'warning',
          message: "The host couldn't start that title."
        })
        return
      }
      if (msg?.type !== 'nowPlaying' || !msg.item?.id || !msg.item.type) return
      // nowPlaying is no longer a one-shot: the host replays it to every
      // late joiner and to anyone who asks to resync, and on the relay
      // those replays necessarily reach EVERY member (the worker only fans
      // out). Two duplicate shapes to refuse:
      //  - already PLAYING the exact title it names — this copy is someone
      //    else's catch-up, not an instruction to restart the film;
      //  - already RESOLVING it — another member being admitted while this
      //    one's stream search is still running re-broadcasts the same
      //    event, and playbackMedia is still null for the whole resolve,
      //    so only the in-flight key below can catch it. Without it, two
      //    concurrent catalog lookups + startPlayback races.
      const replayKey = `${msg.item.type}:${msg.item.id}:${msg.season ?? ''}:${msg.episode ?? ''}`
      const playing = playbackMediaRef.current
      if (
        playing &&
        playing.id === msg.item.id &&
        (playing.seasonNumber ?? undefined) === (msg.season ?? undefined) &&
        (playing.episodeNumber ?? undefined) === (msg.episode ?? undefined)
      ) {
        return
      }
      if (nowPlayingInFlightRef.current === replayKey) return
      const catalogApi = window.api?.mediaHub?.catalog
      if (!catalogApi) return
      nowPlayingInFlightRef.current = replayKey
      // Covers the case where a follower joins (or the message is missed)
      // after the host already sent `preparing` — nowPlaying implies a
      // load is in progress regardless of what came before it.
      setPartyPreparing(
        (prev) => prev ?? { title: msg.item?.title || '', poster: msg.item?.poster || '' }
      )
      catalogApi
        .meta(msg.item.type as MediaKind, msg.item.id)
        .then((catalogItem) => {
          const media = catalogItemToMediaItem(catalogItem)
          setPartyPendingSeek(Number(msg.position) || 0)
          return startPlayback(
            msg.season !== undefined || msg.episode !== undefined
              ? {
                  ...media,
                  seasonNumber: msg.season,
                  episodeNumber: msg.episode,
                  // New coordinates, so the spread's old name is dropped —
                  // resolvePlaybackTarget names the episode being joined.
                  episodeTitle: undefined
                }
              : media
          )
        })
        .catch(() => {
          pushNotification({ tone: 'error', message: "Couldn't load what the host is playing." })
        })
        // Cleared on EVERY outcome, not just success: startPlayback
        // resolves false for a no-source or TorBox-not-connected result
        // without throwing, and that path has to release the card too.
        // The in-flight key clears the same way — only if it is still this
        // resolve's, so a newer title's key is never wiped by an older
        // resolve finishing late. A finished SUCCESS is covered from then
        // on by the already-playing check above.
        .finally(() => {
          setPartyPreparing(null)
          if (nowPlayingInFlightRef.current === replayKey) nowPlayingInFlightRef.current = null
        })
    })
  }, [partyStatus, startPlayback, pushNotification])

  // Last-resort release. Every ordinary path clears the card explicitly,
  // but all of them depend on the host still being alive to send the
  // message that ends the wait — if it quits or drops mid-resolve, none
  // of them ever fire and the follower is left staring at a spinner.
  useEffect(() => {
    if (!partyPreparing) return
    const timer = setTimeout(() => {
      setPartyPreparing(null)
      // Unlike every other path that clears this card (success, the
      // 'preparing-cancelled' message, a resolve failure), this one has no
      // real explanation to give beyond "it took too long" — but silently
      // vanishing after a 3-minute wait is still worse than saying that.
      pushNotification({
        tone: 'warning',
        message: "The host's title never started — try again."
      })
    }, PARTY_PREPARING_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [partyPreparing, pushNotification])

  // Leaving the party (or the host disconnecting) ends any wait too —
  // nothing is coming. Adjusted during render (React's documented
  // "reset state when a prop changes" pattern, same as the More-sheet
  // reset in SidebarNavigation) rather than in an effect: an effect here
  // both costs an extra render pass and trips
  // react-hooks/set-state-in-effect.
  const [preparingInParty, setPreparingInParty] = useState(!!partyStatus?.inParty)
  const inPartyNow = !!partyStatus?.inParty
  if (preparingInParty !== inPartyNow) {
    setPreparingInParty(inPartyNow)
    if (!inPartyNow && partyPreparing) setPartyPreparing(null)
  }

  // Answering "can I watch with you?" from a room member. Lives here
  // rather than in the rooms UI because it needs the things only this
  // context has: whether we're actually playing something, and the
  // ability to start hosting.
  //
  // This is what makes a SOLO watcher joinable at all. Someone watching
  // alone has no party and therefore no code to publish, so a member has
  // nothing to click — the party is created on demand, only when somebody
  // actually asks, rather than forcing everyone to host speculatively.
  // The reply goes back through the room the request arrived on.
  useEffect(() => {
    const api = window.api?.mediaHub?.rooms
    if (!api) return
    return api.onMessage(({ roomId, message }) => {
      if (message.type !== 'friend-join-request') return
      const decline = (reason: string): void => {
        api
          .send(roomId, {
            type: 'friend-join-declined',
            toFriendId: message.fromFriendId,
            fromFriendId: '',
            reason
          })
          .catch(() => {})
      }
      if (!playbackMediaRef.current) {
        decline("They aren't watching anything right now.")
        return
      }
      // Already hosting — hand over the code we've got rather than
      // tearing down a party other people may already be in.
      if (partyStatus?.inParty && partyStatus.role === 'host' && partyHostCode) {
        api
          .send(roomId, {
            type: 'friend-join-offer',
            toFriendId: message.fromFriendId,
            fromFriendId: '',
            partyCode: partyHostCode
          })
          .catch(() => {})
        return
      }
      if (partyStatus?.inParty) {
        decline("They're already in someone else's watch party.")
        return
      }
      hostPartyRef
        .current(mediaHubSettingsRef.current?.partyDisplayName || 'A friend')
        .then((result) => {
          // No nowPlaying announcement here: the party:host handler seeds
          // the new party with the film already playing — at the LIVE
          // playhead — in main, where both the session identity and the
          // observed position actually live. The joiner is then caught up
          // by the ordinary late-join replay.
          api
            .send(roomId, {
              type: 'friend-join-offer',
              toFriendId: message.fromFriendId,
              fromFriendId: '',
              partyCode: result.code
            })
            .catch(() => {})
          pushNotification({
            tone: 'info',
            message: `${message.fromName} is joining your watch party.`
          })
        })
        .catch(() => decline('They could not start a watch party just now.'))
    })
  }, [partyStatus, partyHostCode, pushNotification])

  // A suggestion only ever carries {id, type, title, poster} — no episode —
  // so a series/anime suggestion is inherently ambiguous about which
  // episode to start. Defaulting to S1E1 (rather than leaving season/
  // episode undefined) matters here specifically: an undefined
  // season/episode against a multi-episode torrent leaves stream:play with
  // no way to pick which file inside it to serve, silently failing to
  // produce a playable stream at all. Movies have no such ambiguity.
  const startSuggestedPlayback = useCallback(
    (catalogItem: CatalogItem) => {
      const media = catalogItemToMediaItem(catalogItem)
      return startPartyPlayback(
        media.mediaKind === 'movie' ? media : { ...media, seasonNumber: 1, episodeNumber: 1 }
      )
    },
    [startPartyPlayback]
  )

  // Host side of "any member can play a suggestion" (see PartyPanel's
  // queue Play button): a non-host member's play-request arrives here
  // exactly like the nowPlaying unwrap above, then starts for real via
  // the normal startPartyPlayback — so it's announced to everyone else
  // the same as if the host had picked it themselves.
  useEffect(() => {
    if (partyStatus?.role !== 'host') return
    const api = window.api?.mediaHub?.party
    if (!api) return
    return api.onEvent((event) => {
      if (event.type !== 'play-request') return
      const catalogApi = window.api?.mediaHub?.catalog
      if (!catalogApi || !event.item.id || !event.item.type) return
      catalogApi
        .meta(event.item.type as MediaKind, event.item.id)
        .then(startSuggestedPlayback)
        .catch(() => {
          pushNotification({ tone: 'error', message: "Couldn't load that suggestion." })
        })
    })
  }, [partyStatus, startSuggestedPlayback, pushNotification])

  const setPartyMemberControl = useCallback(async (allow: boolean) => {
    const api = window.api?.mediaHub?.party
    if (!api) return
    await api.setMemberControl(allow)
  }, [])

  const requestPartyPlay = useCallback(
    async (item: { id: string; type: string; title: string; poster?: string }) => {
      const api = window.api?.mediaHub?.party
      if (!api) return
      if (partyStatus?.role === 'host') {
        const catalogApi = window.api?.mediaHub?.catalog
        if (!catalogApi) return
        try {
          const catalogItem = await catalogApi.meta(item.type as MediaKind, item.id)
          await startSuggestedPlayback(catalogItem)
        } catch {
          pushNotification({ tone: 'error', message: "Couldn't load that suggestion." })
        }
        return
      }
      await api.requestPlay(item)
    },
    [partyStatus, startSuggestedPlayback, pushNotification]
  )

  const consumePartyPendingSeek = useCallback(() => setPartyPendingSeek(null), [])

  const toggleCombinedMood = useCallback((moodId: string) => {
    setCombinedMoods((prev) =>
      prev.includes(moodId) ? prev.filter((m) => m !== moodId) : [...prev, moodId]
    )
  }, [])

  // Asks the local model the person connected in Settings (see
  // main/media-hub/ollamaService.ts). This used to resolve a hardcoded
  // sentence about Dune on a 1.1s timer no matter what was typed; there is
  // no canned answer left, and no model means it says so rather than
  // pretending. A slice of the browse catalog rides along as context so the
  // model can ground an answer in what this app can actually play.
  /**
   * The assistant field, end to end: search this app, then ask the model
   * about what was found.
   *
   * That order is the feature. Typing a title here used to produce three
   * sentences of prose and nothing else — the same answer a general chat
   * box would give, in an app that has the title, its poster, its episodes
   * and a play button. Now the catalog is searched first and its results
   * are what appears; the model's answer arrives underneath as commentary
   * on them, grounded in what this person has actually watched, and ends
   * by naming other titles which are themselves looked up so they can be
   * opened.
   *
   * The two halves are deliberately independent. The search needs no model
   * and lands in well under a second, so a question still gets a real
   * answer with Ollama absent, off, or thinking — the AI is what makes the
   * answer better, not what makes it exist.
   */
  const runAssistantQuery = useCallback(
    (query: string) => {
      const question = query.trim()
      const generation = ++assistantGeneration.current
      // Whatever was still generating is now answering a question that has
      // been replaced — stop it before starting another one, so a small
      // machine isn't running two models at once.
      abandonAssistantRequest()
      setAssistantQuery(query)
      setAssistantResponse(null)
      setAssistantFindings({ results: [], similar: [], similarSource: null, searching: false })

      if (!question) {
        setAssistantState('responding')
        setAssistantResponse("I didn't catch a question there — try a genre, a mood, or a title.")
        return
      }

      // Only the newest question's results may land. Every await below
      // re-checks this, because a slow catalog and a slow model can each
      // outlive the question that started them.
      const current = () => assistantGeneration.current === generation

      setAssistantState('processing')
      setAssistantFindings({ results: [], similar: [], similarSource: null, searching: true })

      void (async () => {
        // --- 1. The app's own answer, with no model involved ------------
        const found = await searchAppCatalog(question).catch((): CatalogItem[] => [])
        if (!current()) return
        setAssistantFindings({ results: found, similar: [], similarSource: null, searching: false })

        // --- 2. What the model makes of it ------------------------------
        // Asked unconditionally whenever the bridge exists, and NOT gated
        // on the settings snapshot's `ollamaConnected`.
        //
        // That snapshot is a cached answer to a question whose answer
        // changes on its own. Main looks for an Ollama at the default
        // address on the next question asked (ollamaService's
        // resolveConfig), which is exactly what makes "open R3, then start
        // Ollama" work — and short-circuiting here on a `false` recorded
        // before Ollama was running meant that retry could never happen.
        // The app would sit insisting no model was connected, with one
        // running, until Settings was opened or the app restarted.
        //
        // The round trip costs nothing when there really is no model: main
        // rate-limits its own probing and refuses immediately, and its
        // refusal is the authoritative version of the message this branch
        // used to guess at.
        const api = window.api?.mediaHub?.ollama
        if (!api) {
          // No bridge at all, so there is nothing to ask and nothing that
          // could answer later. The one case the renderer can settle by
          // itself.
          setAssistantState(found.length ? 'responding' : 'error')
          setAssistantResponse(
            found.length
              ? 'Connect a local model in Settings → AI and R3 will add what it makes of these.'
              : 'No local model is connected, and nothing in the catalog matched that.'
          )
          return
        }

        const requestId = `ask-${generation}`
        assistantRequestId.current = requestId
        let result: OllamaAskResult
        try {
          result = await api.ask(
            question,
            {
              matches: found.slice(0, 3).map(catalogItemToTitleRef),
              library: browseCatalog.items.slice(0, MAX_PROMPT_TITLES).map(mediaItemToTitleRef),
              watched: recentlyWatchedRefs(watchedIdsResult.history)
            },
            requestId
          )
          if (assistantRequestId.current === requestId) assistantRequestId.current = null
          // `cancelled` is main confirming it stopped; the generation check
          // covers the same case for anything already superseded here.
          if (result.cancelled || !current()) return
          setAssistantState('responding')
          setAssistantResponse(result.reply)
        } catch (error: unknown) {
          if (assistantRequestId.current === requestId) assistantRequestId.current = null
          if (!current()) return
          // The search results stay on screen and stay useful, so a model
          // that could not be reached downgrades the answer rather than
          // replacing it with a failure.
          setAssistantState(found.length ? 'responding' : 'error')
          setAssistantResponse(
            error instanceof Error
              ? error.message
              : 'That question did not get through to the model.'
          )
          return
        }

        // --- 3. Turn its suggestions into titles that open --------------
        // After the prose is on screen, never before: this is several more
        // catalog lookups, and holding the answer back until they finish
        // would add seconds to something already written.
        //
        // Outside the try above, and swallowing its own failures, because
        // this stage cannot be allowed to take the answer down with it —
        // catching it alongside the model call meant a catalog hiccup here
        // replaced three good sentences already on screen with an error.
        try {
          const suggested = await resolveSimilarTitles(
            result.similar ?? [],
            found.map((item) => String(item.id))
          )
          if (!current()) return
          // A model that named nothing this app has still leaves a useful
          // row: the catalog's own "more like this" for the top result.
          const similar = suggested.length ? suggested : await relatedToItem(found[0])
          if (!current() || !similar.length) return
          setAssistantFindings((state) => ({
            ...state,
            similar,
            similarSource: suggested.length ? 'model' : 'catalog'
          }))
        } catch {
          // No suggestions row. The answer above it stands.
        }
      })()
    },
    [browseCatalog.items, watchedIdsResult.history, abandonAssistantRequest]
  )

  // The backend itself requires >=2 characters (main/media-hub/catalog.ts's
  // catalogSearch handler returns [] below that) — mirrored here so the UI
  // can show "keep typing" rather than firing a request that's guaranteed
  // to come back empty.
  // Stores what the backend returned and nothing else — the mapping to
  // MediaItem happens in the memo above, so it stays current as watch state
  // moves underneath a search that is still on screen.
  const runCategorySearch = useCallback((kind: CategoryKind, query: string) => {
    const q = query.trim()
    const generation = ++searchGeneration.current
    if (q.length < 2) {
      setCategorySearchRaw({ kind, query, items: [], loading: false, error: false })
      return
    }
    setCategorySearchRaw({ kind, query, items: [], loading: true, error: false })
    const api = window.api?.mediaHub
    if (!api) {
      // No bridge (browser preview) — honest empty state, never a fake
      // result list standing in for a real search.
      setCategorySearchRaw({ kind, query, items: [], loading: false, error: true })
      return
    }
    api.catalog
      .search(kind, q)
      .then((items) => {
        if (searchGeneration.current !== generation) return
        setCategorySearchRaw({ kind, query, items, loading: false, error: false })
      })
      .catch(() => {
        if (searchGeneration.current !== generation) return
        setCategorySearchRaw({ kind, query, items: [], loading: false, error: true })
      })
  }, [])

  const clearCategorySearch = useCallback(() => {
    searchGeneration.current += 1
    setCategorySearchRaw({ kind: null, query: '', items: [], loading: false, error: false })
  }, [])

  const uiActivity = useMemo<UIActivityState>(() => {
    if (playbackMedia) return 'playing'
    if (assistantState === 'processing') return 'processing'
    if (assistantState === 'responding') return 'responding'
    if (assistantState === 'error') return 'error'
    return 'idle'
  }, [playbackMedia, assistantState])

  const value = useMemo<AppStateValue>(
    () => ({
      profiles,
      activeProfileId,
      profilePinPrompt,
      switchProfile,
      cancelProfilePinPrompt,
      createProfile,
      updateProfile,
      deleteProfile,
      partyStatus,
      partyQueue,
      partyChat,
      partyHostCode,
      partyWanAvailable,
      partyHostPort,
      partyPanelOpen,
      setPartyPanelOpen,
      refreshPartyStatus,
      hostParty,
      joinParty,
      leaveParty,
      suggestToParty,
      voteQueue,
      removeFromQueue,
      sendPartyChat,
      myList,
      plannedSources: homeFeed.plannedSources,
      toggleMyList,
      dislikedIds,
      toggleDisliked,
      ratings: ratingsResult.ratings,
      rateMedia: ratingsResult.rate,
      libraryKey,
      reloadLibrary,
      refreshProfiles,
      continueWatching,
      markContinueWatching,
      removeContinueWatching,
      catalog: browseCatalog.items,
      catalogLoading: browseCatalog.loading,
      catalogKindStates: browseCatalog.kindStates,
      refreshCatalog: browseCatalog.refresh,
      adaptCatalogItems,
      watchedIds: watchedIdsResult.watchedIds,
      recommendations: homeFeed.recommendations,
      featured: homeFeed.featured,
      homeFeedLive: homeFeed.live,
      homeFeedLoading: homeFeed.loading,
      homeFeedError: homeFeed.error,
      refreshHomeFeed: homeFeed.refresh,
      mediaHubSettings,
      refreshMediaHubSettings,
      assistantState,
      setAssistantState,
      assistantQuery,
      setAssistantQuery,
      assistantResponse,
      assistantResults,
      assistantSimilar,
      assistantSimilarSource: assistantFindings.similarSource,
      assistantSearching: assistantFindings.searching,
      runAssistantQuery,
      closeAssistant,
      categorySearch,
      runCategorySearch,
      clearCategorySearch,
      pushNotification,
      dismissNotification,
      browsingOrigin,
      openDetail,
      openPerson,
      popBrowsingOrigin,
      pendingRestore,
      clearPendingRestore,
      resolvingMedia,
      cancelPlaybackPreparation,
      playbackMedia,
      playbackResult,
      playbackTracks,
      setPlaybackResult,
      setPlaybackTracks,
      startPlayback,
      stopPlayback,
      refreshWatchStatus,
      watchStatusVersion,
      startPartyPlayback,
      partyPreparing,
      partyPendingSeek,
      consumePartyPendingSeek,
      setPartyMemberControl,
      requestPartyPlay,
      openContextMenu,
      closeContextMenu,
      activeMood,
      setActiveMood,
      combinedMoods,
      toggleCombinedMood,
      uiActivity,
      syncDiscrepancies,
      syncReviewOpen,
      controlCentreOpen,
      setSyncReviewOpen,
      setControlCentreOpen,
      resolveSyncDiscrepancy
    }),
    [
      profiles,
      activeProfileId,
      profilePinPrompt,
      switchProfile,
      cancelProfilePinPrompt,
      createProfile,
      updateProfile,
      deleteProfile,
      partyStatus,
      partyQueue,
      partyChat,
      partyHostCode,
      partyWanAvailable,
      partyHostPort,
      partyPanelOpen,
      refreshPartyStatus,
      hostParty,
      joinParty,
      leaveParty,
      suggestToParty,
      voteQueue,
      removeFromQueue,
      sendPartyChat,
      myList,
      homeFeed.plannedSources,
      toggleMyList,
      dislikedIds,
      toggleDisliked,
      ratingsResult.ratings,
      ratingsResult.rate,
      libraryKey,
      reloadLibrary,
      refreshProfiles,
      continueWatching,
      markContinueWatching,
      removeContinueWatching,
      browseCatalog.items,
      browseCatalog.loading,
      browseCatalog.kindStates,
      browseCatalog.refresh,
      adaptCatalogItems,
      watchedIdsResult.watchedIds,
      homeFeed.recommendations,
      homeFeed.featured,
      homeFeed.live,
      homeFeed.loading,
      homeFeed.error,
      homeFeed.refresh,
      mediaHubSettings,
      refreshMediaHubSettings,
      assistantState,
      assistantQuery,
      assistantResponse,
      assistantResults,
      assistantSimilar,
      assistantFindings.similarSource,
      assistantFindings.searching,
      runAssistantQuery,
      closeAssistant,
      categorySearch,
      runCategorySearch,
      clearCategorySearch,
      pushNotification,
      dismissNotification,
      browsingOrigin,
      openDetail,
      openPerson,
      popBrowsingOrigin,
      pendingRestore,
      clearPendingRestore,
      resolvingMedia,
      cancelPlaybackPreparation,
      playbackMedia,
      playbackResult,
      playbackTracks,
      setPlaybackResult,
      setPlaybackTracks,
      startPlayback,
      stopPlayback,
      refreshWatchStatus,
      watchStatusVersion,
      startPartyPlayback,
      partyPreparing,
      partyPendingSeek,
      consumePartyPendingSeek,
      setPartyMemberControl,
      requestPartyPlay,
      openContextMenu,
      closeContextMenu,
      activeMood,
      combinedMoods,
      toggleCombinedMood,
      uiActivity,
      syncDiscrepancies,
      syncReviewOpen,
      controlCentreOpen,
      resolveSyncDiscrepancy
    ]
  )

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>
}

// The provider component and its paired hook belong in one file (the
// standard React context pattern); splitting them only to satisfy Fast
// Refresh would cost more (an extra file, an extra import everywhere this
// hook is used) than the dev-mode-only HMR nicety this rule protects is
// worth.
// eslint-disable-next-line react-refresh/only-export-components
export function useAppState() {
  const ctx = useContext(AppStateContext)
  if (!ctx) throw new Error('useAppState must be used within AppStateProvider')
  return ctx
}
