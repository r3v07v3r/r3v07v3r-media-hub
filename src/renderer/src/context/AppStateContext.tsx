'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  AppNotification,
  AssistantState,
  ContinueWatchingItem,
  MediaItem,
  Recommendation,
  UIActivityState
} from '@renderer/types'
import { CONTINUE_WATCHING, USER_PROFILES } from '@renderer/data/mockData'
import type { MediaHubSettingsSnapshot } from '@shared/media-hub/types'
import {
  mediaItemToTrackablePayload,
  catalogItemToMediaItem
} from '@renderer/lib/mediaHub/adapters'
import { useMediaHubBrowseCatalog, useMediaHubHomeFeed } from '@renderer/lib/mediaHub/hooks'
import type { CategoryKind } from '@renderer/lib/mediaHub/categoryFilters'

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

  // Overlays — kept centrally so only one of each can be open at a time
  // and any component (card, hero, continue-watching row) can trigger
  // them.
  detailMedia: MediaItem | null
  openDetail: (media: MediaItem) => void
  closeDetail: () => void

  playbackMedia: MediaItem | null
  startPlayback: (media: MediaItem) => void
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
  const [activeProfileId, setActiveProfileId] = useState(USER_PROFILES[0].id)
  const [myList, setMyList] = useState<Set<string>>(new Set())
  const [continueWatching, setContinueWatching] =
    useState<ContinueWatchingItem[]>(CONTINUE_WATCHING)
  const homeFeed = useMediaHubHomeFeed()
  const browseCatalog = useMediaHubBrowseCatalog(myList)
  const [mediaHubSettings, setMediaHubSettings] = useState<MediaHubSettingsSnapshot | null>(null)
  const [assistantState, setAssistantState] = useState<AssistantState>('idle')
  const [assistantQuery, setAssistantQuery] = useState('')
  const [assistantResponse, setAssistantResponse] = useState<string | null>(null)
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [performancePanelVisible, setPerformancePanelVisible] = useState(true)
  const [detailMedia, setDetailMedia] = useState<MediaItem | null>(null)
  const [playbackMedia, setPlaybackMedia] = useState<MediaItem | null>(null)
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
        .then(() => homeFeed.refresh())
        .catch(() => {})
    },
    [continueWatching, homeFeed]
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

  const openDetail = useCallback((media: MediaItem) => {
    setDetailMedia(media)
    setContextMenu(null)
  }, [])
  const closeDetail = useCallback(() => setDetailMedia(null), [])

  // Playback gate (spec decision: keep the dashboard visible without a
  // TorBox connection, only gate actual playback). `mediaHubSettings ===
  // null` (bridge missing, or the first settings fetch hasn't resolved
  // yet) is treated as "allow" rather than "block" — PlaybackOverlay
  // itself degrades to a clear error state if it turns out there's no
  // real backend to resolve a stream from, which is a better first
  // impression than silently refusing to open at all.
  const startPlayback = useCallback(
    (media: MediaItem) => {
      if (mediaHubSettings && !mediaHubSettings.torboxConnected) {
        pushNotification({
          tone: 'warning',
          message: 'Connect TorBox in Settings to start playback.'
        })
        return
      }
      setPlaybackMedia(media)
      setDetailMedia(null)
      setContextMenu(null)
    },
    [mediaHubSettings, pushNotification]
  )
  const stopPlayback = useCallback(() => setPlaybackMedia(null), [])

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
      detailMedia,
      openDetail,
      closeDetail,
      playbackMedia,
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
      detailMedia,
      openDetail,
      closeDetail,
      playbackMedia,
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
