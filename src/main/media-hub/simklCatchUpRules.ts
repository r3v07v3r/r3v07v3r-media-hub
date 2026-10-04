// What a catch-up takes from Simkl into the local record, and what it leaves.
//
// The phone and TV app have no review panel: nobody is there to look at a
// list of "Simkl says you watched these" and press Import. So the decision
// has to be made unattended, every time the app comes to the front, against
// a database somebody is also writing to by watching things. Getting it
// wrong one way writes a phantom rewatch of every episode this device just
// played; the other way, it puts back a show somebody took off their list
// an hour ago. Both are quiet, and both would be repeated on every pass.
//
// Its own module, with no imports that reach a database, the network or
// settings, so the judgement can be tested directly. simklCatchUp.ts is the
// fetching and the writing; this is what it decides to write.

import type { ImportedPlay, MediaKind } from '../../shared/media-hub/types'

export type SimklLibraryKind = 'movie' | 'show' | 'anime'

export interface SimklLibraryTitle {
  kind: SimklLibraryKind
  /** Identity AT SIMKL: `simkl:<n>`; else `imdb:<tt>`; else `kitsu:<n>` / `mal:<n>` / `anidb:<n>`. */
  ref: string
  /** Lowercased: watching | plantowatch | hold | completed | dropped | ''. */
  status: string
  title: string
  year?: string
  imdb?: string
  kitsu?: number
  mal?: number
  anidb?: number
  /** Anime only: tv | movie | ova | ona | special | music video. */
  animeType?: string
  lastWatchedAt: string | null
  /** added_to_watchlist_at */
  addedAt: string | null
  /** watched_episodes_count */
  watchedCount: number | null
  /** season null = the entry gave none (anime numbers its episodes flat). */
  episodes: Array<{ season: number | null; episode: number; watchedAt: string }>
}

type Loose = Record<string, unknown>

/** Anything that is not a plain object reads as an empty one: the payload
 *  is somebody else's JSON, and one odd entry must not cost the rest. */
