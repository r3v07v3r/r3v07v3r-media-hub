// Which collections the Collections page shows: the bundled universes plus
// the lists added from Trakt, less the ones taken off the page.
//
// The record lives in main (main/media-hub/collections.ts), per profile.
// It is read on mount, on a profile switch (which announces nothing on
// library:changed, so the active profile is watched directly), and whenever
// main says lists changed — an added list read fresh from Trakt.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useAppState } from '@renderer/context/AppStateContext'

import {
  UNIVERSES,
  type CollectionsState,
  type UniverseDefinition
} from '@shared/media-hub/universes'

const EMPTY: CollectionsState = { added: [], removed: [], traktReady: false }

export interface Collections {
  /** False until main has answered once — an added list's page must not
   *  decide it does not exist before then. */
  loaded: boolean
  traktReady: boolean
  /** On the page, bundled first, then added in the order they were added. */
  shown: UniverseDefinition[]
  /** Taken off the page, in the order they were removed. */
  removed: UniverseDefinition[]
  find: (id: string) => UniverseDefinition | undefined
  isRemoved: (id: string) => boolean
  /** Replaces what is held with main's answer to an add, remove or restore.
   *  False, and nothing replaced, when the profile changed while it ran. */
  apply: (state: CollectionsState) => boolean
}

export function useCollections(): Collections {
  const api = window.api?.mediaHub?.collections
  const { activeProfileId } = useAppState()
  const [state, setState] = useState<CollectionsState>(EMPTY)
  const [loaded, setLoaded] = useState(() => !api?.state)
  const [generation, setGeneration] = useState(0)
  // Who is watching now, for an add, remove or restore that answers after a
  // switch: its answer is the previous profile's record and is not shown.
  const profileNow = useRef(activeProfileId)
  useEffect(() => {
    profileNow.current = activeProfileId
  }, [activeProfileId])

  useEffect(() => {
    const library = window.api?.mediaHub?.library
    if (!library?.onChanged) return
    return library.onChanged((event) => {
      if (event.scopes.includes('lists') || event.scopes.includes('all')) {
        setGeneration((n) => n + 1)
      }
    })
  }, [])

  useEffect(() => {
    if (!api?.state) return
    let cancelled = false
    void api
      .state()
      .then((next) => {
        if (!cancelled) setState(next)
      })
      .catch(() => {
        // The bundled set still shows; added lists wait for the next read.
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [api, generation, activeProfileId])

  const all = useMemo(() => [...UNIVERSES, ...state.added], [state.added])
  const shown = useMemo(
    () => all.filter((collection) => !state.removed.includes(collection.id)),
    [all, state.removed]
  )
  const removed = useMemo(
    () =>
      state.removed
        .map((id) => all.find((collection) => collection.id === id))
        .filter((collection): collection is UniverseDefinition => Boolean(collection)),
    [all, state.removed]
  )
  const find = useCallback((id: string) => all.find((collection) => collection.id === id), [all])
  const isRemoved = useCallback((id: string) => state.removed.includes(id), [state.removed])
  const apply = useCallback(
    (next: CollectionsState) => {
      if (profileNow.current !== activeProfileId) return false
      setState(next)
      return true
    },
    [activeProfileId]
  )

  return {
    loaded,
    traktReady: state.traktReady,
    shown,
    removed,
    find,
    isRemoved,
    apply
  }
}
