// The Collections page's own record: the lists added from Trakt, and which
// collections were taken off the page.
//
// The bundled universes (shared/media-hub/universes.ts) stay the standard
// set — kept by hand, in story order. What this adds is everything past
// them: a public Trakt list found through Browse for more or pasted as a
// link becomes a collection, and is read again now and then so a title the
// owner adds turns up without an app update.
//
// WHY TRAKT AND NOT SIMKL. Simkl's lists (its editors' franchise lists
// included) are readable through its API only with a PRO or VIP account and
// its newer sign-in; on a free account every list answers "premium only".
// Trakt's public lists need nothing but the app key already saved for the
// Trakt connection — nobody has to be signed in.
//
// REMOVED, NOT DELETED. Taking a collection off the page records its id; an
// added list keeps its entries. Restore puts either kind back as it was.

import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import {
  UNIVERSES,
  addedCollectionId,
  parseTraktListLink,
  type CollectionCandidate,
  type CollectionsState,
  type TraktListRef,
  type UniverseDefinition,
  type UniverseEntry
} from '../../shared/media-hub/universes'
import { getDatabase } from './dbState'
import type { HttpError } from './httpClient'
import { handle } from './ipcGuard'
import { logError } from './logger'
import { notifyLibraryChanged } from './rendererBridge'
import { traktCredentials } from './settingsStore'
import { traktPublicRequest } from './traktClient'
import type { TaskPriority } from './taskScheduler'

/** Per profile: one household member removing Marvel is not everyone's. */
const stateKey = (profile: string): string => `collections:v1:${profile}`
/** A record somebody made, not a cache of something fetched — rewritten on
 *  every change, and long enough that only a decade of disuse lets it go. */
const STATE_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000
/** How stale an added list may get before the page reads it again. */
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000
/** Lists bigger than this are not collections anybody works through. */
const MAX_ENTRIES = 500

interface StoredCollections {
  added: UniverseDefinition[]
  removed: string[]
}

function readStored(): StoredCollections {
  const db = getDatabase()
  const stored = db.getCache<StoredCollections>(stateKey(db.activeProfile()), {
    allowExpired: true
  })
  return {
    added: Array.isArray(stored?.added) ? stored.added : [],
    removed: Array.isArray(stored?.removed) ? stored.removed : []
  }
}

function writeStored(stored: StoredCollections): void {
  const db = getDatabase()
  db.putCache(stateKey(db.activeProfile()), stored, STATE_TTL_MS, { durable: true })
}

function stateOf(stored: StoredCollections): CollectionsState {
  return {
    added: stored.added,
    removed: stored.removed,
    traktReady: Boolean(traktCredentials().clientId)
  }
}

// ---- Reading a Trakt list --------------------------------------------------

interface TraktListRecord {
  name?: string
  description?: string | null
  sort_by?: string
  item_count?: number
  likes?: number
  share_link?: string
  ids?: { trakt?: number; slug?: string }
  user?: { username?: string; ids?: { slug?: string } } | null
}

interface TraktMediaRecord {
  title?: string
  year?: number | null
  ids?: { imdb?: string | null }
  /** Films, with extended=full. */
  released?: string | null
  /** Shows, with extended=full. */
  first_aired?: string | null
}

interface TraktListItem {
  type?: string
  movie?: TraktMediaRecord
  show?: TraktMediaRecord
}

function ownerOf(list: TraktListRecord): string {
  return list.user?.username || list.user?.ids?.slug || 'Trakt'
}

function listUrl(list: TraktListRecord, listId: number): string {
  return list.share_link || `https://trakt.tv/lists/${listId}`
}

/** A film's or series' Trakt record as an entry; null for anything the
 *  catalogue cannot open (no IMDb id). */
function toEntry(item: TraktListItem): UniverseEntry | null {
  const record = item.movie ?? item.show
  const imdb = record?.ids?.imdb
  if (!record || !imdb || !/^tt\d+$/.test(imdb)) return null
  const date = (item.movie ? record.released : record.first_aired) ?? ''
  return {
    id: imdb,
    type: item.movie ? 'movie' : 'series',
    title: record.title ?? '',
    year: record.year ? String(record.year) : date.slice(0, 4),
    released: /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : ''
  }
}

