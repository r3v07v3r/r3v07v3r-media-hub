'use client'

// Shared movie/series/anime detail page — one implementation driven by a
// DetailAdapterConfig (see lib/mediaHub/detailAdapters.ts), same pattern
// CategoryPage.tsx already uses for the Movies/Series/Anime browse pages.
// Real backend data throughout: catalog:meta for the full item (including
// the episode list categoryFilters' catalogItemToMediaItem discards —
// see adapters.ts), catalog:related for similar titles (empty for series
// — the backend has no series branch, see catalog.ts's registerCatalogIpc
// — surfaced honestly rather than hidden), and tracking:list's history for
// real per-episode watched state (which specific episodes were watched,
// not just "N of M" — a strictly more accurate source than the aggregate
// count continueWatchingEntryToItem synthesizes progress bars from).

import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAppState } from '@renderer/context/AppStateContext'
import { catalogItemToMediaItem } from '@renderer/lib/mediaHub/adapters'
import { DETAIL_CONFIGS } from '@renderer/lib/mediaHub/detailAdapters'
import { useRestoreBrowsingOrigin } from '@renderer/lib/mediaHub/useRestoreBrowsingOrigin'
import type { CatalogItem, Episode, HistoryEntry, MediaKind } from '@shared/media-hub/types'
import type { MediaItem } from '@renderer/types'
import { ContextBackButton } from '@renderer/components/detail/ContextBackButton'
import { DetailHero } from '@renderer/components/detail/DetailHero'
import { NextToPlayPanel } from '@renderer/components/detail/NextToPlayPanel'
import { AboutPanel } from '@renderer/components/detail/AboutPanel'
import { EpisodesSection } from '@renderer/components/detail/EpisodesSection'
import { RatingsPanel } from '@renderer/components/detail/RatingsPanel'
import { ProgressPanel } from '@renderer/components/detail/ProgressPanel'
import { GenresPanel } from '@renderer/components/detail/GenresPanel'
import { SimilarPanel } from '@renderer/components/detail/SimilarPanel'
import styles from './MediaDetailPage.module.css'

type FetchStatus = 'loading' | 'ready' | 'error'

function episodeKey(season: number | null | undefined, episode: number | null | undefined): string {
  return `${season ?? ''}:${episode ?? ''}`
}