function record(value: unknown): Loose {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * A whole number from a field that may arrive as a number or a numeric
 * string, or null when it cannot be read as one.
 *
 * Not `Number(x) || fallback`: season 0 is the specials convention (see
 * simkl.ts's numberOr), and 0 is falsy. Not bare Number() either, which
 * reads null and '' as 0 — an absent season would become the specials.
 */
function wholeNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null
  if (typeof value !== 'string' || !value.trim()) return null
  const n = Number(value)
  return Number.isInteger(n) ? n : null
}

function positiveId(value: unknown): number | undefined {
  const n = wholeNumber(value)
  return n !== null && n > 0 ? n : undefined
}

function imdbOf(value: unknown): string | undefined {
  return typeof value === 'string' && /^tt\d+$/.test(value) ? value : undefined
}

function textOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function stampOf(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function parses(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && Number.isFinite(Date.parse(value))
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ''
}

/**
 * The watched episodes in one block of a payload.
 *
 * A block whose season is present but unreadable is dropped whole rather
 * than read as season 1 or as flat numbering: either guess files real
 * viewings under the wrong episode. An episode with no date that parses is
 * not a viewing — importWatched would roll the whole batch back on it.
 */
function episodesOf(
  rawEpisodes: unknown,
  rawSeason: unknown,
  into: SimklLibraryTitle['episodes']
): void {
  let season: number | null = null
  if (present(rawSeason)) {
    season = wholeNumber(rawSeason)
    if (season === null || season < 0) return
  }
  for (const raw of list(rawEpisodes)) {
    const ep = record(raw)
    const episode = wholeNumber(ep.number)
    if (episode === null || episode < 1) continue
    if (!parses(ep.watched_at)) continue
    into.push({ season, episode, watchedAt: ep.watched_at })
  }
}

/** The ref a title is remembered by between passes, in the order Simkl's
 *  own id is most stable. Empty when there is nothing to remember it by. */
function refOf(ids: {
  simkl?: number
  imdb?: string
  kitsu?: number
  mal?: number
  anidb?: number
}): string {
  if (ids.simkl) return `simkl:${ids.simkl}`
  if (ids.imdb) return `imdb:${ids.imdb}`
  if (ids.kitsu) return `kitsu:${ids.kitsu}`
  if (ids.mal) return `mal:${ids.mal}`
  if (ids.anidb) return `anidb:${ids.anidb}`
  return ''
}

function titleFrom(
  kind: SimklLibraryKind,
  entry: Loose,
  inner: Loose,
  animeType?: string
): SimklLibraryTitle | null {
  const rawIds = record(inner.ids)
  const ids = {
    simkl: positiveId(rawIds.simkl),
    imdb: imdbOf(rawIds.imdb),
    kitsu: positiveId(rawIds.kitsu),
    mal: positiveId(rawIds.mal),
    anidb: positiveId(rawIds.anidb)
  }
  const ref = refOf(ids)
  if (!ref) return null
  const count = wholeNumber(entry.watched_episodes_count)
  const year =
    typeof inner.year === 'number' || typeof inner.year === 'string' ? String(inner.year) : ''
  const episodes: SimklLibraryTitle['episodes'] = []
  if (kind !== 'movie') {
    for (const season of list(entry.seasons)) {
      const block = record(season)
      episodesOf(block.episodes, block.number, episodes)
    }
    // Some anime entries list their episodes flat, with no season block.
    if (kind === 'anime') episodesOf(entry.episodes, undefined, episodes)
  }
  const title: SimklLibraryTitle = {
    kind,
    ref,
    status: textOr(entry.status, '').toLowerCase(),
    title: textOr(inner.title, ''),
    lastWatchedAt: stampOf(entry.last_watched_at),
    addedAt: stampOf(entry.added_to_watchlist_at),
    watchedCount: count !== null && count >= 0 ? count : null,
    episodes
  }
  if (year) title.year = year
  if (ids.imdb) title.imdb = ids.imdb
  if (ids.kitsu) title.kitsu = ids.kitsu
  if (ids.mal) title.mal = ids.mal
  if (ids.anidb) title.anidb = ids.anidb
  if (animeType) title.animeType = animeType
  return title
}

/**
 * Simkl's /sync/all-items answers, one per kind, as one flat list of titles.
 *
 * `dropped` counts entries with nothing to identify them by. Anime that
 * turns up in the shows list is skipped without being counted: it arrives
 * through the anime list, and Simkl's own docs disagree on whether
 * shows/all repeats it — taking it twice would file the same viewing under
 * an IMDb id and a Kitsu id.
 */
export function parseSimklLibrary(payloads: {
  movies?: unknown
  shows?: unknown
  anime?: unknown
}): {
  titles: SimklLibraryTitle[]
  dropped: number
} {
  const titles: SimklLibraryTitle[] = []
  let dropped = 0
  const take = (title: SimklLibraryTitle | null): void => {
    if (title) titles.push(title)
    else dropped++
  }
  const input = record(payloads)
  for (const raw of list(record(input.movies).movies)) {
    const entry = record(raw)
    take(titleFrom('movie', entry, record(entry.movie)))
  }
  for (const raw of list(record(input.shows).shows)) {
    const entry = record(raw)
    const show = record(entry.show)
    const ids = record(show.ids)
    // Anime by its own evidence: a type only anime carries, or an id from
    // an anime database.
    if (present(entry.anime_type) || present(ids.mal) || present(ids.kitsu) || present(ids.anidb))
      continue
    take(titleFrom('show', entry, show))
  }
  for (const raw of list(record(input.anime).anime)) {
    const entry = record(raw)
    const show = record(entry.show)
    const animeType = textOr(entry.anime_type, textOr(show.anime_type, '')).toLowerCase()
    take(titleFrom('anime', entry, show, animeType || undefined))
  }
  return { titles, dropped }
}

export interface SimklActivityStamps {
  movies: string | null
  shows: string | null
  anime: string | null
}

/**
 * GET /sync/activities -> { all, movies: { all, ... }, tv_shows: { all, ... }, anime: { all, ... } }.
 *
 * The key for shows is `tv_shows`, not `shows`. A missing or non-string
 * stamp is null — which kindsToFetch reads as "Simkl did not say", never
 * as "nothing changed".
 */
export function parseSimklActivities(payload: unknown): SimklActivityStamps {
  const root = record(payload)
  return {
    movies: stampOf(record(root.movies).all),
    shows: stampOf(record(root.tv_shows).all),
    anime: stampOf(record(root.anime).all)
  }
}

export interface CatchUpState {
  /** settingsStore's simklAccountMark when written. */
  account: string
  /** Per kind: the activity stamp as of the last fetch that was FULLY applied. */
  stamps: SimklActivityStamps
  /** Per kind: when it was last fetched, ms. Paces refetching when Simkl gives no stamp. */
  fetchedAt: { movies: number; shows: number; anime: number }
  /** Per kind: when it was last fetched WHOLE rather than only what changed
   *  since the stored stamp — see librarySince. 0 before it ever has been. */
  fullAt: { movies: number; shows: number; anime: number }
  /** ref -> titleSignature as last fully applied. */
  seen: Record<string, string>
}

export function emptyCatchUpState(account: string): CatchUpState {
  return {
    account,
    stamps: { movies: null, shows: null, anime: null },
    fetchedAt: { movies: 0, shows: 0, anime: 0 },
    fullAt: { movies: 0, shows: 0, anime: 0 },
    seen: {}
  }
}

const STATE_KEYS = ['movies', 'shows', 'anime'] as const

/**
 * The stored state, if it is a well-formed one for THIS account; otherwise
 * a fresh one.
 *
 * The account check is what makes a sign-in to a different Simkl account
 * start over: its library has never been applied here, and the previous
 * account's `seen` would otherwise make every title that happens to share a
 * signature look already taken. A malformed record starts over too — the
 * cost is one full fetch, which the import's own repeatability absorbs.
 */
export function catchUpStateFor(stored: unknown, account: string): CatchUpState {
  const fresh = emptyCatchUpState(account)
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return fresh
  const value = stored as Loose
  if (typeof value.account !== 'string' || value.account !== account) return fresh
  const stamps = record(value.stamps)
  const fetchedAt = record(value.fetchedAt)
  // Read leniently, unlike the rest: a record with no usable time here is
  // one whose kinds have never been fetched whole as far as anybody can
  // tell, and the answer to that is a whole fetch, not a fresh start.
  const fullAt = record(value.fullAt)
  const wholeAt = (key: (typeof STATE_KEYS)[number]): number => {
    const at = fullAt[key]
    return typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : 0
  }
  const seen = value.seen
  if (!seen || typeof seen !== 'object' || Array.isArray(seen)) return fresh
  for (const key of STATE_KEYS) {
    const stamp = stamps[key]
    if (stamp !== null && typeof stamp !== 'string') return fresh
    if (typeof fetchedAt[key] !== 'number' || !Number.isFinite(fetchedAt[key])) return fresh
  }
  if (Object.values(seen).some((signature) => typeof signature !== 'string')) return fresh
  return {
    account,
    stamps: {
      movies: stamps.movies as string | null,
      shows: stamps.shows as string | null,
      anime: stamps.anime as string | null
    },
    fetchedAt: {
      movies: fetchedAt.movies as number,
      shows: fetchedAt.shows as number,
      anime: fetchedAt.anime as number
    },
    fullAt: { movies: wholeAt('movies'), shows: wholeAt('shows'), anime: wholeAt('anime') },
    seen: { ...(seen as Record<string, string>) }
  }
}

/**
 * What a title looked like at Simkl, as one comparable string.
 *
 * The count is in it as well as the date because a viewing added with a
 * date in the past moves the count without moving last_watched_at — and
 * the status, because a show moved back to "watching" is new activity even
 * when no episode was.
 */
export function titleSignature(title: SimklLibraryTitle): string {
  return `${title.lastWatchedAt ?? ''}|${title.watchedCount ?? ''}|${title.status}`
}

/**
 * How long a kind Simkl gives no activity stamp for waits before it is
 * fetched again.
 *
 * A day, not minutes. An account that has never watched any anime may have
 * no anime stamp at all, permanently, and reading "no stamp" as "changed"
 * would fetch that library on every pass for everybody who does not watch
 * anime — the polling the gate exists to stop. What a day leaves open is a
 * payload this app has stopped understanding, with every stamp missing for
 * good; that still gets one read a day.
 */
export const UNSTAMPED_REFETCH_MS = 24 * 60 * 60 * 1000

/**
 * How long incremental fetches are trusted before a kind is read whole
 * again.
 *
 * After its first fetch a kind is asked for with `date_from`: only what
 * changed since the stored stamp, which is what Simkl asks of a client that
 * keeps in step with it. That rests on Simkl's own account of what changed.
 * Once a week the next fetch that is due anyway asks for everything, so a
 * title an incremental answer left out is picked up without anybody having
 * to notice it was missing. It costs no extra request, only a larger one.
 */
export const FULL_REFETCH_MS = 7 * 24 * 60 * 60 * 1000

const KIND_STAMP: Record<SimklLibraryKind, keyof SimklActivityStamps> = {
  movie: 'movies',
  show: 'shows',
  anime: 'anime'
}

/**
 * Which kinds' libraries to fetch this pass.
 *
 * A kind is fetched when it never has been, or when Simkl's stamp for it
 * differs from the one stored by the last fetch that was fully applied —
 * a missing stamp compared like any other, so an account with no anime is
 * not refetched for having none. A kind Simkl gives no stamp for is read
 * again once a day (UNSTAMPED_REFETCH_MS). The activities gate is what
 * Simkl asks every client to use; a client that polls all-items without it
 * is one Simkl suspends.
 */
export function kindsToFetch(
  state: CatchUpState,
  current: SimklActivityStamps,
  nowMs: number
): SimklLibraryKind[] {
  const out: SimklLibraryKind[] = []
  for (const kind of ['movie', 'show', 'anime'] as const) {
    const key = KIND_STAMP[kind]
    const stamp = current[key]
    const fetchedAt = state.fetchedAt[key]
    if (fetchedAt <= 0 || stamp !== state.stamps[key]) {
      out.push(kind)
    } else if (stamp === null && (nowMs < fetchedAt || nowMs - fetchedAt >= UNSTAMPED_REFETCH_MS)) {
      // A clock set back leaves fetchedAt in the future, where no age is
      // ever reached; that reads as due.
      out.push(kind)
    }
  }
  return out
}

/**
 * The `date_from` to fetch a kind with: the stamp its last fully applied
 * fetch was made under, or null to fetch it whole.
 *
 * Whole when there is no such stamp (a first fetch, or one that was never
 * completed), and whole again once FULL_REFETCH_MS has passed since the
 * last whole fetch. The stamp is the one read BEFORE that fetch, so a
 * change that landed while it ran is after it, and is asked for again here
 * rather than missed. The import only ever adds, so the one thing an
 * incremental answer cannot say — that something was removed — is nothing
 * it would have acted on.
 */
export function librarySince(
  state: CatchUpState,
  kind: SimklLibraryKind,
  nowMs: number
): string | null {
  const key = KIND_STAMP[kind]
  const stamp = state.stamps[key]
  const fullAt = state.fullAt[key]
  if (typeof stamp !== 'string' || fullAt <= 0) return null
  if (nowMs < fullAt || nowMs - fullAt >= FULL_REFETCH_MS) return null
  return stamp
}

export interface ResolvedTitle {
  title: SimklLibraryTitle
  /** This app's id: IMDb tt id for a film or series; the CANONICAL `kitsu:<id>` for anime. */
  id: string
  type: MediaKind
  /** Anime: which season of that show this Simkl entry is (resolveAnimeGroupTarget's season). Null otherwise. */
  animeSeason: number | null
}

export interface CatchUpLocal {
  /** As importWatched keys them: `${id}:${season}:${episode}` and `${id}:movie:movie`. */
  watchedKeys: ReadonlySet<string>
  trackedIds: ReadonlySet<string>
  /** Ids whose un-plan is still owed to a service; never re-added (docs/WATCHLIST-SYNC.md rule 6). */
  awaitingRemoval: ReadonlySet<string>
}

export interface CatchUpPlan {
  plays: ImportedPlay[]
  follow: Array<{ id: string; type: MediaKind; title: string; year?: string }>
  /** Films taken as watched that are on the plan: rule 8 takes them off it. */
  unplan: Array<{ id: string; type: 'movie'; title: string; year?: string }>
  /** ref -> signature, for every title this plan covers. MERGE into the stored map, never replace it. */
  seen: Record<string, string>
  /** Rows refused by validation (bad date, bad coordinates, an anime season this app cannot place). */
  rejected: number
}

/** How recently a show has to have been watched at Simkl to be followed
 *  here. "Watching" is a status nobody tidies: a show abandoned years ago
 *  is still "watching" there, and Continue Watching is not the place for it. */
export const FOLLOW_WINDOW_MS = 365 * 24 * 60 * 60 * 1000

/** Anime that is one film or a stray extra, not a show anybody follows. */
const UNFOLLOWABLE_ANIME = new Set(['movie', 'special', 'music video'])

function isSeason(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isEpisode(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

/** id -> episode numbers watched here under a season of 2 or later, from
 *  importWatched's keys. The id itself may contain colons (`kitsu:42`). */
function laterSeasonEpisodes(keys: ReadonlySet<string>): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>()
  for (const key of keys) {
    const match = /^(.+):(\d+):(\d+)$/.exec(key)
    if (!match || Number(match[2]) < 2) continue
    const episodes = out.get(match[1]) ?? new Set<number>()
    episodes.add(Number(match[3]))
    out.set(match[1], episodes)
  }
  return out
}

function withYear<T extends object>(value: T, year: string | undefined): T & { year?: string } {
  return year ? { ...value, year } : value
}

/**
 * What to write for the titles that changed at Simkl.
 *
 * Additive only. It never removes a viewing or a followed show: Simkl's
 * library is evidence of what somebody watched, and its absence is not
 * evidence of anything (an entry Simkl failed to resolve, a list the
 * account trimmed). Each rule below says why it is shaped the way it is.
 */
export function planCatchUp(
  titles: readonly ResolvedTitle[],
  local: CatchUpLocal,
  seen: Readonly<Record<string, string>>,
  now: Date
): CatchUpPlan {
  const plan: CatchUpPlan = { plays: [], follow: [], unplan: [], seen: {}, rejected: 0 }
  const emitted = new Set<string>()
  const followed = new Set<string>()
  const unplanned = new Set<string>()
  const later = laterSeasonEpisodes(local.watchedKeys)
  const nowMs = now.getTime()

  // One row, if it is new and well-formed. A key already held locally is
  // skipped rather than appended: this device's own viewing comes back from
  // Simkl stamped at a different instant, and importWatched would record it
  // as a second play — a phantom rewatch of everything watched here.
  const emit = (row: ImportedPlay, key: string): boolean => {
    const film = row.season === null && row.episode === null
    const placed = film || (isSeason(row.season) && isEpisode(row.episode))
    // importWatched rolls the WHOLE batch back on one null date, and stores
    // a non-finite season under a film-shaped key — so a bad row is refused
    // here, and counted, rather than handed on.
    if (!placed || !parses(row.watchedAt)) {
      plan.rejected++
      return false
    }
    if (local.watchedKeys.has(key) || emitted.has(key)) return false
    emitted.add(key)
    plan.plays.push(row)
    return true
  }

  for (const resolved of titles) {
    const { title, id } = resolved
    const signature = titleSignature(title)
    // R1. Unchanged since the last pass that applied it: left entirely
    // alone. This is what lets "Remove from My List" stick — a show taken
    // off here is not followed again until there is NEW activity on it at
    // Simkl, which is somebody choosing to watch it again.
    if (seen[title.ref] === signature) continue
    // R5. Recorded for every title planned, including one whose rows were
    // all refused: those rows will be just as unreadable next pass.
    plan.seen[title.ref] = signature

    if (title.kind === 'movie') {
      // The movies list is fetched as /completed, but the status is checked
      // too: a play written for a film somebody only planned would also take
      // it off their plan (R4), which is a change they would have to undo.
      if (title.status !== 'completed') continue
      const watchedAt =
        [title.lastWatchedAt, title.addedAt].find((at) => parses(at)) ?? now.toISOString()
      const row = withYear(
        { id, type: 'movie' as const, title: title.title, season: null, episode: null, watchedAt },
        title.year
      )
      // R4. A film taken as watched that is still planned comes off the
      // plan — docs/WATCHLIST-SYNC.md rule 8, the same thing marking it
      // watched here does. Only for a NEW play: a film already watched here
      // and still planned is somebody's deliberate rewatch plan.
      if (emit(row, `${id}:movie:movie`) && local.trackedIds.has(id) && !unplanned.has(id)) {
        unplanned.add(id)
        plan.unplan.push(withYear({ id, type: 'movie' as const, title: title.title }, title.year))
      }
      continue
    }

    // R2. Episodes. A Simkl show is a series here whatever the resolver
    // said; anime keeps the type its resolved target has.
    const type: MediaKind = title.kind === 'show' ? 'series' : resolved.type
    // Whether Simkl holds a viewing of this title that this device does not.
    // R3 turns on it.
    let watchedElsewhere = false
    for (const ep of title.episodes) {
      let season: number | null
      if (title.kind === 'show') {
        season = ep.season ?? 1
      } else {
        // Anime: a Simkl anime entry is one Kitsu-shaped show, numbered
        // flat. Its own season 1 (or none) is that numbering; the season it
        // lands in HERE is whichever one of the merged franchise this entry
        // is. A Simkl season 0 or 2+ has no place in that mapping, so it is
        // refused rather than guessed into one.
        if (ep.season !== null && ep.season !== 1) {
          plan.rejected++
          continue
        }
        if (!isSeason(resolved.animeSeason)) {
          plan.rejected++
          continue
        }
        season = resolved.animeSeason
        // Echo guard: this app's own push of a LATER season of a merged
        // franchise can come back from Simkl filed under the first entry.
        // Episode 3 watched here as season 2 must not reappear as season 1
        // episode 3. Not a rejection: it is a viewing already recorded.
        if (
          season === 1 &&
          later.get(id)?.has(ep.episode) &&
          !local.watchedKeys.has(`${id}:1:${ep.episode}`)
        ) {
          continue
        }
      }
      const taken = emit(
        withYear(
          { id, type, title: title.title, season, episode: ep.episode, watchedAt: ep.watchedAt },
          title.year
        ),
        `${id}:${season}:${ep.episode}`
      )
      if (taken) watchedElsewhere = true
    }

    // R3. Follow what somebody is watching at Simkl, so it reaches Continue
    // Watching here. Local only (the caller's job): pushing a plan add would
    // move the show back to "plan to watch" at Simkl. Not when it is already
    // on the list, not when un-planning it is still owed to a service (rule
    // 6 — following it would undo the removal), not when the last viewing
    // is over a year old, and never for 'hold', which is somebody saying
    // they have stopped for now.
    //
    // And only when this pass took a viewing of it that this device did not
    // have. Everything else that changes a title's signature is this
    // device's own doing: an episode played here is pushed to Simkl, the
    // date and count there move, and the title looks new. A show played
    // here and then taken off the list would otherwise be put straight
    // back by its own echo. The player follows what is played here itself
    // (tracking.ts's `follow`), so nothing is lost by leaving that to it.
    if (!watchedElsewhere) continue
    if (title.status !== 'watching') continue
    if (local.trackedIds.has(id) || local.awaitingRemoval.has(id) || followed.has(id)) continue
    if (!parses(title.lastWatchedAt)) continue
    if (nowMs - Date.parse(title.lastWatchedAt) > FOLLOW_WINDOW_MS) continue
    if (title.kind === 'anime' && title.animeType && UNFOLLOWABLE_ANIME.has(title.animeType))
      continue
    followed.add(id)
    plan.follow.push(withYear({ id, type, title: title.title }, title.year))
  }
  return plan
}
