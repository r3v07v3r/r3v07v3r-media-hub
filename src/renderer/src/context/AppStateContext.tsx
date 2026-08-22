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
import { CONTINUE_WATCHING, USER_PROFILES } from '@renderer/data/mockData'
import type {
  CatalogItem,
  MediaHubSettingsSnapshot,
  MediaKind,
  MediaTracks,
  PartyHostResult,
  PartyMode,
  PartyQueueEntry,
  PartyStatusResult,
  PlaybackResult,
  ProfilePublic,
  ReconcileResolution,
  WatchStatusDiscrepancy
} from '@shared/media-hub/types'
import {
  mediaItemToTrackablePayload,
  catalogItemToMediaItem
} from '@renderer/lib/mediaHub/adapters'
import {
  PlaybackPreparationCancelledError,
  playbackPreparationErrorMessage,
  runPlaybackPreparationStage,
  type PlaybackPreparationStage
} from '@renderer/lib/mediaHub/playbackPreparation'
import {
  useMediaHubBrowseCatalog,
  useMediaHubDislikedIds,
  useMediaHubHomeFeed,
  useMediaHubWatchedIds
} from '@renderer/lib/mediaHub/hooks'
import type { CategoryKind } from '@renderer/lib/mediaHub/categoryFilters'
import { buildMediaId } from '@renderer/lib/mediaHub/streamId'
import {
  captureBrowsingOrigin,
  deriveBrowsingLabel,
  type BrowsingOrigin
} from '@renderer/lib/mediaHub/browsingContext'
import { useOverlayActions } from '@renderer/context/OverlayContext'

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
  hostParty: (name: string, mode?: PartyMode) => Promise<PartyHostResult>
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

  // My List — a Set of media ids. Kept centrally so the hero, the
  // carousel, continue-watching, and the detail modal all agree on
  // whether something is saved. Backed by the media-hub backend's local
  // tracking store (tracking:toggle) when window.api.mediaHub is
  // available — see the media-hub feed effect below — with an
  // optimistic local update on toggle so the UI doesn't wait on the IPC
  // round trip.
  myList: Set<string>
  toggleMyList: (media: MediaItem) => void

  // "Not interested" — mirrors myList's shape/optimistic-update pattern
  // exactly, backed by the media-hub backend's local disliked store
  // (disliked:add/remove) instead of tracking:toggle. Drives
  // MediaItem.disliked (see adapters.ts) and the Hide Disliked filter.
  dislikedIds: Set<string>
  toggleDisliked: (media: MediaItem) => void

  // Continue Watching — seeded from the media-hub backend's
  // home:personalized (episode-level watch tracking, not a mock array —
  // see hooks.ts's useMediaHubHomeFeed) when available, else the mock
  // CONTINUE_WATCHING placeholder so the panel is never empty before a
  // backend connection exists. "mark watched/unwatched" and "remove from
  // row" write through to the real tracking:mark-watched/tracking:toggle
  // handlers (best-effort — local state updates immediately either way).
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
  resolveSyncDiscrepancy: (
    discrepancy: WatchStatusDiscrepancy,
    resolution: ReconcileResolution
  ) => void

  // The flat "browse everything" pool (movies + series + anime, real
  // catalog:list data when available, mockData's CATALOG fallback
  // otherwise — see hooks.ts's useMediaHubBrowseCatalog) — shared here so
  // MoodBrowser/My Stuff/the AI-recommend actions all fetch it once
  // instead of each mounting their own copy of the hook.
  catalog: MediaItem[]
  catalogLoading: boolean
  /** True once catalog:list has actually resolved live data — false means
   *  `catalog` is the mock CATALOG fallback (bridge missing, still
   *  loading, or every kind's fetch failed). See hooks.ts. */
  catalogLive: boolean
  catalogSettled: boolean
  refreshCatalog: () => void

  // home:personalized's recommendations/featured pool (see
  // useMediaHubHomeFeed) — `homeFeedLive` tells a consumer whether these
  // are real or should fall back to its own mock data, since (unlike
  // `catalog` above) there's no mock blended in here.
  recommendations: Recommendation[]
  featured: MediaItem[]
  homeFeedLive: boolean

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
  browsingOrigin: BrowsingOrigin | null
  /** `originLabelOverride`: only needed when opening a title from within
   *  another detail page — see the implementation's own comment. */
  openDetail: (media: MediaItem, originLabelOverride?: string) => void
  clearBrowsingOrigin: () => void

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

  isOffline: boolean
  setIsOffline: (v: boolean) => void

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
  const [partyHostCode, setPartyHostCode] = useState<string | null>(null)
  const [partyWanAvailable, setPartyWanAvailable] = useState<boolean | null>(null)
  const [partyHostPort, setPartyHostPort] = useState<number | null>(null)
  const [partyPanelOpen, setPartyPanelOpen] = useState(false)
  const [partyPendingSeek, setPartyPendingSeek] = useState<number | null>(null)
  const [partyPreparing, setPartyPreparing] = useState<{ title: string; poster: string } | null>(
    null
  )
  const [myList, setMyList] = useState<Set<string>>(new Set())
  const [dislikedIds, setDislikedIds] = useState<Set<string>>(new Set())
  const [continueWatching, setContinueWatching] =
    useState<ContinueWatchingItem[]>(CONTINUE_WATCHING)
  const homeFeed = useMediaHubHomeFeed()
  const watchedIdsResult = useMediaHubWatchedIds()
  const dislikedIdsResult = useMediaHubDislikedIds()
  const browseCatalog = useMediaHubBrowseCatalog(
    myList,
    watchedIdsResult.watchedIds,
    watchedIdsResult.history,
    dislikedIds
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
  const [browsingOrigin, setBrowsingOrigin] = useState<BrowsingOrigin | null>(null)
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
  const [isOffline, setIsOffline] = useState(false)
  const [categorySearch, setCategorySearch] = useState<AppStateValue['categorySearch']>({
    kind: null,
    query: '',
    results: [],
    loading: false,
    error: false
  })
  // The assistant's simulated think-time. A ref rather than state so a
  // second query replaces the first instead of racing it, and so an
  // unmount can cancel a pending one — the previous version was an
  // append-only array nothing ever read or cleared.
  const assistantTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Guards against an in-flight search resolving after a newer one
  // started (or after clearCategorySearch) — only the most recent call's
  // result is ever applied.
  const searchGeneration = useRef(0)

  // Seed myList/continueWatching from the real backend once
  // home:personalized actually resolves — before that (bridge missing,
  // still loading, or the fetch failed) both keep whatever they already
  // had, which is the empty Set / mock CONTINUE_WATCHING they were
  // initialized with, per "keep dashboard visible" (see hooks.ts).
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
      } else if (event.type === 'host-disconnected') {
        setPartyHostCode(null)
        setPartyWanAvailable(null)
        setPartyHostPort(null)
        refreshPartyStatus()
        // Found live: this silently dropped a member back to the "Host a
        // party / Join a party" form with zero indication anything had
        // happened — the analogous 'preparing-cancelled' failure below
        // already does the right thing here.
        pushNotification({ tone: 'warning', message: 'Lost connection to the party host.' })
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
        .then(() => homeFeed.refresh())
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
        .then(() => homeFeed.refresh())
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
    async (name: string, mode?: PartyMode) => {
      const api = window.api?.mediaHub?.party
      if (!api) throw new Error("Watch Party isn't available outside the desktop app.")
      const result = await api.host(name, mode)
      setPartyHostCode(result.code)
      setPartyWanAvailable(result.wanAvailable ?? false)
      setPartyHostPort(result.port ?? null)
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
    setPartyPanelOpen(false)
    setPartyStatus(null)
    setPartyQueue([])
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

  const closeAssistant = useCallback(() => {
    // Cancel the pending think-time too, or a closed assistant reopens
    // itself a second later with the answer to a question nobody is
    // waiting for any more.
    if (assistantTimer.current) {
      clearTimeout(assistantTimer.current)
      assistantTimer.current = null
    }
    setAssistantState('idle')
    setAssistantResponse(null)
    setAssistantQuery('')
  }, [])

  useEffect(() => {
    return () => {
      if (assistantTimer.current) clearTimeout(assistantTimer.current)
    }
  }, [])

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
      setBrowsingOrigin(captureBrowsingOrigin(route, label))
      closeContextMenu()
      navigate(mediaKindToDetailPath(media))
    },
    [location.pathname, location.search, categorySearch, activeMood, navigate, closeContextMenu]
  )
  const clearBrowsingOrigin = useCallback(() => setBrowsingOrigin(null), [])

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

  const startPlaybackRef = useRef<(media: MediaItem) => Promise<boolean>>(async () => false)
  const startPlayback = useCallback(
    async (media: MediaItem): Promise<boolean> => {
      if (mediaHubSettings && !mediaHubSettings.torboxConnected) {
        pushNotification({
          tone: 'warning',
          message: 'Connect TorBox in Settings to start playback.'
        })
        return false
      }
      const api = window.api?.mediaHub
      if (!api) {
        pushNotification({
          tone: 'error',
          message: "Playback isn't available outside the desktop app."
        })
        return false
      }
      closeContextMenu()
      cancelPlaybackPreparation()
      const generation = ++playbackPreparationGeneration.current
      const controller = new AbortController()
      playbackPreparationRef.current = { generation, controller }
      const isCurrent = (): boolean =>
        playbackPreparationRef.current?.generation === generation && !controller.signal.aborted
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
      setResolvingMedia({ id: media.id, title: media.title, stage: 'resolving' })
      try {
        const resolved = await runPlaybackPreparationStage(
          api.stream.resolve(kind, resolveId, media.title),
          'resolving',
          30_000,
          controller.signal
        )
        if (!isCurrent()) return false
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
          return false
        }
        setResolvingMedia({ id: media.id, title: media.title, stage: 'buffering' })
        const playTask = api.stream.play(resolved.best, mediaId, kind, resolveId, {
          catalogId: media.id,
          title: media.title,
          posterUrl: media.posterUrl,
          mediaKind: kind,
          seasonNumber: media.seasonNumber,
          episodeNumber: media.episodeNumber
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
        if (!isCurrent()) return false
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
        return true
      } catch (error) {
        if (error instanceof PlaybackPreparationCancelledError) return false
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
        return false
      } finally {
        if (playbackPreparationRef.current?.generation === generation) {
          playbackPreparationRef.current = null
          setResolvingMedia(null)
        }
      }
    },
    [mediaHubSettings, pushNotification, closeContextMenu, cancelPlaybackPreparation]
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
  // Outside playback both reports are no-ops on main's side — restackPlayer
  // returns without a running player, and there is no overlay to raise.
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
      const season = opts?.season ?? media.seasonNumber
      const episode = opts?.episode ?? media.episodeNumber
      const target = opts ? { ...media, seasonNumber: season, episodeNumber: episode } : media
      const partyApi = window.api?.mediaHub?.party
      const isHosting = !!partyApi && !!partyStatus?.inParty && partyStatus.role === 'host'
      const partyKind = media.mediaKind ?? (media.mediaType === 'series' ? 'series' : 'movie')
      // Announce BEFORE resolving, not after. startPlayback below is a
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
      const started = await startPlayback(target)
      if (!started) {
        // The host found no source, so no nowPlaying is ever coming —
        // release the followers rather than leaving them spinning.
        if (isHosting) partyApi.preparing({ item: null }).catch(() => {})
        return
      }
      const api = partyApi
      if (!api || !isHosting) return
      const kind = partyKind
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
    [startPlayback, partyStatus]
  )

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
      const catalogApi = window.api?.mediaHub?.catalog
      if (!catalogApi) return
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
              ? { ...media, seasonNumber: msg.season, episodeNumber: msg.episode }
              : media
          )
        })
        .catch(() => {
          pushNotification({ tone: 'error', message: "Couldn't load what the host is playing." })
        })
        // Cleared on EVERY outcome, not just success: startPlayback
        // resolves false for a no-source or TorBox-not-connected result
        // without throwing, and that path has to release the card too.
        .finally(() => setPartyPreparing(null))
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

  // Read through refs inside the join-request handler below, so that
  // subscription doesn't tear down and re-establish every time playback
  // position or settings change — it only cares about their values at the
  // moment a request actually arrives.
  const playbackMediaRef = useRef(playbackMedia)
  const hostPartyRef = useRef(hostParty)
  const mediaHubSettingsRef = useRef(mediaHubSettings)
  useEffect(() => {
    playbackMediaRef.current = playbackMedia
    hostPartyRef.current = hostParty
    mediaHubSettingsRef.current = mediaHubSettings
  }, [playbackMedia, hostParty, mediaHubSettings])

  // Answering "can I watch with you?" from a friend. Lives here rather
  // than in the friends UI because it needs the things only this context
  // has: whether we're actually playing something, and the ability to
  // start hosting.
  //
  // This is what makes a SOLO watcher joinable at all. Someone watching
  // alone has no party and therefore no code to publish, so a friend has
  // nothing to click — the party is created on demand, only when somebody
  // actually asks, rather than forcing everyone to host speculatively.
  useEffect(() => {
    const api = window.api?.mediaHub?.friends
    if (!api) return
    return api.onMessage((message) => {
      if (message.type !== 'friend-join-request') return
      const decline = (reason: string): void => {
        api
          .send({
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
          .send({
            type: 'friend-join-offer',
            toFriendId: message.fromFriendId,
            fromFriendId: '',
            partyCode: partyHostCode
          })
          .catch(() => {})
        return
      }
      if (partyStatus?.inParty) {
        decline("They're already in someone else's party.")
        return
      }
      hostPartyRef
        .current(mediaHubSettingsRef.current?.partyDisplayName || 'A friend', 'relay')
        .then((result) => {
          api
            .send({
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
        .catch(() => decline('They could not start a party just now.'))
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

  const runAssistantQuery = useCallback((query: string) => {
    setAssistantQuery(query)
    setAssistantState('processing')
    setAssistantResponse(null)
    if (assistantTimer.current) clearTimeout(assistantTimer.current)
    assistantTimer.current = setTimeout(() => {
      setAssistantState('responding')
      setAssistantResponse(
        query.trim()
          ? `Based on your history and current mood, I'd suggest something in Sci-Fi tonight — "Dune: Part Two" is a strong match for what you've been watching.`
          : `I didn't catch a question there — try asking about a genre, mood, or title.`
      )
    }, 1100)
  }, [])

  // The backend itself requires >=2 characters (main/media-hub/catalog.ts's
  // catalogSearch handler returns [] below that) — mirrored here so the UI
  // can show "keep typing" rather than firing a request that's guaranteed
  // to come back empty.
  const runCategorySearch = useCallback(
    (kind: CategoryKind, query: string) => {
      const q = query.trim()
      const generation = ++searchGeneration.current
      if (q.length < 2) {
        setCategorySearch({ kind, query, results: [], loading: false, error: false })
        return
      }
      setCategorySearch({ kind, query, results: [], loading: true, error: false })
      const api = window.api?.mediaHub
      if (!api) {
        // No bridge (browser preview) — honest empty state, never a fake
        // result list standing in for a real search.
        setCategorySearch({ kind, query, results: [], loading: false, error: true })
        return
      }
      api.catalog
        .search(kind, q)
        .then((items) => {
          if (searchGeneration.current !== generation) return
          setCategorySearch({
            kind,
            query,
            results: items.map((item) =>
              catalogItemToMediaItem(item, {
                trackedIds: myList,
                watchedIds: watchedIdsResult.watchedIds,
                history: watchedIdsResult.history,
                dislikedIds
              })
            ),
            loading: false,
            error: false
          })
        })
        .catch(() => {
          if (searchGeneration.current !== generation) return
          setCategorySearch({ kind, query, results: [], loading: false, error: true })
        })
    },
    [myList, watchedIdsResult.watchedIds, watchedIdsResult.history, dislikedIds]
  )

  const clearCategorySearch = useCallback(() => {
    searchGeneration.current += 1
    setCategorySearch({ kind: null, query: '', results: [], loading: false, error: false })
  }, [])

  const uiActivity = useMemo<UIActivityState>(() => {
    if (playbackMedia) return 'playing'
    if (assistantState === 'listening') return 'listening'
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
      myList,
      toggleMyList,
      dislikedIds,
      toggleDisliked,
      continueWatching,
      markContinueWatching,
      removeContinueWatching,
      catalog: browseCatalog.items,
      catalogLoading: browseCatalog.loading,
      catalogLive: browseCatalog.live,
      catalogSettled: browseCatalog.settled,
      refreshCatalog: browseCatalog.refresh,
      recommendations: homeFeed.recommendations,
      featured: homeFeed.featured,
      homeFeedLive: homeFeed.live,
      mediaHubSettings,
      refreshMediaHubSettings,
      assistantState,
      setAssistantState,
      assistantQuery,
      setAssistantQuery,
      assistantResponse,
      runAssistantQuery,
      closeAssistant,
      categorySearch,
      runCategorySearch,
      clearCategorySearch,
      pushNotification,
      dismissNotification,
      browsingOrigin,
      openDetail,
      clearBrowsingOrigin,
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
      isOffline,
      setIsOffline,
      uiActivity,
      syncDiscrepancies,
      syncReviewOpen,
      setSyncReviewOpen,
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
      myList,
      toggleMyList,
      dislikedIds,
      toggleDisliked,
      continueWatching,
      markContinueWatching,
      removeContinueWatching,
      browseCatalog.items,
      browseCatalog.loading,
      browseCatalog.live,
      browseCatalog.settled,
      browseCatalog.refresh,
      homeFeed.recommendations,
      homeFeed.featured,
      homeFeed.live,
      mediaHubSettings,
      refreshMediaHubSettings,
      assistantState,
      assistantQuery,
      assistantResponse,
      runAssistantQuery,
      closeAssistant,
      categorySearch,
      runCategorySearch,
      clearCategorySearch,
      pushNotification,
      dismissNotification,
      browsingOrigin,
      openDetail,
      clearBrowsingOrigin,
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
      isOffline,
      uiActivity,
      syncDiscrepancies,
      syncReviewOpen,
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
