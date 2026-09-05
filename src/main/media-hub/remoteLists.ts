// The lists people built by hand, elsewhere.
//
// Plan-to-watch is one list per service and every service has it. This is
// the other kind: "Halloween 2025", "Films Dad would like", the ones
// somebody made themselves in Trakt or Simkl. They are read here and not
// written — a named list is a thing with an author, and the first version
// of this should not be able to reorder or empty one.
//
// TRAKT AND SIMKL ONLY. MyAnimeList has no user-defined lists in its v2
// API — its lists ARE the statuses (watching, completed, plan_to_watch),
// which the plan-to-watch pull already covers. Offering a MAL section
// here would be a heading with nothing under it.

import { logError } from './logger'
import { simklRequest } from './simklClient'
import {
  simklAccountMark,
  simklCredentials,
  traktAccountMark,
  traktCredentials
} from './settingsStore'
import { traktRequest } from './traktClient'
import { getDatabase } from './dbState'
import { notifyLibraryChanged } from './rendererBridge'
import type { RemoteList, RemoteListEntry } from '../../shared/media-hub/types'
import type { TaskPriority } from './taskScheduler'

const CACHE_KEY = 'lists:remote'
/** Long enough to survive a restart, short enough that a list renamed on
 *  the web stops being called by its old name within the day. */
const TTL_MS = 12 * 60 * 60 * 1000

export type RemoteListService = 'simkl' | 'trakt'

/**
 * WHOSE LISTS THESE ARE.
 *
 * A named list is somebody's private writing — its title, its
 * description, what they put in it. This cache outlives a sign-out, so
 * without a stamp saying which account each list was read from, signing
 * into a different Trakt would show the previous person's lists until the
 * background refresh happened to land. Stamped, a list whose account is
 * no longer connected is simply not returned.
 *
 * The marks come from settingsStore, which explains why they are stamps
 * rather than a clear-on-disconnect: state that outlives its account has
 * to be inert on its own, not rely on a cleanup that may never run.
 */
interface StampedLists {
  marks: { trakt: string; simkl: string }
  lists: RemoteList[]
}

function currentMarks(): { trakt: string; simkl: string } {
  return { trakt: traktAccountMark(), simkl: simklAccountMark() }
}

/** The cached lists that still belong to a connected account, per
 *  service — so disconnecting Trakt drops Trakt's and leaves Simkl's. */
function trustedCached(allowExpired = true): RemoteList[] {
  const stored = getDatabase().getCache<StampedLists>(CACHE_KEY, { allowExpired })
  if (!stored?.lists) return []
  const now = currentMarks()
  return stored.lists.filter((list) => {
    const stamp = stored.marks?.[list.service]
    return Boolean(stamp) && stamp === now[list.service]
  })
}

interface TraktListRow {
  ids?: { trakt?: number | string }
  name?: string
  description?: string
}

interface TraktListItemRow {
  type?: string
  movie?: { title?: string; year?: number; ids?: { imdb?: string } }
  show?: { title?: string; year?: number; ids?: { imdb?: string } }
}

/**
 * Trakt's personal lists and what is in them.
 *
 * One request for the lists, then one per list for its contents — which
 * is why this runs at background priority and is cached for half a day.
 * Somebody with thirty lists should not spend thirty requests every time
 * they open My Stuff.
 *
 * Only film and show entries are taken. Trakt lists can also hold people,
 * seasons and episodes; a person is not something this app can open, and
 * a row that cannot be opened is worse than a row that is not there.
 */
