'use client'

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import {
  AppNotification,
  AssistantState,
  ContinueWatchingItem,
  MediaItem,
  UIActivityState
} from '@renderer/types'
import { CONTINUE_WATCHING, USER_PROFILES } from '@renderer/data/mockData'

interface AppStateValue {
  // Profiles
  profiles: typeof USER_PROFILES
  activeProfileId: string
  setActiveProfileId: (id: string) => void

  // My List — a Set of media ids. Kept centrally so the hero, the
  // carousel, continue-watching, and the detail modal all agree on
  // whether something is saved.
  myList: Set<string>
  toggleMyList: (id: string) => void

  // Continue Watching — local, mutable copy of the mock data so "mark
  // watched/unwatched" and "remove from row" have somewhere to write.
  continueWatching: ContinueWatchingItem[]
  markContinueWatching: (id: string, watched: boolean) => void
  removeContinueWatching: (id: string) => void

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
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  const toggleMyList = useCallback((id: string) => {
    setMyList((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const markContinueWatching = useCallback((id: string, watched: boolean) => {
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
  }, [])

  const removeContinueWatching = useCallback((id: string) => {
    setContinueWatching((prev) => prev.filter((c) => c.media.id !== id))
  }, [])

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

  const startPlayback = useCallback((media: MediaItem) => {
    setPlaybackMedia(media)
    setDetailMedia(null)
    setContextMenu(null)
  }, [])
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
      assistantState,
      setAssistantState,
      assistantQuery,
      setAssistantQuery,
      assistantResponse,
      runAssistantQuery,
      closeAssistant,
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
      assistantState,
      assistantQuery,
      assistantResponse,
      runAssistantQuery,
      closeAssistant,
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
