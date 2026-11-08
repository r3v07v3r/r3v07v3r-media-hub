// Which services are set up, as one object every gated control reads.
//
// The settings snapshot already says whether TorBox, a media server, the
// metadata and subtitle keys, the relay and Ollama are configured. Simkl,
// Trakt, MyAnimeList and the cache server are not in it: each is asked by
// its own status call. This hook asks them ONCE for the whole window and
// shares the answer, so a page with six gated controls does not make
// eighteen requests, and a control that needs "Simkl or Trakt" reads one
// flag instead of two calls.
//
// `loaded` is false until both the snapshot and the status calls have
// answered. A control must not draw its RequiresSetup notice before then —
// a notice that flashes for the first frame and vanishes is worse than a
// control that appears a moment late.

import { useEffect, useSyncExternalStore } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import type { SetupService } from '@renderer/lib/setupPlaces'

export interface ServiceReadiness {
  loaded: boolean
  torbox: boolean
  mediaServer: boolean
  /** Something to play from: TorBox or a media server. A cached copy can
   *  still play without either, so Play itself is not hidden on this. */
  source: boolean
  tmdb: boolean
  omdb: boolean
  subdl: boolean
  opensubtitles: boolean
  /** Either subtitle provider. */
  subtitles: boolean
  ollama: boolean
  relay: boolean
  simkl: boolean
  trakt: boolean
  mal: boolean
  /** Any tracker: what watch-history and plan pushes need. */
  tracker: boolean
  lanCache: boolean
  /** The shader pack is on disk (settings.anime4k.installed); not a service. */
  anime4k: boolean
}

interface TrackerState {
  loaded: boolean
  simkl: boolean
  trakt: boolean
  mal: boolean
  lanCache: boolean
}

const NOT_LOADED: TrackerState = {
  loaded: false,
  simkl: false,
  trakt: false,
  mal: false,
  lanCache: false
}

// One shared store for the window. Subscribers re-render when it lands.
let trackerState: TrackerState = NOT_LOADED
let fetchedAt = 0
let inFlight: Promise<void> | null = null
const listeners = new Set<() => void>()
const STALE_MS = 15_000

function publish(next: TrackerState): void {
  trackerState = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): TrackerState {
  return trackerState
}

async function fetchTrackers(): Promise<void> {
  const api = window.api?.mediaHub
  if (!api) {
    publish({ ...NOT_LOADED, loaded: true })
    return
  }
  const [simkl, trakt, mal, lan] = await Promise.all([
    api.simkl.status().catch(() => null),
    api.trakt.status().catch(() => null),
    api.mal.status().catch(() => null),
    api.lanCache.pairStatus().catch(() => null)
  ])
  fetchedAt = Date.now()
  publish({
    loaded: true,
    simkl: simkl?.connected === true,
    trakt: trakt?.connected === true,
    mal: mal?.connected === true,
    lanCache: lan?.state === 'approved'
  })
}

/** Asks again now. Connect and disconnect flows call this so a notice
 *  elsewhere on the page goes away without waiting for the next read. */
export function refreshServiceReadiness(): Promise<void> {
  if (!inFlight) {
    inFlight = fetchTrackers().finally(() => {
      inFlight = null
    })
  }
  return inFlight
}

export function useServiceReadiness(): ServiceReadiness {
  const { mediaHubSettings } = useAppState()
  const trackers = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  // First reader asks; later readers reuse the answer while it is fresh.
  // The snapshot changes when a service is connected or disconnected, and
  // the trackers are re-read on the same cue, since a sign-in refreshes it.
  useEffect(() => {
    if (!trackerState.loaded || Date.now() - fetchedAt > STALE_MS || mediaHubSettings) {
      void refreshServiceReadiness()
    }
  }, [mediaHubSettings])

  const s = mediaHubSettings
  const torbox = s?.torboxConnected === true
  const mediaServer = s?.mediaServerConnected === true
  const subdl = s?.subdlConnected === true
  const opensubtitles = s?.osConnected === true
  return {
    loaded: Boolean(s) && trackers.loaded,
    torbox,
    mediaServer,
    source: torbox || mediaServer,
    tmdb: s?.tmdbConnected === true,
    omdb: s?.omdbConnected === true,
    subdl,
    opensubtitles,
    subtitles: subdl || opensubtitles,
    ollama: s?.ollamaConnected === true,
    relay: s?.partySyncConnected === true,
    simkl: trackers.simkl,
    trakt: trackers.trakt,
    mal: trackers.mal,
    tracker: trackers.simkl || trackers.trakt || trackers.mal,
    lanCache: trackers.lanCache,
    anime4k: s?.anime4k?.installed === true
  }
}

/** The services among `wanted` that are not set up — empty when any one
 *  of them is, for a control that works with any (Simkl or Trakt), or when
 *  nothing is known yet. Pass the result to <RequiresSetup services>. */
export function missingServices(
  ready: ServiceReadiness,
  wanted: readonly SetupService[],
  mode: 'any' | 'all' = 'any'
): SetupService[] {
  if (!ready.loaded) return []
  const have = (service: SetupService): boolean => ready[service]
  if (mode === 'any' && wanted.some(have)) return []
  return wanted.filter((service) => !have(service))
}