/** Says what went wrong in words the page can show as they are. */
function explain(error: unknown): Error {
  const status = (error as HttpError)?.status
  if (status === 404) return new Error('That list was not found on Trakt, or it is private.')
  if (status === 420) return new Error('Trakt only lets VIP accounts read a list this long.')
  if (status === 401 || status === 403) return new Error('Trakt did not accept the saved app key.')
  return error instanceof Error ? error : new Error(String(error))
}

/** The list's record, by whichever name the link gave. */
async function readListRecord(ref: TraktListRef, priority: TaskPriority): Promise<TraktListRecord> {
  const path =
    'listId' in ref
      ? `/lists/${ref.listId}`
      : `/users/${encodeURIComponent(ref.owner)}/lists/${encodeURIComponent(ref.slug)}`
  return traktPublicRequest<TraktListRecord>(path, priority)
}

/**
 * One public Trakt list as a collection.
 *
 * Films and shows only: a list can also hold people, seasons and episodes,
 * and a card that cannot be opened is worse than no card. A title listed
 * twice keeps its first place.
 */
async function readCollection(
  ref: TraktListRef,
  priority: TaskPriority
): Promise<UniverseDefinition> {
  try {
    const list = await readListRecord(ref, priority)
    const listId = Number(list.ids?.trakt)
    if (!Number.isFinite(listId)) throw new Error('Trakt answered without a list id.')
    const items = await traktPublicRequest<TraktListItem[]>(
      `/lists/${listId}/items/movie,show?extended=full`,
      priority
    )
    const seen = new Set<string>()
    const entries: UniverseEntry[] = []
    for (const item of Array.isArray(items) ? items : []) {
      const entry = toEntry(item)
      if (!entry || seen.has(entry.id)) continue
      seen.add(entry.id)
      entries.push(entry)
      if (entries.length >= MAX_ENTRIES) break
    }
    if (entries.length === 0) throw new Error('That list has no films or series in it.')
    const owner = ownerOf(list)
    const description = (list.description ?? '').replace(/\s+/g, ' ').trim()
    return {
      id: addedCollectionId(listId),
      name: list.name?.trim() || 'Untitled list',
      blurb: description
        ? description.length > 160
          ? `${description.slice(0, 157).trimEnd()}…`
          : description
        : `A Trakt list by ${owner}.`,
      // Ranked by hand is the owner's order, worth offering beside
      // release order; any other sort is just release order again.
      hasStoryOrder: (list.sort_by ?? 'rank') === 'rank',
      entries,
      source: {
        service: 'trakt',
        listId,
        owner,
        url: listUrl(list, listId),
        refreshedAt: Date.now()
      }
    }
  } catch (error) {
    throw explain(error)
  }
}

// ---- Browse for more -------------------------------------------------------

function toCandidate(list: TraktListRecord | undefined): CollectionCandidate | null {
  const listId = Number(list?.ids?.trakt)
  if (!list || !Number.isFinite(listId)) return null
  return {
    listId,
    name: list.name?.trim() || 'Untitled list',
    description: (list.description ?? '').replace(/\s+/g, ' ').trim(),
    owner: ownerOf(list),
    itemCount: Number(list.item_count) || 0,
    likes: Number(list.likes) || 0,
    url: listUrl(list, listId)
  }
}

/**
 * Trakt lists matching a search, or the most liked ones when the search is
 * empty. Lists of fewer than two titles are left out: they are not
 * collections.
 */
async function searchCollections(query: string): Promise<CollectionCandidate[]> {
  try {
    const rows = query
      ? (
          await traktPublicRequest<{ list?: TraktListRecord }[]>(
            `/search/list?query=${encodeURIComponent(query)}&limit=30`
          )
        ).map((row) => row.list)
      : (await traktPublicRequest<{ list?: TraktListRecord }[]>('/lists/popular?limit=30')).map(
          (row) => row.list
        )
    const seen = new Set<number>()
    const out: CollectionCandidate[] = []
    for (const row of Array.isArray(rows) ? rows : []) {
      const candidate = toCandidate(row)
      if (!candidate || candidate.itemCount < 2 || seen.has(candidate.listId)) continue
      seen.add(candidate.listId)
      out.push(candidate)
    }
    return out
  } catch (error) {
    throw explain(error)
  }
}

