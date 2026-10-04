// The one place this app reads window.api. Every screen goes through
// `api()` and `useAsync` rather than touching window.api directly, so "no
// backend" (never installed, or dropped mid-session) is handled once
// instead of once per screen.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DependencyList,
  type Dispatch,
  type SetStateAction
} from 'react'
import { createApi, type Api } from '../../preload/api'
import { createWebSocketTransport } from '../../renderer/src/web/transport'

export type MediaHubApi = Api['mediaHub']

/** `window.api.mediaHub`, or null when there is nothing to call — no
 *  bridge marker on this page at all, or (in principle) a preload/bridge
 *  that installed `api` without the mediaHub group. Screens treat null as
 *  "show it can't be done right now", never as a reason to throw. */
export function api(): MediaHubApi | null {
  return window.api?.mediaHub ?? null
}

export interface AsyncState<T> {
  data: T | null
  error: Error | null
  loading: boolean
  reload: () => void
  /** Fetch again behind what is on screen — see useAsync. */
  refresh: () => void
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

interface AsyncSnapshot<T> {
  data: T | null
  error: Error | null
  loading: boolean
}

/** useAsync's refs, handed to the two functions below. They live outside the
 *  hook so they can call each other without either being a hook value. */
interface FetchSlot<T> {
  /** Bumped by every load and every unmount; a fetch whose generation is no
   *  longer current is stale and lands nowhere. */
  generation: { current: number }
  /** A fetch for the current generation is running. */
  running: { current: boolean }
  /** A refresh is waiting for that fetch to finish. */
  queued: { current: boolean }
  latestFn: { current: () => Promise<unknown> }
  setState: Dispatch<SetStateAction<AsyncSnapshot<T>>>
}

/** A fetch for generation `mine` has finished: start the one refresh that
 *  was waiting on it, if any. */
function settleFetch<T>(slot: FetchSlot<T>, mine: number): void {
  if (slot.generation.current !== mine) return
  slot.running.current = false
  if (!slot.queued.current) return
  slot.queued.current = false
  startRefresh(slot, mine)
}

function startRefresh<T>(slot: FetchSlot<T>, mine: number): void {
  slot.running.current = true
  // A Promise constructor so an `fn` that throws instead of rejecting still
  // settles, rather than leaving `running` stuck on.
  new Promise<T>((resolve) => resolve(slot.latestFn.current() as Promise<T>))
    .then(
      (data) => {
        if (slot.generation.current !== mine) return
        slot.setState({ data, error: null, loading: false })
      },
      (error: unknown) => {
        if (slot.generation.current !== mine) return
        slot.setState((previous) =>
          previous.data !== null
            ? { ...previous, error: null }
            : { ...previous, error: asError(error), loading: false }
        )
      }
    )
    .finally(() => settleFetch(slot, mine))
}

/**
 * Runs `fn` on mount, again whenever `deps` change, and again on demand via
 * the returned `reload()` or `refresh()`.
 *
 * Ignores stale results: if `deps` change (or the component unmounts)
 * before a call resolves, that answer is dropped instead of clobbering a
 * newer one — the classic "typed ahead, an old page came back" bug, guarded
 * the same way this codebase's own data hooks guard it (see
 * src/renderer/src/lib/mediaHub/hooks.ts's `cancelled` flags).
 *
 * `reload()` starts over: the screen goes back to loading. `refresh()` is
 * for the background — the library changed somewhere else and the screen
 * should catch up — so it never clears what is showing. A refresh that
 * answers replaces `data`; one that fails keeps the old `data` and reports
 * no error, because a good screen blanked by a background fetch that
 * happened to fail is worse than one a minute out of date.
 *
 * A refresh asked for while a fetch is already running does not cancel it:
 * that fetch finishes and renders, then exactly one more runs. Library
 * changes arrive in bursts (a catch-up announces, then the recommendations
 * rebuild announces), and restarting on each would keep throwing away a slow
 * Home that was nearly done, so nothing would ever arrive.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [state, setState] = useState<AsyncSnapshot<T>>({
    data: null,
    error: null,
    loading: true
  })
  const [tick, setTick] = useState(0)
  const generation = useRef(0)
  const running = useRef(false)
  const queued = useRef(false)
  // A refresh runs outside any render, so it needs the newest `fn` — the
  // one closing over the newest props — rather than the one from whichever
  // render created `refresh`.
  const latestFn = useRef<() => Promise<unknown>>(fn)
  useEffect(() => {
    latestFn.current = fn
  })

  useEffect(() => {
    let cancelled = false
    const slot: FetchSlot<T> = { generation, running, queued, latestFn, setState }
    const mine = ++generation.current
    running.current = true
    // A refresh queued against the previous deps is answered by this load.
    queued.current = false
    // A refetch (deps changed, or reload() was called) genuinely IS
    // "loading" again — see hooks.ts's identical reasoning for the same
    // disable.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((previous) => ({ ...previous, loading: true, error: null }))
    fn()
      .then((data) => {
        if (cancelled || generation.current !== mine) return
        setState({ data, error: null, loading: false })
      })
      .catch((error: unknown) => {
        if (cancelled || generation.current !== mine) return
        setState({ data: null, error: asError(error), loading: false })
      })
      .finally(() => {
        if (!cancelled) settleFetch(slot, mine)
      })
    const generations = generation
    return () => {
      cancelled = true
      // Unmounting (or new deps) also strands any refresh still running
      // for this generation, so it can neither land nor queue another.
      generations.current += 1
    }
    // `fn` is intentionally not a dependency: the caller's `deps` names
    // everything `fn` actually reads (the same contract useEffect/useMemo
    // already ask of every caller), and putting a freshly-created closure
    // in here would refetch on every render instead of only when `deps`
    // changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])

  const reload = useCallback(() => setTick((t) => t + 1), [])

  const refresh = useCallback(() => {
    if (running.current) {
      queued.current = true
      return
    }
    startRefresh({ generation, running, queued, latestFn, setState }, generation.current)
  }, [])

  return { ...state, reload, refresh }
}

let overlay: MediaHubApi | null = null

/**
 * The player's own connection: the 'overlay' scope, which is where the
 * backend pushes player state (on the desktop that scope is the controls
 * window; in the Android app it is the player screen — see
 * main/media-hub/playerWindow.ts's HOST MODE). Opened on first use and kept:
 * it is idle between sessions, and a transport cannot be closed.
 */
export function overlayApi(): MediaHubApi | null {
  if (overlay) return overlay
  if (!api()) return null
  overlay = createApi(createWebSocketTransport('overlay')).mediaHub
  return overlay
}
