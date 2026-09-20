// The one place this app reads window.api. Every screen goes through
// `api()` and `useAsync` rather than touching window.api directly, so "no
// backend" (never installed, or dropped mid-session) is handled once
// instead of once per screen.
import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react'
import type { Api } from '../../preload/api'

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
}

/**
 * Runs `fn` on mount, again whenever `deps` change, and again on demand via
 * the returned `reload()`.
 *
 * Ignores stale results: if `deps` change (or the component unmounts)
 * before a call resolves, that answer is dropped instead of clobbering a
 * newer one — the classic "typed ahead, an old page came back" bug, guarded
 * the same way this codebase's own data hooks guard it (see
 * src/renderer/src/lib/mediaHub/hooks.ts's `cancelled` flags).
 */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [state, setState] = useState<{ data: T | null; error: Error | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true
  })
  const [tick, setTick] = useState(0)
  const generation = useRef(0)

  useEffect(() => {
    let cancelled = false
    const mine = ++generation.current
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
        setState({
          data: null,
          error: error instanceof Error ? error : new Error(String(error)),
          loading: false
        })
      })
    return () => {
      cancelled = true
    }
    // `fn` is intentionally not a dependency: the caller's `deps` names
    // everything `fn` actually reads (the same contract useEffect/useMemo
    // already ask of every caller), and putting a freshly-created closure
    // in here would refetch on every render instead of only when `deps`
    // changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])

  const reload = useCallback(() => setTick((t) => t + 1), [])

  return { ...state, reload }
}