async function fetchTraktLists(priority: TaskPriority): Promise<RemoteList[]> {
  if (!traktCredentials().accessToken) return []
  const lists = await traktRequest<TraktListRow[]>('/users/me/lists', {}, priority)
  const out: RemoteList[] = []
  for (const list of Array.isArray(lists) ? lists : []) {
    const listId = list.ids?.trakt
    if (listId === undefined) continue
    try {
      const rows = await traktRequest<TraktListItemRow[]>(
        `/users/me/lists/${listId}/items/movies,shows`,
        {},
        priority
      )
      const items: RemoteListEntry[] = []
      for (const row of Array.isArray(rows) ? rows : []) {
        const record = row.movie ?? row.show
        const imdb = record?.ids?.imdb
        if (!record || !imdb) continue
        items.push({
          id: imdb,
          type: row.movie ? 'movie' : 'series',
          title: record.title ?? '',
          year: record.year ? String(record.year) : undefined
        })
      }
      out.push({
        id: `trakt:${listId}`,
        service: 'trakt',
        name: list.name ?? 'Untitled list',
        description: list.description || undefined,
        items
      })
    } catch (error) {
      // One unreadable list does not lose the others.
      logError('lists:trakt-items', error)
    }
  }
  return out
}

interface SimklListRow {
  id?: number | string
  name?: string
  description?: string
}

/**
 * Simkl's user lists.
 *
 * Simkl calls these "custom lists" and its API for them is thinner than
 * Trakt's — enough to name them and read their items, which is all a
 * read-only view needs.
 */
async function fetchSimklLists(priority: TaskPriority): Promise<RemoteList[]> {
  if (!simklCredentials().accessToken) return []
  const lists = await simklRequest<SimklListRow[]>('/users/me/lists', {}, priority)
  const out: RemoteList[] = []
  for (const list of Array.isArray(lists) ? lists : []) {
    if (list.id === undefined) continue
    try {
      const rows = await simklRequest<{
        movies?: { movie?: { title?: string; year?: number; ids?: { imdb?: string } } }[]
        shows?: { show?: { title?: string; year?: number; ids?: { imdb?: string } } }[]
      }>(`/users/me/lists/${list.id}/items`, {}, priority)
      const items: RemoteListEntry[] = []
      for (const row of rows.movies ?? []) {
        const imdb = row.movie?.ids?.imdb
        if (!imdb) continue
        items.push({
          id: imdb,
          type: 'movie',
          title: row.movie?.title ?? '',
          year: row.movie?.year ? String(row.movie.year) : undefined
        })
      }
      for (const row of rows.shows ?? []) {
        const imdb = row.show?.ids?.imdb
        if (!imdb) continue
        items.push({
          id: imdb,
          type: 'series',
          title: row.show?.title ?? '',
          year: row.show?.year ? String(row.show.year) : undefined
        })
      }
      out.push({
        id: `simkl:${list.id}`,
        service: 'simkl',
        name: list.name ?? 'Untitled list',
        description: list.description || undefined,
        items
      })
    } catch (error) {
      logError('lists:simkl-items', error)
    }
  }
  return out
}

/**
 * Every named list from every connected service.
 *
 * Cached, and the cache is returned rather than an empty array when a
 * service fails: a list somebody could see this morning should not vanish
 * because Trakt is having an afternoon. Per-service failure is logged,
 * not thrown, for the same reason the plan-to-watch pull works that way.
 */
export async function fetchRemoteLists(
  priority: TaskPriority = 'background'
): Promise<RemoteList[]> {
  const db = getDatabase()
  const settled = await Promise.allSettled([fetchTraktLists(priority), fetchSimklLists(priority)])
  const out: RemoteList[] = []
  let anyFailed = false
  for (const result of settled) {
    if (result.status === 'fulfilled') out.push(...result.value)
    else {
      anyFailed = true
      logError('lists:remote', result.reason)
    }
  }
  // Everything failed — keep whatever was last known rather than
  // reporting that somebody's lists have disappeared.
  if (anyFailed && out.length === 0) return trustedCached()
  const payload: StampedLists = { marks: currentMarks(), lists: out }
  db.putCache(CACHE_KEY, payload, TTL_MS, { durable: true })
  // My Stuff's lists view reads these through the same hook as the lists
  // made here, and that hook refetches on this — not on its own schedule.
  notifyLibraryChanged('remote-lists', 'lists')
  return out
}

/** The last successful read, for painting the view before a fetch lands.
 *  Only the lists belonging to accounts connected right now. */
export function cachedRemoteLists(): RemoteList[] {
  return trustedCached()
}
