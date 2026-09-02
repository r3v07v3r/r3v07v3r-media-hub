// State for the player-overlay window.
//
// This is the overlay window's replacement for AppStateContext. The overlay is
// a separate renderer process (see main/media-hub/playerWindow.ts for why the
// controls cannot live in the main window), so it has no access to the main
// window's React tree. Everything it needs arrives over IPC instead: mpv's own
// properties on `player.onState`, and the session/settings/party snapshot on
// `player.onSession`.
//
// What this replaces is worth naming, because it is most of why the old player
// was hard to reason about. Position, duration, paused, volume and buffering
// used to be read straight off the <video> element, and during compatibility
// mode every one of those readings was relative to the current transcode
// segment — so the real value was `streamStartOffsetRef.current + video.X`, and
// getting that wrong desynced subtitles, the scrub bar, and the saved resume
// position all at once. mpv reports absolute values against one continuous
// timeline, so there is no offset here to forget.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'

import type {
  PlayerCommand,
  PlayerCommandResult,
  PlayerSessionSnapshot,
  PlayerStatePatch,
  PlayerUiEvent
} from '@shared/media-hub/player'

export interface PlayerWindowValue {
  /** Which title is playing, its tracks, and the settings that affect
   *  playback. Null until the first snapshot arrives. */
  session: PlayerSessionSnapshot | null
  /** Accumulated mpv state. Patches are merged, so a key absent from a patch
   *  keeps its previous value rather than becoming undefined. */
  state: PlayerStatePatch
  /** Sends a player operation to mpv. Rejections are surfaced as a toast in
   *  the main window rather than thrown at the caller — a failed volume change
   *  should not take the player UI down with it. Resolves to undefined on
   *  that failure path; a caller that needs the result (screenshot's saved
   *  path, currently the only one) checks for that before reading it. */
  command: (command: PlayerCommand) => Promise<PlayerCommandResult | undefined>
  /** Raises an action handled by the main window (close, toast, mark watched). */
  ui: (event: PlayerUiEvent) => void
  /** Reports the controls' reveal edge. The window takes mouse input for the
   *  whole session regardless; main uses this to decide when the keyboard
   *  should follow the controls. */
  setInteractive: (interactive: boolean) => void
}

const PlayerWindowContext = createContext<PlayerWindowValue | null>(null)

export function PlayerWindowProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<PlayerSessionSnapshot | null>(null)
  const [state, setState] = useState<PlayerStatePatch>({})

  const applyPatch = useCallback((patch: PlayerStatePatch) => {
    // Merge, never replace: patches are partial by contract.
    setState((previous) => ({ ...previous, ...patch }))
  }, [])

  useEffect(() => {
    const api = window.api?.mediaHub?.player
    if (!api) return
    // The overlay window is created as part of starting playback, so by the
    // time this mounts the session already exists — pull it rather than wait
    // for a change that may not come until the user does something.
    api
      .snapshot()
      .then(({ session: initialSession, state: initialState }) => {
        if (initialSession) setSession(initialSession)
        applyPatch(initialState)
      })
      .catch(() => {
        // A snapshot that fails is recoverable: the next pushed patch or
        // session update fills the gap. Failing loudly here would replace a
        // brief cold UI with a dead one.
      })
    const offState = api.onState(applyPatch)
    const offSession = api.onSession(setSession)
    return () => {
      offState()
      offSession()
    }
  }, [applyPatch])

  const ui = useCallback((event: PlayerUiEvent) => {
    window.api?.mediaHub?.player?.uiEvent(event).catch(() => {})
  }, [])

  const command = useCallback(
    async (playerCommand: PlayerCommand): Promise<PlayerCommandResult | undefined> => {
      try {
        return await window.api?.mediaHub?.player?.command(playerCommand)
      } catch (error) {
        ui({
          tone: 'error',
          type: 'notify',
          message: error instanceof Error ? error.message : 'That playback action failed.'
        })
        return undefined
      }
    },
    [ui]
  )

  // Only tell main when the value actually flips. setIgnoreMouseEvents is a
  // native call on every invocation, and the controls-visibility timer this is
  // driven from fires far more often than the value changes.
  const interactiveRef = useRef<boolean | null>(null)
  const setInteractive = useCallback(
    (interactive: boolean) => {
      if (interactiveRef.current === interactive) return
      interactiveRef.current = interactive
      ui({ type: 'set-interactive', interactive })
    },
    [ui]
  )

  const value = useMemo<PlayerWindowValue>(
    () => ({ session, state, command, ui, setInteractive }),
    [session, state, command, ui, setInteractive]
  )

  return <PlayerWindowContext.Provider value={value}>{children}</PlayerWindowContext.Provider>
}

// Same trade-off AppStateContext already makes for useAppState: splitting the
// hook into its own file to satisfy Fast Refresh costs an extra module and an
// extra import at every call site, for a dev-mode-only HMR nicety.
// eslint-disable-next-line react-refresh/only-export-components
export function usePlayerWindow(): PlayerWindowValue {
  const value = useContext(PlayerWindowContext)
  if (!value) throw new Error('usePlayerWindow must be used inside a PlayerWindowProvider')
  return value
}
