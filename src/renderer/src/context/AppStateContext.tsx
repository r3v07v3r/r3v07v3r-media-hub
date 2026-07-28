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
import type { MediaHubSettingsSnapshot, MediaTracks, PlaybackResult } from '@shared/media-hub/types'
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

interface AppStateValue {
  // Profiles
  profiles: typeof USER_PROFILES
  activeProfileId: string
  setActiveProfileId: (id: string) => void

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
  startPlayback: (media: MediaItem) => Promise<void>
  stopPlayback: () => void

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
  const [activeProfileId, setActiveProfileId] = useState(USER_PROFILES[0].id)
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
    async (media: MediaItem) => {
      if (mediaHubSettings && !mediaHubSettings.torboxConnected) {
        pushNotification({
          tone: 'warning',
          message: 'Connect TorBox in Settings to start playback.'
        })
        return
      }
      const api = window.api?.mediaHub
      if (!api) {
        pushNotification({
          tone: 'error',
          message: "Playback isn't available outside the desktop app."
        })
        return
      }
      setContextMenu(null)
      const kind = media.mediaKind ?? (media.mediaType === 'series' ? 'series' : 'movie')
      const mediaId = buildMediaId(kind, media.id, media.seasonNumber, media.episodeNumber)
      setResolvingMedia({ id: media.id, stage: 'searching' })
      try {
        const resolved = await api.stream.resolve(kind, media.id)
        if (!resolved.best) {
          pushNotification({
            tone: 'error',
            message:
              'No cached sources were found for this title yet. TorBox needs a source to already be cached (or picked up shortly after) — try again in a bit.'
          })
          return
        }
        setResolvingMedia({ id: media.id, stage: 'buffering' })
        const played = await api.stream.play(resolved.best, mediaId)
        setPlaybackResult(played)
        setPlaybackTracks(played.tracks)
        setPlaybackMedia(media)
      } catch (error) {
        pushNotification({
          tone: 'error',
          message: error instanceof Error ? error.message : 'Playback failed to start.'
        })
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
      profiles: USER_PROFILES,
      activeProfileId,
      setActiveProfileId,
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
      activeProfileId,
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
