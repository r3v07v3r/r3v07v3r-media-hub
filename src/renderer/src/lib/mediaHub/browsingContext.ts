// Captures and restores "where the person was browsing" around opening a
// media detail page — the mechanism behind its contextual "Back to X"
// control (the person should be able to inspect a title and return to
// exactly where they were: same filters, same scroll position, same
// carousel position, same focused card — not a fresh browsing session).
//
// Lives as a plain helper module rather than its own context/store:
// AppStateContext (the app's one central state provider) owns the single
// BrowsingOrigin instance these functions produce/consume, since it's
// already the choke point every "open a title" call site goes through
// (openDetail) — see that file's own comments.

export interface BrowsingOrigin {
  /** pathname + search this came from, e.g. "/movies?genre=Sci-Fi&sort=rating-desc" — where "Back" navigates to. */
  route: string
  /** Human-readable back-button label, e.g. "Trending Movies", "Sci-Fi Series", "Search Results". */
  label: string
  /** #main-content's scrollTop at capture time — vertical position fallback for when no focused card is found on restore. */
  scrollTop: number
  /** data-media-id of whatever card was focused/clicked when the detail page opened, if any. */
  focusedItemId?: string
  /** data-rail-id -> scrollLeft, for every horizontally-scrollable rail present at capture time. */
  railScroll: Record<string, number>
}

/** Snapshots the current page once, at the moment a detail page is opened from it. */
export function captureBrowsingOrigin(route: string, label: string): BrowsingOrigin {
  const main = document.getElementById('main-content')
  const focused = document.activeElement as HTMLElement | null
  const focusedItemId = focused?.getAttribute('data-media-id') ?? undefined

  const railScroll: Record<string, number> = {}
  document.querySelectorAll<HTMLElement>('[data-rail-id]').forEach((el) => {
    const id = el.getAttribute('data-rail-id')
    if (id) railScroll[id] = el.scrollLeft
  })

  return {
    route,
    label,
    scrollTop: main?.scrollTop ?? 0,
    focusedItemId,
    railScroll
  }
}

/**
 * Applies a captured origin's scroll/rail/focus state to the (freshly
 * remounted) page it describes. Prefers scrolling the previously-focused
 * card back into view + refocusing it over the raw scrollTop fallback —
 * more robust than a pixel offset (which assumes an identical row of
 * already-rendered content) and it satisfies both "restore scroll
 * position" and "return focus to the previously opened item" in one step.
 */
export function restoreBrowsingOrigin(origin: BrowsingOrigin): void {
  const main = document.getElementById('main-content')
  let restoredViaFocus = false

  if (origin.focusedItemId) {
    const el = document.querySelector<HTMLElement>(
      `[data-media-id="${CSS.escape(origin.focusedItemId)}"]`
    )
    if (el) {
      el.focus({ preventScroll: true })
      el.scrollIntoView({ block: 'center' })
      restoredViaFocus = true
    }
  }

  if (!restoredViaFocus && main) {
    main.scrollTop = origin.scrollTop
  }

  for (const [railId, left] of Object.entries(origin.railScroll)) {
    const el = document.querySelector<HTMLElement>(`[data-rail-id="${CSS.escape(railId)}"]`)
    if (el) el.scrollLeft = left
  }
}

/**
 * Best-effort human-readable label for the back button — covers the
 * common cases (plain category browse, a genre or sort applied, an
 * active search, Home, My List) rather than every possible filter
 * combination. Falls back to "Browse" for anything unanticipated so the
 * back button is never blank.
 */
export function deriveBrowsingLabel(params: {
  pathname: string
  searchParams: URLSearchParams
  categorySearch: { kind: string | null; query: string }
  activeMood: string | null
}): string {
  const { pathname, searchParams, categorySearch, activeMood } = params

  if (pathname === '/my-stuff') return 'My List'
  if (pathname === '/downloads') return 'Downloads'

  const kindLabel: Record<string, string> = {
    '/movies': 'Movies',
    '/series': 'Series',
    '/anime': 'Anime'
  }
  const base = kindLabel[pathname]

  if (base) {
    const kindForSearch = pathname === '/movies' ? 'movie' : pathname === '/series' ? 'series' : 'anime'
    if (categorySearch.kind === kindForSearch && categorySearch.query.trim()) {
      return 'Search Results'
    }
    const genre = searchParams.get('genre')
    if (genre) return `${genre} ${base}`
    const sort = searchParams.get('sort')
    if (sort === 'rating-desc') return `Top Rated ${base}`
    if (sort === 'year-desc') return `Newest ${base}`
    return `Trending ${base}`
  }

  if (pathname === '/') {
    return activeMood ? `Home · ${activeMood}` : 'Home'
  }

  return 'Browse'
}
