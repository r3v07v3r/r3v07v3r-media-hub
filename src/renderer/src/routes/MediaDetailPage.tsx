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
import { airedEpisodes, catalogItemToMediaItem } from '@renderer/lib/mediaHub/adapters'
import { DETAIL_CONFIGS } from '@renderer/lib/mediaHub/detailAdapters'
import { useRestoreBrowsingOrigin } from '@renderer/lib/mediaHub/useRestoreBrowsingOrigin'
import type {
  AnimeStoryLink,
  CatalogItem,
  Episode,
  EpisodePlaybackPosition,
  HistoryEntry,
  MediaKind
} from '@shared/media-hub/types'
import { demoOnlyTitleMessage, hasExpressibleSimklId } from '@shared/media-hub/serviceIds'
import type { MediaItem } from '@renderer/types'
import { ContextBackButton } from '@renderer/components/detail/ContextBackButton'
import { DetailHero } from '@renderer/components/detail/DetailHero'
import { NextToPlayPanel } from '@renderer/components/detail/NextToPlayPanel'
import { AboutPanel } from '@renderer/components/detail/AboutPanel'
import { EpisodesSection } from '@renderer/components/detail/EpisodesSection'
import type { EpisodeResume } from '@renderer/components/detail/EpisodesSection'
import { RatingsPanel } from '@renderer/components/detail/RatingsPanel'
import { RequestPanel } from '@renderer/components/detail/RequestPanel'
import { CollectionPanel } from '@renderer/components/detail/CollectionPanel'
import { ProgressPanel } from '@renderer/components/detail/ProgressPanel'
import { GenresPanel } from '@renderer/components/detail/GenresPanel'
import { SimilarPanel } from '@renderer/components/detail/SimilarPanel'
import { AnimeStoryPanel } from '@renderer/components/detail/AnimeStoryPanel'
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
    popBrowsingOrigin,
    myList,
    toggleMyList,
    continueWatching,
    startPartyPlayback,
    playbackMedia,
    catalog,
    pushNotification,
    openDetail,
    watchStatusVersion,
    refreshWatchStatus
  } = useAppState()

  const [catalogItem, setCatalogItem] = useState<CatalogItem | null>(null)
  const [metaStatus, setMetaStatus] = useState<FetchStatus>('loading')

  const [related, setRelated] = useState<MediaItem[]>([])
  const [relatedStatus, setRelatedStatus] = useState<FetchStatus>('loading')

  const [storyLinks, setStoryLinks] = useState<AnimeStoryLink[]>([])
  const [storyStatus, setStoryStatus] = useState<FetchStatus>('loading')
  const [storyChecked, setStoryChecked] = useState(false)

  const [history, setHistory] = useState<HistoryEntry[]>([])
  // Only the setter is used — nothing in this page shows a separate
  // loading indicator for tracking history specifically (episodes just
  // render as not-yet-watched until it resolves, via EpisodesSection's
  // own `status`, which tracks the primary catalog:meta fetch instead).
  const [, setHistoryStatus] = useState<FetchStatus>('loading')

  // Resume bookmarks for every episode of this title, in one call (see
  // EpisodePlaybackPosition's doc comment) — what the episode grid draws
  // its per-tile "N min left" slivers from. Purely decorative: no loading
  // state and no error surface, since a tile without a sliver is exactly
  // what an episode nobody has started looks like anyway.
  const [positions, setPositions] = useState<EpisodePlaybackPosition[]>([])

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
    // MediaDetailPage is reused across titles (App.tsx's route has no
    // `key={id}`, so navigating from one detail page to another re-renders
    // this same instance rather than remounting it) — without this, a
    // season explicitly picked on the PREVIOUS title survives into this
    // one. If that stale season number doesn't exist here (e.g. leaving a
    // title with a season-0 "Specials" entry for one that starts at season
    // 1, such as BLEACH: Sennen Kessen-hen), the episode grid renders empty
    // and no season pill shows active until the person clicks one by hand.
    setSelectedSeasonOverride(null)
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

  // Finished describes this release. A direct story lookup makes the
  // next/previous title explicit instead of hiding it from Similar.
  useEffect(() => {
    if (!id || kind !== 'anime') return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStoryStatus('loading')
    setStoryChecked(false)
    const api = window.api?.mediaHub
    if (!api) {
      setStoryStatus('error')
      return
    }
    api.catalog
      .story(kind, id)
      .then((result) => {
        if (cancelled) return
        setStoryLinks(result.links)
        setStoryChecked(result.checked)
        setStoryStatus('ready')
      })
      .catch(() => {
        if (!cancelled) setStoryStatus('error')
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
    // Every kind goes through this now. catalog:related used to return []
    // unconditionally for series, so this skipped the call entirely and
    // rendered a "not supported yet" note; similarTitles ranks series the
    // same way it ranks everything else (see catalog.ts).
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

  // Two triggers, because a bookmark and a watch are saved by different
  // things. watchStatusVersion covers the watch (PlayerOverlay's 80%
  // auto-mark bumps it), same as the history fetch above.
  //
  // `isPlaying` covers the bookmark. Stopping an episode BELOW that 80%
  // threshold saves a position without ever touching watch status — and
  // the player is its own window, so this page stays mounted throughout
  // and would otherwise keep showing no sliver on the episode just
  // stopped until something else happened to re-render it. playbackMedia
  // going back to null is the one signal that means "playback is over"
  // (see AppStateContext's stopPlayback), and PlayerOverlayWindow's
  // closePlayer now saves before raising the stop that clears it, so the
  // bookmark is already written by the time this re-reads. Narrowed to a
  // boolean so the fetch fires on the two edges rather than on every
  // playbackMedia identity change.
  const isPlaying = playbackMedia != null
  useEffect(() => {
    if (!id) return
    let cancelled = false
    const api = window.api?.mediaHub
    if (!api) return
    api.tracking
      .listPositions({ id })
      .then((result) => {
        if (!cancelled) setPositions(result)
      })
      .catch(() => {
        if (!cancelled) setPositions([])
      })
    return () => {
      cancelled = true
    }
  }, [id, watchStatusVersion, isPlaying])

  const media = useMemo<MediaItem | null>(() => {
    if (catalogItem) return catalogItemToMediaItem(catalogItem, { trackedIds: myList })
    // Graceful degradation (no bridge, or the fetch failed): whatever's
    // already in the globally-loaded catalog is still real data, just a
    // narrower slice of it (no episode list, no trailers) — better than a
    // hard failure for a title the person was just looking at a card for.
    return catalog.find((m) => m.id === id) ?? null
  }, [catalogItem, catalog, id, myList])

  const storyItems = useMemo(
    () =>
      storyLinks.map((link) => ({
        ...link,
        item: catalogItemToMediaItem(link.item, { trackedIds: myList })
      })),
    [storyLinks, myList]
  )

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

  // Real per-episode resume state, keyed the same way watchedKeys is.
  // A bookmark with no duration recorded (savePlaybackPosition stores
  // duration as nullable) still gets a tile badge-less entry rather than
  // being dropped: "started, unknown how far" is worth showing, it just
  // can't say how much is left, and its percent falls back to the show's
  // own per-episode runtime when there is one.
  const resumeByKey = useMemo(() => {
    const map = new Map<string, EpisodeResume>()
    for (const p of positions) {
      if (p.season == null || p.episode == null) continue
      const duration =
        p.durationSeconds && p.durationSeconds > 0
          ? p.durationSeconds
          : media?.runtimeMinutes
            ? media.runtimeMinutes * 60
            : null
      if (!duration || p.positionSeconds <= 0) continue
      const percent = Math.min(100, Math.max(0, Math.round((p.positionSeconds / duration) * 100)))
      const remaining = Math.max(0, duration - p.positionSeconds)
      map.set(episodeKey(p.season, p.episode), {
        percent,
        // Rounded up, so the last 30 seconds read "1m left" rather than
        // "0m left" — which would look like a finished episode.
        remainingMinutes: Math.max(1, Math.ceil(remaining / 60))
      })
    }
    return map
  }, [positions, media?.runtimeMinutes])

  /** Watched-vs-total across this title's real episode list — the numbers
   *  the Tracked & Progress panel shows. Derived from the same
   *  (episodes, watchedKeys) pair the grid itself renders from, so the
   *  panel and the tiles can never disagree. Null when there's no episode
   *  list at all (a movie, or the degraded no-bridge path where `media`
   *  came from the cached catalog), leaving the panel on its old
   *  continueEntry-based fallback for those.
   *
   *  airedEpisodes, not a plain !unplayable filter: it's the same
   *  denominator adapters.ts's isSeriesCompleted uses for the "Completed"
   *  badge on a catalog card, so a currently-airing show someone is fully
   *  caught up on reads 100% here AND completed there. Counting the
   *  future-dated episodes Cinemeta/TMDB ship in `videos` would have left
   *  it short of 100% with episodes that don't exist yet sitting in the
   *  Unwatched total. The grid itself still shows them — what's coming is
   *  worth seeing, it just isn't progress.  */
  const episodeStats = useMemo(() => {
    const countable = airedEpisodes(episodes)
    if (countable.length === 0) return null
    return {
      watchedCount: countable.filter((e) => watchedKeys.has(episodeKey(e.season, e.episode)))
        .length,
      total: countable.length
    }
  }, [episodes, watchedKeys])

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
    // Pops as it goes, so a chain opened through the Rest of the series /
    // Similar panels unwinds one step per press all the way back to the
    // grid it started from. Reading the top without popping left the
    // button pointed at the page it had just returned to — /movies/:id
    // does not remount when only the id changes, so nothing downstream
    // ever consumed the entry.
    const origin = popBrowsingOrigin()
    navigate(origin ? origin.route : `/${config.path}`)
  }

  function handlePlay(season?: number, episode?: number): void {
    if (!media) return
    startPartyPlayback(
      config.isEpisodic
        ? {
            ...media,
            seasonNumber: season ?? nextEpisode?.season ?? 1,
            episodeNumber: episode ?? nextEpisode?.episode ?? 1,
            // Coordinates chosen here override whatever the media object
            // carried; a stale name must not ride along with them.
            episodeTitle: undefined
          }
        : media
    )
  }

  // handleWatchTogether lived here. The button that called it is gone
  // while rooms are reworked, and a room-joining code path with no way
  // to reach it is worse than none: it still compiles, still looks
  // maintained, and quietly rots against whatever rooms become.

  function handleGenreSelect(genre: string): void {
    navigate(`/${config.path}?genre=${encodeURIComponent(genre)}`)
  }

  /**
   * Refuses to write a demo title into real watch history, and says why.
   *
   * This page can render for a mockData item (an AI-assistant fallback
   * pick opened through openDetail, or the degraded-catalog fallback in
   * `media` above), and its mark-watched controls used to write the mock
   * id straight into watch_history — the exact path that created the
   * m-10/m-11/m-13 ghost duplicates of Aug 24 (see
   * shared/media-hub/serviceIds.ts). Only the WATCHED direction is
   * guarded, here and in main's IPC backstop: un-marking is how a ghost
   * that already leaked in gets cleaned out, and must keep working.
   */
  function refuseDemoWatchedWrite(watched: boolean): boolean {
    if (!media || !watched || hasExpressibleSimklId(media.id)) return false
    pushNotification({ tone: 'info', message: demoOnlyTitleMessage(media.title) })
    return true
  }

  async function handleMarkEpisodeWatched(episode: Episode, watched: boolean): Promise<void> {
    const api = window.api?.mediaHub
    if (!api || !media) return
    if (refuseDemoWatchedWrite(watched)) return
    const item = {
      id: media.id,
      type: kind,
      title: media.title,
      poster: media.posterUrl ?? '',
      year: media.releaseYear ? String(media.releaseYear) : '',
      ...(media.totalEpisodes != null ? { totalEpisodes: media.totalEpisodes } : {})
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
    if (refuseDemoWatchedWrite(watched)) return
    const item = {
      id: media.id,
      type: kind,
      title: media.title,
      poster: media.posterUrl ?? '',
      year: media.releaseYear ? String(media.releaseYear) : '',
      ...(media.totalEpisodes != null ? { totalEpisodes: media.totalEpisodes } : {})
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
    if (refuseDemoWatchedWrite(watched)) return
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
        onPlay={() =>
          handlePlay(continueEntry?.media.seasonNumber, continueEntry?.media.episodeNumber)
        }
      />

      <div className={styles.main}>
        {config.isEpisodic ? (
          <>
            <div className={styles.overviewRow}>
              <AboutPanel media={media} config={config} />
              <NextToPlayPanel
                media={media}
                nextEpisode={nextEpisode}
                allWatched={episodes.length > 0 && !nextEpisode}
                onPlay={(ep) => ep && handlePlay(ep.season, ep.episode)}
              />
            </div>
            <EpisodesSection
              mediaId={media.id}
              showTitle={media.title}
              episodes={episodes}
              seasons={seasons}
              selectedSeason={selectedSeason}
              onSelectSeason={setSelectedSeasonOverride}
              watchedKeys={watchedKeys}
              resumeByKey={resumeByKey}
              runtimeMinutes={media.runtimeMinutes}
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
        {!config.isEpisodic && <AboutPanel media={media} config={config} />}
      </div>

      <div className={styles.sidebar}>
        <CollectionPanel media={media} />
        {/* Where to watch is gone. It was a TMDB round trip per title
            for a JustWatch panel of rent-and-buy links — a request and
            a render on every detail page, for the one thing somebody
            using this app is least likely to want. */}
        <RequestPanel media={media} />
        <RatingsPanel media={media} />
        <ProgressPanel
          config={config}
          media={media}
          episodeStats={episodeStats}
          continueEntry={continueEntry}
          inMyList={inMyList}
          onToggleMyList={() => toggleMyList(media)}
          onOpenLastWatched={() =>
            handlePlay(continueEntry?.media.seasonNumber, continueEntry?.media.episodeNumber)
          }
          movieWatched={movieWatched}
          onToggleMovieWatched={handleToggleMovieWatched}
        />
        {kind === 'anime' && (
          <AnimeStoryPanel
            status={storyStatus}
            checked={storyChecked}
            links={storyItems}
            currentStatus={catalogItem?.status ?? media.status}
            episodeCount={media.totalEpisodes}
            onSelect={(item) => openDetail(item, media.title)}
          />
        )}
        <GenresPanel genres={media.genres} onSelectGenre={handleGenreSelect} />
        <SimilarPanel
          status={relatedStatus}
          items={related}
          config={config}
          onSelect={(item) => openDetail(item, media.title)}
          onViewAll={() => navigate(`/${config.path}`)}
        />
      </div>
    </div>
  )
}
