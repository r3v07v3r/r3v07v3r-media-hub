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
  MediaHubSettingsSnapshot,
  MediaKind,
  MediaTracks,
  PartyHostResult,
  PartyMode,
  PartyQueueEntry,
  PartyStatusResult,
  PlaybackResult,
  ProfilePublic
} from '@shared/media-hub/types'
import {
  mediaItemToTrackablePayload,
  catalogItemToMediaItem
} from '@renderer/lib/mediaHub/adapters'
import {
  useMediaHubBrowseCatalog,
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

  // Continue Watching — seeded from the media-hub backend's
  // home:personalized (episode-level watch tracking, not a mock array —
  // see hooks.ts's useMediaHubHomeFeed) when available, else the mock
  // CONTINUE_WATCHING placeholder so the panel is never empty before a
  // backend connection exists. "mark watched/unwatched" and "remove from
  // row" write through to the real tracking:mark-watched/tracking:toggle
  // handlers (best-effort — local state updates immediately either way).
  continueWatching: ContinueWatchingItem[]
  markContinueWatching: (id: string, watched: boolean) => void
  removeContinueWatching: (id: string) => void

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
  notifications: AppNotification[]
  pushNotification: (n: Omit<AppNotification, 'id' | 'createdAt'>) => void
  dismissNotification: (id: string) => void

  // Global "reduced visual chrome" toggle exposed via Settings, separate
  // from the OS prefers-reduced-motion signal.
  performancePanelVisible: boolean
  setPerformancePanelVisible: (v: boolean) => void

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
  resolvingMedia: { id: string; stage: 'searching' | 'buffering' } | null
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
  stopPlayback: () => void
  /** Same as startPlayback, but (host only) also announces the title to the party so followers resolve their own stream of it. */
  startPartyPlayback: (
    media: MediaItem,
    opts?: { season?: number; episode?: number }
  ) => Promise<void>
  /** Absolute position (seconds) a follower should seek to once their own independently-resolved stream is ready — set from an incoming `nowPlaying` announcement, consumed once by PlaybackOverlay. */
  partyPendingSeek: number | null
  consumePartyPendingSeek: () => void

  contextMenu: { x: number; y: number; media: MediaItem } | null
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

const AppStateContext = createContext<AppStateValue | null>(null)

let notifId = 0

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
  const [myList, setMyList] = useState<Set<string>>(new Set())
  const [continueWatching, setContinueWatching] =
    useState<ContinueWatchingItem[]>(CONTINUE_WATCHING)
  const homeFeed = useMediaHubHomeFeed()
  const watchedIdsResult = useMediaHubWatchedIds()
  const browseCatalog = useMediaHubBrowseCatalog(myList, watchedIdsResult.watchedIds)
  const [mediaHubSettings, setMediaHubSettings] = useState<MediaHubSettingsSnapshot | null>(null)
  const [assistantState, setAssistantState] = useState<AssistantState>('idle')
  const [assistantQuery, setAssistantQuery] = useState('')
  const [assistantResponse, setAssistantResponse] = useState<string | null>(null)
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [performancePanelVisible, setPerformancePanelVisible] = useState(true)
  const [browsingOrigin, setBrowsingOrigin] = useState<BrowsingOrigin | null>(null)
  const [resolvingMedia, setResolvingMedia] = useState<{
    id: string
    stage: 'searching' | 'buffering'
  } | null>(null)
  const [playbackMedia, setPlaybackMedia] = useState<MediaItem | null>(null)
  const [playbackResult, setPlaybackResult] = useState<PlaybackResult | null>(null)
  const [playbackTracks, setPlaybackTracks] = useState<MediaTracks | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; media: MediaItem } | null>(
    null
  )
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
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
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
    api
      .status()
      .then(setPartyStatus)
      .catch(() => {})
    api
      .queue()
      .then(({ queue }) => setPartyQueue(queue))
      .catch(() => {})
  }, [])

  useEffect(() => {
    const api = window.api?.mediaHub?.party
    if (!api) return
    refreshPartyStatus()
    return api.onEvent((event) => {
      if (event.type === 'party-state') {
        setPartyStatus((prev) => (prev ? { ...prev, members: event.members } : prev))
      } else if (event.type === 'queue-sync') {
        setPartyQueue(event.queue)
      } else if (event.type === 'host-disconnected') {
        setPartyHostCode(null)
        setPartyWanAvailable(null)
        setPartyHostPort(null)
        refreshPartyStatus()
      }
    })
  }, [refreshPartyStatus])

  const toggleMyList = useCallback((media: MediaItem) => {
    setMyList((prev) => {
      const next = new Set(prev)
      if (next.has(media.id)) next.delete(media.id)
      else next.add(media.id)
      return next
    })
    window.api?.mediaHub?.tracking.toggle(mediaItemToTrackablePayload(media)).catch(() => {
      // Best-effort — the optimistic local toggle above already reflects
      // the user's intent; a failed write just means it won't survive a
      // refresh, not a broken UI in the moment.
    })
  }, [])

  const markContinueWatching = useCallback(
    (id: string, watched: boolean) => {
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
      if (!api || !entry) return
      const item = mediaItemToTrackablePayload(entry.media)
      const playback = { season: entry.media.seasonNumber, episode: entry.media.episodeNumber }
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

  const pushNotification = useCallback((n: Omit<AppNotification, 'id' | 'createdAt'>) => {
    notifId += 1
    const id = `n-${notifId}`
    setNotifications((prev) => [...prev, { ...n, id, createdAt: Date.now() }])
    const t = setTimeout(() => {
      setNotifications((prev) => prev.filter((x) => x.id !== id))
    }, 4200)
    timers.current.push(t)
  }, [])

  const dismissNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((x) => x.id !== id))
  }, [])

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
    setAssistantState('idle')
    setAssistantResponse(null)
    setAssistantQuery('')
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
      setContextMenu(null)
      navigate(mediaKindToDetailPath(media))
    },
    [location.pathname, location.search, categorySearch, activeMood, navigate]
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
      setContextMenu(null)
      const kind = media.mediaKind ?? (media.mediaType === 'series' ? 'series' : 'movie')
      const mediaId = buildMediaId(kind, media.id, media.seasonNumber, media.episodeNumber)
      setResolvingMedia({ id: media.id, stage: 'searching' })
      try {
        const resolved = await api.stream.resolve(kind, media.id)
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
        setResolvingMedia({ id: media.id, stage: 'buffering' })
        const played = await api.stream.play(resolved.best, mediaId)
        setPlaybackResult(played)
        setPlaybackTracks(played.tracks)
        setPlaybackMedia(media)
        // Video is only ever stream-copied (see vlc.ts's videoCodecCompatibilityWarning) —
        // surfaced upfront so a decode failure minutes in isn't the first anyone hears of it.
        if (played.videoCodecWarning) {
          pushNotification({ tone: 'warning', message: played.videoCodecWarning })
        }
        return true
      } catch (error) {
        pushNotification({
          tone: 'error',
          message: error instanceof Error ? error.message : 'Playback failed to start.'
        })
        return false
      } finally {
        setResolvingMedia(null)
      }
    },
    [mediaHubSettings, pushNotification]
  )
  const stopPlayback = useCallback(() => {
    setPlaybackMedia(null)
    setPlaybackResult(null)
    setPlaybackTracks(null)
  }, [])

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
      const started = await startPlayback(target)
      if (!started) return
      const api = window.api?.mediaHub?.party
      if (!api || !partyStatus?.inParty || partyStatus.role !== 'host') return
      const kind = media.mediaKind ?? (media.mediaType === 'series' ? 'series' : 'movie')
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
      if (msg?.type !== 'nowPlaying' || !msg.item?.id || !msg.item.type) return
      const catalogApi = window.api?.mediaHub?.catalog
      if (!catalogApi) return
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
    })
  }, [partyStatus, startPlayback, pushNotification])

  const consumePartyPendingSeek = useCallback(() => setPartyPendingSeek(null), [])

  const openContextMenu = useCallback(
    (x: number, y: number, media: MediaItem) => setContextMenu({ x, y, media }),
    []
  )
  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  const toggleCombinedMood = useCallback((moodId: string) => {
    setCombinedMoods((prev) =>
      prev.includes(moodId) ? prev.filter((m) => m !== moodId) : [...prev, moodId]
    )
  }, [])

  const runAssistantQuery = useCallback((query: string) => {
    setAssistantQuery(query)
    setAssistantState('processing')
    setAssistantResponse(null)
    const t1 = setTimeout(() => {
      setAssistantState('responding')
      setAssistantResponse(
        query.trim()
          ? `Based on your history and current mood, I'd suggest something in Sci-Fi tonight — "Dune: Part Two" is a strong match for what you've been watching.`
          : `I didn't catch a question there — try asking about a genre, mood, or title.`
      )
    }, 1100)
    timers.current.push(t1)
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
            results: items.map((item) => catalogItemToMediaItem(item, { trackedIds: myList })),
            loading: false,
            error: false
          })
        })
        .catch(() => {
          if (searchGeneration.current !== generation) return
          setCategorySearch({ kind, query, results: [], loading: false, error: true })
        })
    },
    [myList]
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
      notifications,
      pushNotification,
      dismissNotification,
      performancePanelVisible,
      setPerformancePanelVisible,
      browsingOrigin,
      openDetail,
      clearBrowsingOrigin,
      resolvingMedia,
      playbackMedia,
      playbackResult,
      playbackTracks,
      setPlaybackResult,
      setPlaybackTracks,
      startPlayback,
      stopPlayback,
      startPartyPlayback,
      partyPendingSeek,
      consumePartyPendingSeek,
      contextMenu,
      openContextMenu,
      closeContextMenu,
      activeMood,
      setActiveMood,
      combinedMoods,
      toggleCombinedMood,
      isOffline,
      setIsOffline,
      uiActivity
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
      notifications,
      pushNotification,
      dismissNotification,
      performancePanelVisible,
      browsingOrigin,
      openDetail,
      clearBrowsingOrigin,
      resolvingMedia,
      playbackMedia,
      playbackResult,
      playbackTracks,
      setPlaybackResult,
      setPlaybackTracks,
      startPlayback,
      stopPlayback,
      startPartyPlayback,
      partyPendingSeek,
      consumePartyPendingSeek,
      contextMenu,
      openContextMenu,
      closeContextMenu,
      activeMood,
      combinedMoods,
      toggleCombinedMood,
      isOffline,
      uiActivity
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
