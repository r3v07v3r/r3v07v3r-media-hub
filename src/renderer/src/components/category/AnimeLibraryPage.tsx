'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import { ArtworkImage } from '@renderer/components/media/ArtworkImage'
import { resolveArtwork } from '@renderer/lib/artwork'
import type { MediaItem } from '@renderer/types'
import {
  applyWatchStateFilters,
  filterStateFromSearchParams,
  filterStateToSearchParams,
  matchesCategoryKind,
  type HideStateDefaults
} from '@renderer/lib/mediaHub/categoryFilters'
import { useCatalogBrowse, useCatalogKindTotals } from '@renderer/lib/mediaHub/useCatalogBrowse'
import type { CatalogFacets, DeepScanEvent } from '@shared/media-hub/types'
import { ANIME_CONFIG, type CategoryConfig } from '@renderer/lib/mediaHub/categoryConfig'
import { useRestoreBrowsingOrigin } from '@renderer/lib/mediaHub/useRestoreBrowsingOrigin'
import { useBatchReveal } from '@renderer/lib/mediaHub/useBatchReveal'
import { CategoryFilterBar } from './CategoryFilterBar'
import styles from './AnimeLibraryPage.module.css'
import { RatingBadge } from '@renderer/components/detail/RatingBadge'
import { ratingSourceFor } from '@renderer/components/detail/ratingSource'

/** EverythingSection's reveal batch size — how many more tiles mount each
 *  time the scroll sentinel comes into view. */
const EVERYTHING_BATCH = 24

function formatLibraryMeta(media: MediaItem): string {
  if (media.mediaKind === 'movie' || media.mediaType === 'movie') {
    return media.runtimeMinutes ? `${media.runtimeMinutes} min` : 'Feature film'
  }
  if (media.totalEpisodes) return `${media.totalEpisodes} episodes`
  if (media.seasonNumber && media.episodeNumber)
    return `S${media.seasonNumber} · E${media.episodeNumber}`
  return media.status
    ? media.status.replace(/\b\w/g, (letter) => letter.toUpperCase())
    : mediaKindLabel(media)
}

function score(media: MediaItem): string | null {
  return media.communityRating !== undefined ? media.communityRating.toFixed(1) : null
}

function mediaKindLabel(media: MediaItem): string {
  if (media.mediaKind === 'anime') return 'Anime'
  if (media.mediaKind === 'movie' || media.mediaType === 'movie') return 'Movie'
  return 'Series'
}