// ---- Keeping added lists fresh ----------------------------------------------

let refreshing: Promise<void> | null = null

/**
 * Reads again every added list older than a day, behind the answer the page
 * already has. A list that fails keeps what it had: Trakt being down for an
 * afternoon must not empty somebody's collection.
 */
function refreshStale(): void {
  if (refreshing || !traktCredentials().clientId) return
  const stale = readStored().added.filter(
    (collection) =>
      collection.source && Date.now() - collection.source.refreshedAt > REFRESH_AFTER_MS
  )
  if (stale.length === 0) return
  refreshing = (async () => {
    const fresh = new Map<string, UniverseDefinition>()
    for (const collection of stale) {
      try {
        const read = await readCollection({ listId: collection.source!.listId }, 'background')
        fresh.set(collection.id, read)
      } catch (error) {
        logError('collections:refresh', error)
      }
    }
    if (fresh.size === 0) return
    // Read again rather than reuse the snapshot from before the fetch:
    // somebody may have removed or added a list while it ran.
    const current = readStored()
    current.added = current.added.map((collection) => fresh.get(collection.id) ?? collection)
    writeStored(current)
    notifyLibraryChanged('collections-refresh', 'lists')
  })().finally(() => {
    refreshing = null
  })
}

// ---- IPC -------------------------------------------------------------------

export function registerCollectionsIpc(): void {
  handle<undefined, CollectionsState>(MEDIA_HUB_CHANNELS.collectionsState, () => {
    refreshStale()
    return stateOf(readStored())
  })

  handle<{ query?: string }, { results: CollectionCandidate[] }>(
    MEDIA_HUB_CHANNELS.collectionsSearch,
    async (_e, payload) => ({
      results: await searchCollections(
        String(payload?.query ?? '')
          .trim()
          .slice(0, 100)
      )
    })
  )

  /**
   * Adds a list, by the id Browse for more found or a pasted link. Adding
   * one already there reads it again and brings it back if it was removed,
   * rather than listing it twice.
   */
  handle<{ listId?: number; link?: string }, CollectionsState & { addedId: string }>(
    MEDIA_HUB_CHANNELS.collectionsAdd,
    async (_e, payload) => {
      let ref: TraktListRef | null = null
      if (typeof payload?.listId === 'number' && Number.isInteger(payload.listId)) {
        ref = { listId: payload.listId }
      } else if (typeof payload?.link === 'string') {
        ref = parseTraktListLink(payload.link)
        if (!ref) throw new Error('That is not a Trakt list link.')
      }
      if (!ref) throw new Error('Nothing to add.')
      const collection = await readCollection(ref, 'interactive')
      const stored = readStored()
      const existing = stored.added.findIndex((item) => item.id === collection.id)
      if (existing >= 0) stored.added[existing] = collection
      else stored.added.push(collection)
      stored.removed = stored.removed.filter((id) => id !== collection.id)
      writeStored(stored)
      return { ...stateOf(stored), addedId: collection.id }
    }
  )

  handle<{ id?: string }, CollectionsState>(MEDIA_HUB_CHANNELS.collectionsRemove, (_e, payload) => {
    const id = String(payload?.id ?? '')
    const stored = readStored()
    const known =
      UNIVERSES.some((universe) => universe.id === id) ||
      stored.added.some((collection) => collection.id === id)
    if (known && !stored.removed.includes(id)) {
      stored.removed.push(id)
      writeStored(stored)
    }
    return stateOf(stored)
  })

  handle<{ id?: string }, CollectionsState>(
    MEDIA_HUB_CHANNELS.collectionsRestore,
    (_e, payload) => {
      const id = String(payload?.id ?? '')
      const stored = readStored()
      if (stored.removed.includes(id)) {
        stored.removed = stored.removed.filter((removed) => removed !== id)
        writeStored(stored)
      }
      return stateOf(stored)
    }
  )
}