export function MediaDetailPage({ kind }: { kind: MediaKind }) {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const config = DETAIL_CONFIGS[kind]
  const {
    browsingOrigin,
    myList,
    toggleMyList,
    continueWatching,
    startPartyPlayback,
    catalog,
    pushNotification,
    openDetail,
    watchStatusVersion,
    refreshWatchStatus
  } = useAppState()

  const [catalogItem, setCatalogItem] = useState<CatalogItem | null>(null)
  const [metaStatus, setMetaStatus] = useState<FetchStatus>('loading')

  const [related, setRelated] = useState<MediaItem[]>([])
  const [relatedStatus, setRelatedStatus] = useState<FetchStatus | 'unsupported'>('loading')

  const [history, setHistory] = useState<HistoryEntry[]>([])
  // Only the setter is used — nothing in this page shows a separate
  // loading indicator for tracking history specifically (episodes just
  // render as not-yet-watched until it resolves, via EpisodesSection's
  // own `status`, which tracks the primary catalog:meta fetch instead).
  const [, setHistoryStatus] = useState<FetchStatus>('loading')

  const [showTrailer, setShowTrailer] = useState(false)
  // null means "no explicit choice yet" — falls back to the season
  // containing the next-to-play episode (or the first season) below,
  // computed at render time rather than synced via an effect so picking
  // a season doesn't cost an extra render pass, and so it stays correct
  // if `nextEpisode` itself changes later (e.g. after marking an episode
  // watched) without needing to explicitly reset anything.
  const [selectedSeasonOverride, setSelectedSeasonOverride] = useState<number | null>(null)

  // Primary fetch — the one thing the page genuinely can't render without.
  useEffect(() => {
    if (!id) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- same "reset loading before the fetch starts" pattern hooks.ts's useMediaHubBrowseCatalog/useMediaHubHomeFeed already use
    setMetaStatus('loading')
    setCatalogItem(null)
    setShowTrailer(false)
    const api = window.api?.mediaHub
    if (!api) {
      setMetaStatus('error')
      return
    }
    api.catalog
      .meta(kind, id)
      .then((item) => {
        if (cancelled) return
        setCatalogItem(item)
        setMetaStatus('ready')
      })
      .catch(() => {
        if (cancelled) return
        setMetaStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [kind, id])

  // Secondary fetches — independent of the primary one and of each other,
  // so a failure (or, for series, a known-unsupported backend gap) in
  // either never blocks the hero/about/episode sections from rendering.
  useEffect(() => {
    if (!id) return
    if (kind === 'series') {
      // catalog:related has no series branch at all (registerCatalogIpc
      // returns [] unconditionally for this kind) — not attempting the
      // call is more honest than firing a request guaranteed to come back
      // empty and rendering that as "no similar series exist."
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRelatedStatus('unsupported')
      return
    }
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRelatedStatus('loading')
    const api = window.api?.mediaHub
    if (!api) {
      setRelatedStatus('error')
      return
    }
    api.catalog
      .related(kind, id)
      .then((items) => {
        if (cancelled) return
        setRelated(items.map((item) => catalogItemToMediaItem(item, { trackedIds: myList })))
        setRelatedStatus('ready')
      })
      .catch(() => {
        if (cancelled) return
        setRelatedStatus('error')
      })
    return () => {
      cancelled = true
    }
    // myList intentionally excluded — this only needs to seed inMyList
    // once per item fetch, not refetch every time a My List toggle
    // happens anywhere in the app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, id])

  useEffect(() => {
    if (!id) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHistoryStatus('loading')
    const api = window.api?.mediaHub
    if (!api) {
      setHistoryStatus('error')
      return
    }
    api.tracking
      .list()
      .then((result) => {
        if (cancelled) return
        setHistory(result.history.filter((h) => h.id === id))
        setHistoryStatus('ready')
      })
      .catch(() => {
        if (cancelled) return
        setHistoryStatus('error')
      })
    return () => {
      cancelled = true
    }
    // watchStatusVersion: this page's own history fetch is scoped to just
    // `id` and has no other way to learn about a mark-watched that happened
    // elsewhere (PlaybackOverlay's 80%-progress auto-mark, in particular) —
    // see AppStateContext's watchStatusVersion doc comment.
  }, [id, watchStatusVersion])

  const media = useMemo<MediaItem | null>(() => {
    if (catalogItem) return catalogItemToMediaItem(catalogItem, { trackedIds: myList })
    // Graceful degradation (no bridge, or the fetch failed): whatever's
    // already in the globally-loaded catalog is still real data, just a
    // narrower slice of it (no episode list, no trailers) — better than a
    // hard failure for a title the person was just looking at a card for.
    return catalog.find((m) => m.id === id) ?? null
  }, [catalogItem, catalog, id, myList])

  const inMyList = id ? myList.has(id) : false

  const episodes = useMemo<Episode[]>(() => {
    if (!catalogItem?.videos?.length) return []
    return [...catalogItem.videos].sort((a, b) => a.season - b.season || a.episode - b.episode)
  }, [catalogItem])

  const seasons = useMemo<number[]>(() => {
    const set = new Set(episodes.map((e) => e.season))
    return Array.from(set).sort((a, b) => a - b)
  }, [episodes])

  // Real per-episode watched state from tracking history — a strictly
  // more accurate source than assuming "the first N in order" the way
  // continueWatchingEntryToItem's synthesized progress bar has to (see
  // that function's own comment on why: the backend only ever gave it an
  // aggregate watchedCount/totalCount, not which specific episodes).
  const watchedKeys = useMemo(() => {
    const set = new Set<string>()
    for (const h of history) {
      if (h.season != null && h.episode != null) set.add(episodeKey(h.season, h.episode))
    }
    return set
  }, [history])

  const continueEntry = useMemo(
    () => (id ? continueWatching.find((c) => c.media.id === id) : undefined),
    [continueWatching, id]
  )

  // media.watched/completed come from catalogItemToMediaItem(catalogItem,
  // {trackedIds: myList}) above, which — unlike the full context the home/
  // category grids build with — never passes watchedIds/history, so those
  // fields are unconditionally false here. `history` (this page's own
  // tracking:list fetch, already filtered to this exact id) is the real
  // source of truth for a movie's watched state instead.
  const movieWatched = history.length > 0

  const nextEpisode = useMemo(() => {
    if (!episodes.length) return null
    // e.unplayable excludes disambiguateVideos' synthetic Specials entries
    // (see its own doc comment in core.ts) — they have no real (season,
    // episode) coordinate the scraper/TorBox pipeline can resolve a
    // stream for, so they must never become the auto-selected "next
    // episode" / play target even though they're first in sort order.
    const firstUnwatched = episodes.find(
      (e) => !e.unplayable && !watchedKeys.has(episodeKey(e.season, e.episode))
    )
    return firstUnwatched ?? null
  }, [episodes, watchedKeys])

  const selectedSeason =
    selectedSeasonOverride ??
    (seasons.length
      ? ((nextEpisode ?? episodes.find((e) => !e.unplayable) ?? episodes[0])?.season ?? seasons[0])
      : null)

  useRestoreBrowsingOrigin(metaStatus !== 'loading')

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') handleBack()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleBack is stable enough in intent; redefining it as a dep would just re-bind this listener every render for no behavioral difference
  }, [browsingOrigin, config.path])

  function handleBack(): void {
    if (browsingOrigin) navigate(browsingOrigin.route)
    else navigate(`/${config.path}`)
  }

  function handlePlay(season?: number, episode?: number): void {
    if (!media) return
    startPartyPlayback(
      config.isEpisodic
        ? {
            ...media,
            seasonNumber: season ?? nextEpisode?.season ?? 1,
            episodeNumber: episode ?? nextEpisode?.episode ?? 1
          }
        : media
    )
  }

  function handleGenreSelect(genre: string): void {
    navigate(`/${config.path}?genre=${encodeURIComponent(genre)}`)
  }

  async function handleMarkEpisodeWatched(episode: Episode, watched: boolean): Promise<void> {
    const api = window.api?.mediaHub
    if (!api || !media) return
    const item = {
      id: media.id,
      type: kind,
      title: media.title,
      poster: media.posterUrl ?? '',
      year: media.releaseYear ? String(media.releaseYear) : ''
    }
    const call = watched ? api.tracking.markWatched : api.tracking.unmarkWatched
    try {
      await call({ item, playback: { season: episode.season, episode: episode.episode } })
      const refreshed = await api.tracking.list()
      setHistory(refreshed.history.filter((h) => h.id === media.id))
    } catch {
      pushNotification({ tone: 'error', message: 'Could not update watched status.' })
    }
  }

  /**
   * Same primitive as handleMarkEpisodeWatched, minus a season/episode —
   * movies have no per-episode granularity, so `playback` is omitted
   * entirely rather than sent as {season: undefined, episode: undefined}.
   *
   * Also calls refreshWatchStatus() (handleMarkEpisodeWatched/
   * handleMarkSeasonWatched above don't) — this page's own `history`
   * state is enough to keep ProgressPanel's toggle itself correct, but
   * the catalog grids (watchedIdsResult) and personalized rails
   * (homeFeed) this toggle also affects have no other way to learn about
   * it, the same reasoning toggleMyList's own refreshWatchStatus-adjacent
   * fix (AppStateContext) already applies to following a title.
   */
  async function handleToggleMovieWatched(watched: boolean): Promise<void> {
    const api = window.api?.mediaHub
    if (!api || !media) return
    const item = {
      id: media.id,
      type: kind,
      title: media.title,
      poster: media.posterUrl ?? '',
      year: media.releaseYear ? String(media.releaseYear) : ''
    }
    const call = watched ? api.tracking.markWatched : api.tracking.unmarkWatched
    try {
      await call({ item })
      const refreshed = await api.tracking.list()
      setHistory(refreshed.history.filter((h) => h.id === media.id))
      refreshWatchStatus()
    } catch {
      pushNotification({ tone: 'error', message: 'Could not update watched status.' })
    }
  }

  /**
   * "Mark season watched" has a real batch IPC (tracking:mark-season-watched
   * — one Simkl sync call for every episode in the season, see
   * main/media-hub/tracking.ts). "Mark season unwatched" has no batch
   * equivalent on the backend, so it's real per-episode
   * tracking:unmark-watched calls run in parallel instead — same
   * underlying primitive handleMarkEpisodeWatched above uses one at a
   * time, just fired for the whole season at once here.
   */
  async function handleMarkSeasonWatched(season: number, watched: boolean): Promise<void> {
    const api = window.api?.mediaHub
    if (!api || !media) return
    // e.unplayable (see disambiguateVideos in core.ts) has no real
    // (season, episode) coordinate — sending it through markSeasonWatched/
    // unmarkWatched would push a fabricated (0, -N) pair into local
    // history and Simkl sync for a promotional clip that was never a real
    // episode.
    const seasonEpisodes = episodes.filter((e) => e.season === season && !e.unplayable)
    if (seasonEpisodes.length === 0) return
    const item = {
      id: media.id,
      type: kind,
      title: media.title,
      poster: media.posterUrl ?? '',
      year: media.releaseYear ? String(media.releaseYear) : ''
    }
    try {
      if (watched) {
        await api.tracking.markSeasonWatched({
          item,
          season,
          episodes: seasonEpisodes.map((e) => ({ season: e.season, episode: e.episode }))
        })
      } else {
        await Promise.all(
          seasonEpisodes.map((e) =>
            api.tracking.unmarkWatched({ item, playback: { season: e.season, episode: e.episode } })
          )
        )
      }
      const refreshed = await api.tracking.list()
      setHistory(refreshed.history.filter((h) => h.id === media.id))
    } catch {
      pushNotification({ tone: 'error', message: 'Could not update the season’s watched status.' })
    }
  }

  if (metaStatus === 'loading' && !media) {
    return (
      <div className={styles.page}>
        <ContextBackButton
          origin={browsingOrigin}
          fallbackLabel={config.label}
          onBack={handleBack}
        />
        <div
          className={styles.loadingState}
          aria-busy="true"
          aria-label={`Loading ${config.label.toLowerCase()} details`}
        >
          <div className={styles.loadingBackdrop} />
          <div className={styles.loadingLine} style={{ width: '38%' }} />
          <div className={styles.loadingLine} style={{ width: '58%' }} />
          <div className={styles.loadingLine} style={{ width: '24%' }} />
        </div>
      </div>
    )
  }

  if (!media) {
    return (
      <div className={styles.page}>
        <ContextBackButton
          origin={browsingOrigin}
          fallbackLabel={config.label}
          onBack={handleBack}
        />
        <div className={styles.errorState} role="alert">
          <h1>Couldn&apos;t load this title</h1>
          <p>
            It may no longer be in your catalog, or the media hub backend couldn&apos;t be reached.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <ContextBackButton origin={browsingOrigin} fallbackLabel={config.label} onBack={handleBack} />

      <DetailHero
        media={media}
        config={config}
        continueEntry={continueEntry}
        nextEpisode={nextEpisode}
        trailer={catalogItem?.trailers?.[0]}
        showTrailer={showTrailer}
        onToggleTrailer={() => setShowTrailer((v) => !v)}
        inMyList={inMyList}
        onToggleMyList={() => toggleMyList(media)}
        onPlay={() =>
          handlePlay(continueEntry?.media.seasonNumber, continueEntry?.media.episodeNumber)
        }
      />

      <div className={styles.main}>
        {config.isEpisodic ? (
          <>
            <NextToPlayPanel
              media={media}
              nextEpisode={nextEpisode}
              allWatched={episodes.length > 0 && !nextEpisode}
              onPlay={(ep) => ep && handlePlay(ep.season, ep.episode)}
            />
            <EpisodesSection
              mediaId={media.id}
              episodes={episodes}
              seasons={seasons}
              selectedSeason={selectedSeason}
              onSelectSeason={setSelectedSeasonOverride}
              watchedKeys={watchedKeys}
              nextEpisode={nextEpisode}
              onPlay={(ep) => handlePlay(ep.season, ep.episode)}
              onMarkWatched={handleMarkEpisodeWatched}
              onMarkSeason={handleMarkSeasonWatched}
              status={metaStatus}
            />
          </>
        ) : null}
        {/* Movies skip NextToPlayPanel entirely (no isEpisodic branch above)
            — its movie-specific "Ready to Watch"/"Resume Watching" variant
            was just a second Play button duplicating the hero's own, per
            the user's own request. */}
        <AboutPanel media={media} config={config} />
      </div>

      <div className={styles.sidebar}>
        <RatingsPanel media={media} />
        <ProgressPanel
          config={config}
          media={media}
          continueEntry={continueEntry}
          inMyList={inMyList}
          onToggleMyList={() => toggleMyList(media)}
          onOpenLastWatched={() =>
            handlePlay(continueEntry?.media.seasonNumber, continueEntry?.media.episodeNumber)
          }
          movieWatched={movieWatched}
          onToggleMovieWatched={handleToggleMovieWatched}
        />
        <GenresPanel genres={media.genres} onSelectGenre={handleGenreSelect} />
        <SimilarPanel
          status={kind === 'series' ? 'unsupported' : relatedStatus}
          items={related}
          config={config}
          onSelect={(item) => openDetail(item, media.title)}
          onViewAll={() => navigate(`/${config.path}`)}
        />
      </div>
    </div>
  )
}
