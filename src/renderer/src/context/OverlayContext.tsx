'use client'

// Transient overlay state — toasts and the card context menu — kept out of
// AppStateContext.
//
// Those two are the highest-frequency state changes in the app and the ones
// with the smallest audience: exactly two components render them. They used
// to live in the same context value as the catalog, the party, the profiles
// and playback, behind an 83-field object with a 77-entry dependency array.
// Since a React context re-renders every consumer whenever its value
// changes, and this renderer has no React.memo boundaries anywhere, opening
// a card's "…" menu or showing a toast re-rendered all 43 useAppState()
// call sites — and MediaCard subscribes once per card, so on a browse grid
// that is hundreds of components walking their subtrees to display one small
// menu.
//
// Split in two on purpose:
//
//   OverlayActionsContext — push/dismiss/open/close. Every one is a stable
//     useCallback and the value is memoised with an empty dependency list,
//     so this context NEVER changes after mount. Components that only want
//     to fire a toast (there are eight) subscribe to it and are never
//     re-rendered by one.
//
//   OverlayStateContext — the notifications array and the open menu. This
//     changes constantly, and only NotificationLayer and ContextMenu read
//     it.
//
// AppStateProvider consumes the actions half and re-exports those four
// functions in its own value, so `useAppState().pushNotification` keeps
// working everywhere it already did. That costs nothing: stable callbacks
// can sit in the value memo's dependency array without ever invalidating it.
//
// This provider therefore has to sit ABOVE AppStateProvider — several of
// AppStateProvider's own handlers (startPlayback, party events, profile
// switching) push notifications during their work.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { AppNotification, MediaItem } from '@renderer/types'

/** How long a toast stays on screen before it removes itself. */
const NOTIFICATION_TTL_MS = 4200
/** Errors get longer: they are read after the fact, not glanced at. */
const ERROR_TTL_MS = 10_000

/**
 * When a toast removes itself, or null for one that waits to be dismissed.
 *
 * An error that offers an action — "Couldn't start playback. Retry" — used
 * to vanish on the same 4.2s timer as "Synced 3 titles", taking its only
 * Retry with it. Two seconds of that were spent looking at a spinner, so
 * what a person saw was a Play button that did nothing and no explanation
 * anywhere. Such a toast now stays until the action is taken or it is
 * dismissed with its own close control (NotificationLayer offers one).
 */
function notificationTtlMs(notification: Pick<AppNotification, 'tone' | 'action'>): number | null {
  if (notification.tone !== 'error') return NOTIFICATION_TTL_MS
  return notification.action ? null : ERROR_TTL_MS
}

export interface ContextMenuTarget {
  x: number
  y: number
  media: MediaItem
}

export interface OverlayActions {
  pushNotification: (notification: Omit<AppNotification, 'id' | 'createdAt'>) => void
  dismissNotification: (id: string) => void
  openContextMenu: (x: number, y: number, media: MediaItem) => void
  closeContextMenu: () => void
}

export interface OverlayState {
  notifications: AppNotification[]
  contextMenu: ContextMenuTarget | null
}

const OverlayActionsContext = createContext<OverlayActions | null>(null)
const OverlayStateContext = createContext<OverlayState | null>(null)

let notificationSeq = 0

export function OverlayProvider({ children }: { children: React.ReactNode }) {
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [contextMenu, setContextMenu] = useState<ContextMenuTarget | null>(null)

  // Pending auto-dismiss timers, so an unmount doesn't leave them running
  // against a gone component. The version of this in AppStateContext was
  // push-only — nothing ever read the array or cleared a timer — so it grew
  // for the life of the app and cancelled nothing.
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const dismissNotification = useCallback((id: string) => {
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
    setNotifications((prev) => prev.filter((x) => x.id !== id))
  }, [])

  const pushNotification = useCallback(
    (notification: Omit<AppNotification, 'id' | 'createdAt'>) => {
      notificationSeq += 1
      const id = `n-${notificationSeq}`
      setNotifications((prev) => [...prev, { ...notification, id, createdAt: Date.now() }])
      const ttl = notificationTtlMs(notification)
      if (ttl === null) return
      const timer = setTimeout(() => {
        timers.current.delete(id)
        setNotifications((prev) => prev.filter((x) => x.id !== id))
      }, ttl)
      timers.current.set(id, timer)
    },
    []
  )

  const openContextMenu = useCallback(
    (x: number, y: number, media: MediaItem) => setContextMenu({ x, y, media }),
    []
  )
  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  useEffect(() => {
    const pending = timers.current
    return () => {
      pending.forEach((timer) => clearTimeout(timer))
      pending.clear()
    }
  }, [])

  // Empty dependency list is the whole point — every member is a
  // useCallback with no dependencies of its own, so this object is created
  // once and no consumer of it ever re-renders because of a toast.
  const actions = useMemo<OverlayActions>(
    () => ({ pushNotification, dismissNotification, openContextMenu, closeContextMenu }),
    [pushNotification, dismissNotification, openContextMenu, closeContextMenu]
  )

  const state = useMemo<OverlayState>(
    () => ({ notifications, contextMenu }),
    [notifications, contextMenu]
  )

  return (
    <OverlayActionsContext.Provider value={actions}>
      <OverlayStateContext.Provider value={state}>{children}</OverlayStateContext.Provider>
    </OverlayActionsContext.Provider>
  )
}

/** Fire a toast or open a menu. Subscribing to this never causes a
 *  re-render — the value is created once. */
// eslint-disable-next-line react-refresh/only-export-components
export function useOverlayActions(): OverlayActions {
  const ctx = useContext(OverlayActionsContext)
  if (!ctx) throw new Error('useOverlayActions must be used within OverlayProvider')
  return ctx
}

/** Read what is currently on screen. Only the two components that actually
 *  render overlays should call this. */
// eslint-disable-next-line react-refresh/only-export-components
export function useOverlayState(): OverlayState {
  const ctx = useContext(OverlayStateContext)
  if (!ctx) throw new Error('useOverlayState must be used within OverlayProvider')
  return ctx
}