function uniqueItems(items: MediaItem[]): MediaItem[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

function EmptyShelf({ message, icon = 'grid' }: { message: string; icon?: string }) {
  return (
    <div className={styles.emptyShelf}>
      <Icon name={icon} size={18} />
      {message}
    </div>
  )
}

interface ShelfProps {
  title: string
  icon: string
  items: MediaItem[]
  selectedId: string | null
  onSelect: (media: MediaItem) => void
  onOpen: (media: MediaItem) => void
  emptyMessage: string
  collapseWhenEmpty?: boolean
}

function LibraryShelf({
  title,
  icon,
  items,
  selectedId,
  onSelect,
  onOpen,
  emptyMessage,
  collapseWhenEmpty = false
}: ShelfProps) {
  const scroller = useRef<HTMLUListElement>(null)
  const isCollapsed = collapseWhenEmpty && items.length === 0

  function nudge(direction: -1 | 1) {
    scroller.current?.scrollBy({ left: direction * 460, behavior: 'smooth' })
  }

  return (
    <section
      className={`${styles.shelf} ${isCollapsed ? styles.shelfCollapsed : ''}`}
      aria-label={title}
    >
      <div className={styles.shelfHeading}>
        <h2>
          <Icon name={icon} size={17} />
          {isCollapsed ? emptyMessage : title}
        </h2>
        {items.length > 0 && (
          <div className={styles.shelfControls}>
            <span>{items.length} titles</span>
            <button type="button" onClick={() => nudge(-1)} aria-label={`Scroll ${title} left`}>
              <Icon name="chevron-left" size={16} />
            </button>
            <button type="button" onClick={() => nudge(1)} aria-label={`Scroll ${title} right`}>
              <Icon name="chevron" size={16} />
            </button>
          </div>
        )}
      </div>

      {isCollapsed ? null : items.length === 0 ? (
        <EmptyShelf message={emptyMessage} icon={icon} />
      ) : (
        <ul className={styles.shelfScroller} ref={scroller}>
          {items.map((media) => (
            <LibraryTile
              key={media.id}
              media={media}
              selected={media.id === selectedId}
              onSelect={onSelect}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function LibraryTile({
  media,
  selected,
  onSelect,
  onOpen
}: {
  media: MediaItem
  selected: boolean
  onSelect: (media: MediaItem) => void
  onOpen: (media: MediaItem) => void
}) {
  const artwork = resolveArtwork(media)
  const rating = score(media)

  return (
    <li>
      <article
        className={`${styles.tile} ${selected ? styles.tileSelected : ''}`}
        data-media-id={media.id}
        tabIndex={0}
        role="button"
        onClick={() => onSelect(media)}
        onDoubleClick={() => onOpen(media)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onSelect(media)
          }
        }}
        aria-label={`${media.title}. Select for details; double click to open.`}
      >
        <ArtworkImage
          className={styles.tileArtwork}
          src={artwork.posterUrl ?? artwork.backdropUrl}
          alt=""
          fallbackTitle={media.title}
          artTint={media.artTint}
          sizes="190px"
        />
        <div className={styles.tileShade} aria-hidden="true" />
        {rating && (
          <span className={styles.tileRating}>
            <Icon name="star" size={11} />
            {rating}
          </span>
        )}
        <button
          type="button"
          className={styles.tileOpen}
          onClick={(event) => {
            event.stopPropagation()
            onOpen(media)
          }}
          aria-label={`Open ${media.title}`}
        >
          <Icon name="play" size={14} />
        </button>
        <div className={styles.tileCopy}>
          <span>{media.title}</span>
          <small>
            {mediaKindLabel(media)} · {media.releaseYear ?? 'New'} · {formatLibraryMeta(media)}
          </small>
        </div>
      </article>
    </li>
  )
}

/** A deliberately separate grid at the foot of every library page: only its
 * first batch mounts initially, then the sentinel grows it as the person
 * scrolls the app's main pane. This keeps a large catalog from fetching every
 * piece of art merely because one category page opened. */
function EverythingSection({
  items,
  selectedId,
  onSelect,
  onOpen,
  emptyMessage,
  initialVisibleCount,
  viewKey,
  backend
}: ShelfProps & {
  /** Present when the grid pages from the INDEX (catalog:query) instead
   *  of slicing a loaded array — the stage-3 mode, and the default
   *  outside of search. The sentinel then asks the backend for the next
   *  page rather than revealing more of what is already here, and the
   *  count label quotes the exact filtered total instead of the length
   *  of whatever happened to load. */
  backend?: {
    total: number
    hasMore: boolean
    loading: boolean
    onLoadMore: () => void
  }
  /** Seeds the initial reveal batch above EVERYTHING_BATCH — used when
   *  restoring a browsing position (see useRestoreBrowsingOrigin) whose
   *  focused tile was further down the list than one batch would
   *  normally render, so it's actually present in the DOM for the
   *  restore step to find and scroll to. Only matters on this
   *  component's first mount (a plain useState initializer). */
  initialVisibleCount?: number
  /** Identifies the current browse view (filters + sort + search state —
   *  see LibraryPage's own `viewKey`) — the reveal count resets to
   *  EVERYTHING_BATCH only when THIS changes, not on every `items`
   *  reference change. See useBatchReveal's own doc comment for why a
   *  content-only diff can't be trusted to tell a genuine filter/sort/
   *  search change apart from a catalog-side edit (mark one watched,
   *  hide-watched dropping a title) within the same view. */
  viewKey: string
}) {
  const [visibleCount, setVisibleCount] = useBatchReveal(
    items,
    viewKey,
    EVERYTHING_BATCH,
    initialVisibleCount
  )
  const itemsLengthRef = useRef(items.length)
  useEffect(() => {
    itemsLengthRef.current = items.length
  }, [items.length])
  const backendRef = useRef(backend)
  useEffect(() => {
    backendRef.current = backend
  }, [backend])
  const observerRef = useRef<IntersectionObserver | null>(null)
  const sentinelRef = useCallback(
    (node: HTMLLIElement | null) => {
      observerRef.current?.disconnect()
      observerRef.current = null
      if (!node) return
      const observer = new IntersectionObserver(
        (entries) => {
          if (!entries[0]?.isIntersecting) return
          // Backend mode fetches the next PAGE; reveal mode mounts more
          // of an array already in memory. Same sentinel, two meanings.
          if (backendRef.current) backendRef.current.onLoadMore()
          else {
            setVisibleCount((count) => Math.min(count + EVERYTHING_BATCH, itemsLengthRef.current))
          }
        },
        { rootMargin: '900px' }
      )
      observer.observe(node)
      observerRef.current = observer
    },
    [setVisibleCount]
  )
  // In backend mode every fetched row renders — arrival is already paged
  // in sixties, so the DOM grows in batches without a second reveal
  // layer on top.
  const visibleItems = backend ? items : items.slice(0, visibleCount)
  const hasMore = backend ? backend.hasMore : visibleCount < items.length
  const countLabel = backend ? backend.total : items.length
  const showLoading = Boolean(backend?.loading) && items.length === 0

  return (
    <section className={styles.everything} aria-label="Everything">
      <div className={styles.shelfHeading}>
        <h2>
          <Icon name="grid" size={17} />
          Everything
        </h2>
        {countLabel > 0 && (
          <span className={styles.everythingCount}>{countLabel.toLocaleString()} titles</span>
        )}
      </div>
      {items.length === 0 ? (
        <EmptyShelf
          message={showLoading ? 'Loading the library…' : emptyMessage}
          icon={showLoading ? 'clock' : 'grid'}
        />
      ) : (
        <ul className={styles.everythingGrid}>
          {visibleItems.map((media) => (
            <LibraryTile
              key={media.id}
              media={media}
              selected={media.id === selectedId}
              onSelect={onSelect}
              onOpen={onOpen}
            />
          ))}
          {hasMore && <li ref={sentinelRef} className={styles.loadSentinel} aria-hidden="true" />}
        </ul>
      )}
    </section>
  )
}

function LibraryDetails({ media, config }: { media: MediaItem | null; config: CategoryConfig }) {
  const { startPartyPlayback, toggleMyList, markContinueWatching, openDetail, resolvingMedia } =
    useAppState()

  if (!media) {
    return (
      <aside className={`${styles.details} glass-panel`} aria-label="Title details">
        <EmptyShelf message="Choose a title to inspect it here." icon={config.icon} />
      </aside>
    )
  }

  const artwork = resolveArtwork(media)
  // The two fields carry the same number; prefer the one named for what it
  // is, and fall back so a future item with only the other still shows.
  const crowdRating = media.imdbRating?.toFixed(1) ?? score(media) ?? undefined
  const rottenTomatoesRating = media.rottenTomatoesRating
  const isResolving = resolvingMedia?.id === media.id

  return (
    <aside className={`${styles.details} glass-panel`} aria-label={`${media.title} details`}>
      <div className={styles.detailTabs} aria-hidden="true">
        <span className={styles.detailTabActive}>Details</span>
        <span>Story</span>
        <span>Similar</span>
      </div>
      <div className={styles.detailHero}>
        <ArtworkImage
          className={styles.detailPoster}
          src={artwork.posterUrl ?? artwork.backdropUrl}
          alt=""
          fallbackTitle={media.title}
          artTint={media.artTint}
          sizes="120px"
        />
        <div>
          <p className={styles.detailKicker}>Selected title</p>
          <h2>{media.title}</h2>
          <p>
            {media.releaseYear ?? '—'} · {formatLibraryMeta(media)}
          </p>
        </div>
      </div>

      {/* ONE crowd figure, not the same one twice. communityRating and
          imdbRating are both filled from CatalogItem.rating (adapters.ts),
          so "Community 7.8" beside "IMDb 7.8" was a single number wearing
          two hats — which reads as two sources agreeing when there is only
          ever one. Labelled by where it actually came from: IMDb for films
          and series, whose ids ARE IMDb ids, and Kitsu for anime, which has
          no IMDb id at all. Rotten Tomatoes joins it when OMDb is connected
          and has an entry; that one is genuinely independent. */}
      <div className={styles.detailScores}>
        {crowdRating && (
          <RatingBadge source={ratingSourceFor(media.mediaKind)} value={crowdRating} />
        )}
        {rottenTomatoesRating !== undefined && (
          <RatingBadge source="rottenTomatoes" value={`${rottenTomatoesRating}%`} />
        )}
        {!crowdRating && rottenTomatoesRating === undefined && (
          <span>
            <b>—</b>
            Ratings unavailable
          </span>
        )}
      </div>

      <p className={styles.detailDescription}>
        {media.description ?? 'No synopsis is available for this title yet.'}
      </p>

      <dl className={styles.detailFacts}>
        <div>
          <dt>Genres</dt>
          <dd>{media.genres.length ? media.genres.slice(0, 3).join(' · ') : '—'}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{media.status ?? 'Library title'}</dd>
        </div>
        <div>
          <dt>
            {media.mediaKind === 'movie' || media.mediaType === 'movie' ? 'Runtime' : 'Episodes'}
          </dt>
          <dd>{formatLibraryMeta(media)}</dd>
        </div>
      </dl>

      <div className={styles.detailActions}>
        <button
          type="button"
          className={styles.primaryAction}
          onClick={() => startPartyPlayback(media)}
          disabled={isResolving}
        >
          <Icon name="play" size={15} />
          {isResolving ? 'Preparing…' : 'Play now'}
        </button>
        <button type="button" className={styles.action} onClick={() => openDetail(media)}>
          <Icon name="info" size={15} />
          Open full details
        </button>
        <button type="button" className={styles.action} onClick={() => toggleMyList(media)}>
          <Icon name={media.inMyList ? 'check' : 'plus'} size={15} />
          {media.inMyList ? 'Planned' : 'Plan to Watch'}
        </button>
        <button
          type="button"
          className={styles.action}
          onClick={() => markContinueWatching(media.id, !media.watched, media)}
        >
          <Icon name={media.watched ? 'eye-off' : 'check'} size={15} />
          {media.watched ? 'Mark as unwatched' : 'Mark as watched'}
        </button>
      </div>
    </aside>
  )
}

export function LibraryPage({ config }: { config: CategoryConfig }) {
  const {
    catalog,
    catalogKindStates,
    adaptCatalogItems,
    refreshCatalog,
    continueWatching,
    recommendations,
    categorySearch,
    clearCategorySearch,
    mediaHubSettings,
    openDetail,
    pendingRestore
  } = useAppState()
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const [heroIndex, setHeroIndex] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const paramsString = searchParams.toString()
  const hideDefaults: HideStateDefaults = useMemo(
    () => ({
      hideWatched: mediaHubSettings?.hideWatchedDefault ?? false,
      hideCompleted: mediaHubSettings?.hideCompletedDefault ?? false,
      hideDisliked: mediaHubSettings?.hideDislikedDefault ?? false
    }),
    [mediaHubSettings]
  )
  const filters = useMemo(
    () => filterStateFromSearchParams(searchParams, hideDefaults),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- URL string is the stable dependency.
    [paramsString, hideDefaults]
  )
  const setFilters = (next: typeof filters) =>
    setSearchParams(filterStateToSearchParams(next), { replace: true })

  const library = useMemo(
    () => catalog.filter((item) => matchesCategoryKind(item, config.kind)),
    [catalog, config.kind]
  )
  const kindState = catalogKindStates[config.kind]
  const searchActive = categorySearch.kind === config.kind && categorySearch.query.trim().length > 0
  // STAGE 3: the browse grid pages from the index (catalog:query) — SQL
  // filters, SQL sort, exact totals — instead of filtering the loaded
  // array. The array (`library`) remains only for the curated rails and
  // as the option pool nothing below needs it to be complete for.
  const browse = useCatalogBrowse(config.kind, filters, kindState, adaptCatalogItems, !searchActive)
  // STAGE 5: the deep scan. One chunk per press, written to the INDEX
  // only — the pool, the blob and this page's memory never grow; what
  // grows is the exact count below and everything the index serves
  // (browse, search, filters). Progress is a page counter, not a
  // spinner of faith.
  const [scanning, setScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState<DeepScanEvent | null>(null)
  const [scanNote, setScanNote] = useState<string | null>(null)
  const [scanToken, setScanToken] = useState(0)
  useEffect(() => {
    const api = window.api?.mediaHub?.catalog
    if (!api?.onDeepScanEvent) return
    return api.onDeepScanEvent((event) => {
      if (event.kind === config.kind) setScanProgress(event)
    })
  }, [config.kind])
  const runDeepScan = useCallback(async () => {
    const api = window.api?.mediaHub?.catalog
    if (!api?.deepScan) return
    setScanning(true)
    setScanNote(null)
    try {
      const report = await api.deepScan(config.kind)
      setScanNote(
        report.exhausted
          ? 'That is the whole catalog — nothing more upstream.'
          : report.added > 0
            ? `+${report.added.toLocaleString()} titles found`
            : 'Nothing new in that stretch.'
      )
      setScanToken((token) => token + 1)
    } catch {
      setScanNote('The scan could not run. Try again.')
    } finally {
      setScanning(false)
      setScanProgress(null)
    }
  }, [config.kind])
  const kindTotals = useCatalogKindTotals(config.kind, kindState, scanToken)
  // Dropdown options come from the index too — the library's actual
  // genres/years/statuses, not whatever slice happens to be loaded.
  const [facets, setFacets] = useState<CatalogFacets | null>(null)
  useEffect(() => {
    let cancelled = false
    window.api?.mediaHub?.catalog
      .facets(config.kind)
      .then((result) => {
        if (!cancelled) setFacets(result)
      })
      .catch(() => {
        // The bar renders with empty option lists until a later refresh.
      })
    return () => {
      cancelled = true
    }
  }, [config.kind, kindState])
  const searchResults = useMemo(
    () => applyWatchStateFilters(categorySearch.results, filters),
    [categorySearch.results, filters]
  )
  const browseItems = searchActive ? searchResults : browse.items
  // Identifies the current browse view for EverythingSection's
  // reveal-depth reset (see useBatchReveal's own doc comment) — anything
  // that changes this is a genuine filter/sort/search/kind change the
  // person navigated to, not a catalog-side edit within the view they're
  // already looking at.
  const viewKey = searchActive
    ? `${config.kind}:search:${categorySearch.query}`
    : `${config.kind}:filters:${paramsString}`
  const heroItems = useMemo(() => {
    const ranking = [...(browse.items.length ? browse.items : library)]
    ranking.sort((a, b) => (b.communityRating ?? 0) - (a.communityRating ?? 0))
    return ranking.slice(0, 5)
  }, [browse.items, library])
  const activeHero = heroItems[Math.min(heroIndex, Math.max(heroItems.length - 1, 0))] ?? null

  const continuing = useMemo(
    () =>
      uniqueItems(
        continueWatching
          .filter((entry) => matchesCategoryKind(entry.media, config.kind))
          .map((entry) => entry.media)
      ).slice(0, 12),
    [continueWatching, config.kind]
  )
  const popular = useMemo(() => {
    const pool = browseItems.length ? [...browseItems] : [...library]
    return pool
      .sort(
        (a, b) =>
          (b.matchPercentage ?? b.communityRating ?? 0) -
          (a.matchPercentage ?? a.communityRating ?? 0)
      )
      .slice(0, 18)
  }, [browseItems, library])
  // Recommendations are sourced from the personalised home feed, then
  // narrowed to the active library. Each category keeps its own relevant
  // rail: movies on Movies, series on Series, and anime on Anime.
  const recommended = useMemo(
    () =>
      uniqueItems(
        recommendations
          .map((recommendation) => recommendation.media)
          .filter((media) => matchesCategoryKind(media, config.kind))
      ).slice(0, 18),
    [recommendations, config.kind]
  )
  // Seeds EverythingSection's reveal batch past wherever the previously-
  // focused tile falls, rounded up to a clean batch boundary, so a
  // contextual back navigation (see useRestoreBrowsingOrigin below) finds
  // that tile already mounted instead of it sitting past the default
  // first-24 cutoff.
  //
  // Reads `pendingRestore` — what a Back press just stepped out of — not
  // the trail's top, which is where the NEXT Back would go. Since Back now
  // pops as it navigates (the back trail is a stack, so a chain of titles
  // opened from one another unwinds a step per press), the entry being
  // restored is no longer on the trail by the time this page mounts.
  //
  // Gated on the origin's own route matching where we actually are, same
  // as useRestoreBrowsingOrigin's own check below — without it, a title
  // opened from Home/Search and then left via a DIFFERENT navigation
  // (the sidebar, not contextual Back) leaves a stale BrowsingOrigin
  // whose focusedItemId can still coincidentally match a catalog id here
  // (Home's items and this library's are the same underlying catalog),
  // seeding an arbitrarily deep reveal batch for a restore that
  // useRestoreBrowsingOrigin correctly never runs.
  const restoreVisibleCount = useMemo(() => {
    if (searchActive === false) return undefined
    if (!pendingRestore?.focusedItemId) return undefined
    if (`${location.pathname}${location.search}` !== pendingRestore.route) return undefined
    const idx = browseItems.findIndex((item) => item.id === pendingRestore.focusedItemId)
    return idx >= 0 ? Math.ceil((idx + 1) / EVERYTHING_BATCH) * EVERYTHING_BATCH : undefined
  }, [searchActive, pendingRestore, browseItems, location.pathname, location.search])
  // Backend-mode counterpart of restoreVisibleCount: a Back-restored
  // position may sit pages past the first sixty, so the hook pages
  // forward (bounded) until the focused tile exists for
  // useRestoreBrowsingOrigin to scroll to. Same route gate as above —
  // a stale origin from another surface must not trigger a crawl here.
  const ensureItem = browse.ensureItem
  useEffect(() => {
    if (searchActive || !pendingRestore?.focusedItemId) return
    if (`${location.pathname}${location.search}` !== pendingRestore.route) return
    void ensureItem(pendingRestore.focusedItemId)
  }, [searchActive, pendingRestore, location.pathname, location.search, ensureItem])
  const selected = useMemo(
    () =>
      [...browseItems, ...continuing, ...recommended, ...heroItems].find(
        (item) => item.id === selectedId
      ) ?? activeHero,
    [activeHero, browseItems, continuing, heroItems, recommended, selectedId]
  )
  const heroArt = activeHero ? resolveArtwork(activeHero) : null

  // Exact figures from the index, however deep it grows — the loaded
  // array only ever bounded these. Falls back to the array's own counts
  // for the beat before the index has seeded on a first run. Planned
  // stays array-derived: myList is an id-set with no kinds, and making
  // that exact is a later, honest change rather than a quiet guess here.
  const libraryTotal = kindTotals.total || library.length
  const completedCount = kindTotals.total
    ? kindTotals.completed
    : library.filter((item) => item.completed).length
  const inListCount = library.filter((item) => item.inMyList).length

  useRestoreBrowsingOrigin(true)

  return (
    <div className={styles.page}>
      <main className={styles.library}>
        <section
          className={`${styles.hero} ${activeHero ? styles.heroClickable : ''} glass-panel`}
          role={activeHero ? 'link' : undefined}
          tabIndex={activeHero ? 0 : undefined}
          aria-label={
            activeHero
              ? `Open full details for ${activeHero.title}`
              : `${config.label} library spotlight`
          }
          onClick={() => {
            if (activeHero) openDetail(activeHero)
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget || !activeHero) return
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              openDetail(activeHero)
            }
          }}
        >
          <div className={styles.heroEnergy} aria-hidden="true" />
          {activeHero && heroArt && (
            <ArtworkImage
              className={styles.heroArtwork}
              src={heroArt.backdropUrl ?? heroArt.posterUrl}
              alt=""
              fallbackTitle={activeHero.title}
              artTint={activeHero.artTint}
              sizes="900px"
            />
          )}
          <div className={styles.heroShade} aria-hidden="true" />
          <div className={styles.heroContent}>
            <span className={styles.heroKicker}>
              <Icon name={config.icon} size={18} />
              {config.label} archive
            </span>
            <h1>{config.label}</h1>
            <p className={styles.libraryCount}>
              {libraryTotal.toLocaleString()} {config.pluralLabel} in your library
            </p>
            {/* Inside the clickable hero, so every control stops the
                click from opening the featured title. */}
            <div className={styles.deepScanRow}>
              <button
                type="button"
                className={styles.deepScanButton}
                disabled={scanning}
                onClick={(event) => {
                  event.stopPropagation()
                  void runDeepScan()
                }}
              >
                <Icon name="search" size={12} />
                {scanning
                  ? scanProgress
                    ? `Scanning… ${scanProgress.pagesDone}/${scanProgress.pagesTotal}`
                    : 'Scanning…'
                  : 'Scan deeper'}
              </button>
              {scanNote && !scanning && <span className={styles.deepScanNote}>{scanNote}</span>}
            </div>
            <div className={styles.stats}>
              <span>
                <b>{continuing.length}</b> Watching
              </span>
              <span>
                <b>{completedCount}</b> Completed
              </span>
              <span>
                <b>{inListCount}</b> Planned
              </span>
            </div>
          </div>

          {activeHero && (
            <div className={styles.featuredCopy}>
              <span>Featured now</span>
              <h2>{activeHero.title}</h2>
              <p>
                <Icon name="star" size={14} />
                {score(activeHero) ?? '—'} · {activeHero.releaseYear ?? 'New'} ·{' '}
                {formatLibraryMeta(activeHero)}
              </p>
            </div>
          )}
          {heroItems.length > 1 && (
            <div className={styles.heroSelector} aria-label={`Featured ${config.pluralLabel}`}>
              {heroItems.map((item, index) => (
                <button
                  type="button"
                  key={item.id}
                  className={index === heroIndex ? styles.heroSelectorActive : ''}
                  onClick={(event) => {
                    event.stopPropagation()
                    setHeroIndex(index)
                    setSelectedId(item.id)
                  }}
                  aria-label={`Show ${item.title}`}
                  aria-pressed={index === heroIndex}
                />
              ))}
            </div>
          )}
        </section>

        <div className={styles.filters}>
          <CategoryFilterBar
            config={config}
            facets={facets}
            filters={filters}
            onApplySaved={(query) => setSearchParams(new URLSearchParams(query), { replace: true })}
            onChange={setFilters}
            resultCount={searchActive ? searchResults.length : browse.total}
          />
          {kindState === 'failed' && (
            <div className={styles.offlineBanner} role="status">
              <Icon name="wifi-off" size={15} />
              {library.length > 0
                ? `Showing the last ${config.label} library snapshot.`
                : `Couldn't reach the media hub backend.`}
              <button type="button" onClick={refreshCatalog}>
                Retry
              </button>
            </div>
          )}
        </div>

        {searchActive ? (
          <LibraryShelf
            title={`Search results for “${categorySearch.query}”`}
            icon="search"
            items={searchResults}
            selectedId={selected?.id ?? null}
            onSelect={(media) => setSelectedId(media.id)}
            onOpen={openDetail}
            emptyMessage={
              categorySearch.loading
                ? `Searching the ${config.pluralLabel} catalog…`
                : categorySearch.error
                  ? `The ${config.pluralLabel} search could not be reached. Try again.`
                  : `No ${config.pluralLabel} matched that search.`
            }
          />
        ) : (
          <>
            <LibraryShelf
              title="Continue watching"
              icon="clock"
              items={continuing}
              selectedId={selected?.id ?? null}
              onSelect={(media) => setSelectedId(media.id)}
              onOpen={openDetail}
              emptyMessage="Finished Everything? 😱"
              collapseWhenEmpty
            />
            <LibraryShelf
              title="Recommended for you"
              icon="sparkle"
              items={recommended}
              selectedId={selected?.id ?? null}
              onSelect={(media) => setSelectedId(media.id)}
              onOpen={openDetail}
              emptyMessage="Watch a few titles and personalised recommendations will appear here."
            />
            <LibraryShelf
              title="Popular in your library"
              icon="sparkle"
              items={popular}
              selectedId={selected?.id ?? null}
              onSelect={(media) => setSelectedId(media.id)}
              onOpen={openDetail}
              emptyMessage={
                kindState === 'loading'
                  ? `Loading your ${config.pluralLabel} library…`
                  : kindState === 'failed'
                    ? `The ${config.label} library is unavailable. Retry above.`
                    : `No ${config.pluralLabel} match these filters.`
              }
            />
          </>
        )}

        <EverythingSection
          title="Everything"
          icon="grid"
          items={browseItems}
          selectedId={selected?.id ?? null}
          onSelect={(media) => setSelectedId(media.id)}
          onOpen={openDetail}
          initialVisibleCount={restoreVisibleCount}
          viewKey={viewKey}
          backend={
            searchActive
              ? undefined
              : {
                  total: browse.total,
                  hasMore: browse.hasMore,
                  loading: browse.loading,
                  onLoadMore: browse.loadMore
                }
          }
          emptyMessage={
            searchActive
              ? `No ${config.pluralLabel} matched that search.`
              : browse.error
                ? `The library index could not be read. Retry above.`
                : `Try widening a filter or clearing it to see more ${config.pluralLabel}.`
          }
        />

        {searchActive && (
          <button type="button" className={styles.clearSearch} onClick={clearCategorySearch}>
            <Icon name="x" size={13} />
            Clear {config.label.toLowerCase()} search
          </button>
        )}
      </main>

      <LibraryDetails media={selected} config={config} />
    </div>
  )
}

/** Compatibility entry point for the Anime route. Movies and Series import
 * LibraryPage directly, ensuring all three library views share one layout. */
export function AnimeLibraryPage() {
  return <LibraryPage config={ANIME_CONFIG} />
}
