// The catalog work behind the top-bar assistant: search the app first, ask
// the model second, then turn whatever it suggested back into titles this
// app can actually open.
//
// Why this exists at all: asking a language model "is Dune any good?" in a
// media app and rendering three sentences back is a chat box that happens
// to live in a media app. The app already knows how to find Dune — poster,
// episodes, a play button, whether you have watched it — and that answer is
// better, faster and true. So the app answers first, and the model's job
// narrows to the part it is genuinely better at: saying something worth
// reading about what was found, and naming what to try next.
//
// Everything here is a catalog:search / catalog:related round trip, so it
// lives away from AppStateContext's state machine and can be reasoned about
// on its own.

import type { CatalogItem, HistoryEntry, MediaKind } from '@shared/media-hub/types'
import type { OllamaTitleRef } from '@shared/media-hub/ollama'

/** The kinds the app has, and the order results fall back to when nothing scores better. Movies first because that is what most questions are about. */
const KINDS: MediaKind[] = ['movie', 'series', 'anime']

/** How many search hits the panel shows. Enough to cover a remake or a franchise, few enough to stay one glance. */
export const MAX_ASSISTANT_RESULTS = 6

/** How many past titles the model is told about. Same reasoning as MAX_PROMPT_TITLES — prompt length is what a local model's answer time is made of. */
const MAX_WATCHED_CONTEXT = 20

/** The backend refuses anything shorter (see catalog.ts's catalogSearch), so there is no point spending three requests to hear it three times. */
const MIN_QUERY_LENGTH = 2

/** Lowercased, punctuation-flattened form used only for comparing a title to a query. */
function comparable(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/**
 * How well a result answers the question that was typed, lower being
 * better.
 *
 * Three catalogs are searched at once and each ranks only against itself,
 * so their results arrive as three unrelated lists — concatenating them
 * puts every movie ahead of an exactly-matching anime purely because movies
 * were listed first. This is the one comparison that can be made across
 * them: whether the title IS the question, starts with it, or merely
 * contains it.
 */
function matchRank(title: string, query: string): number {
  const a = comparable(title)
  const b = comparable(query)
  if (!a || !b) return 4
  if (a === b) return 0
  if (a.startsWith(b)) return 1
  if (a.includes(b)) return 2
  return 3
}

/** Drops repeats by id, keeping the first occurrence — which, after sorting, is the best-ranked one. */
function dedupeById(items: CatalogItem[]): CatalogItem[] {
  const seen = new Set<string>()
  const out: CatalogItem[] = []
  for (const item of items) {
    const id = String(item?.id ?? '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(item)
  }
  return out
}

/**
 * Searches all three catalogs for one query and returns the best matches
 * across them.
 *
 * All three, not the one the question sounds like: nothing in "Frieren" or
 * "is Arcane worth it" says which catalog it lives in, and asking the
 * person to be on the right page first is the failure this whole path is
 * fixing. Three parallel requests is what it costs.
 *
 * A catalog that fails contributes nothing rather than failing the search —
 * one provider being down should not turn a findable title into no answer.
 */
export async function searchAppCatalog(query: string): Promise<CatalogItem[]> {
  const q = query.trim()
  if (q.length < MIN_QUERY_LENGTH) return []
  const api = window.api?.mediaHub?.catalog
  if (!api) return []

  const perKind = await Promise.all(
    KINDS.map((kind) => api.search(kind, q).catch((): CatalogItem[] => []))
  )

  return dedupeById(
    perKind
      .flatMap((items, kindIndex) =>
        items.map((item, position) => ({ item, kindIndex, position }))
      )
      .sort((a, b) => {
        const rank = matchRank(a.item.title, q) - matchRank(b.item.title, q)
        if (rank !== 0) return rank
        // Equally good matches keep each catalog's own idea of relevance,
        // interleaved by position so one catalog cannot take every slot.
        if (a.position !== b.position) return a.position - b.position
        return a.kindIndex - b.kindIndex
      })
      .map((entry) => entry.item)
  ).slice(0, MAX_ASSISTANT_RESULTS)
}

/**
 * Turns the titles a model named into catalog items this app can open.
 *
 * Looked up rather than trusted, and quietly dropped when nothing is found.
 * A model naming a film this app cannot show is not an error worth
 * reporting — it is a suggestion the app has no answer for, and the honest
 * rendering of that is one fewer chip, not a dead link or an apology.
 *
 * `exclude` keeps the row from repeating what is already on screen above
 * it, which models do constantly: asked for titles similar to Dune, a fair
 * number of them lead with Dune.
 */
export async function resolveSimilarTitles(
  names: string[],
  exclude: Iterable<string> = []
): Promise<CatalogItem[]> {
  if (!names.length) return []
  const api = window.api?.mediaHub?.catalog
  if (!api) return []

  const skip = new Set(exclude)
  const found = await Promise.all(
    names.map(async (name) => {
      const hits = await searchAppCatalog(name)
      // The best match for a title the model wrote out in full, not the
      // first of six — a loose hit here would put an unrelated title under
      // a heading that says the model suggested it.
      return hits.find((hit) => matchRank(hit.title, name) <= 1) ?? null
    })
  )
  return dedupeById(found.filter((item): item is CatalogItem => Boolean(item))).filter(
    (item) => !skip.has(String(item.id))
  )
}

/**
 * More like the first result, straight from the catalog backend, for when
 * the model named nothing the app has.
 *
 * This is the same "Similar Content" the detail page shows, so it is real
 * and it is always openable. It is the fallback rather than the primary
 * because it only knows this one title, while the model has been told what
 * the person watched — but a row that is sometimes empty is worse than a
 * row that is sometimes merely adjacent rather than personal.
 */
export async function relatedToItem(item: CatalogItem | undefined): Promise<CatalogItem[]> {
  const api = window.api?.mediaHub?.catalog
  if (!api || !item) return []
  const related = await api.related(item.type, item.id).catch((): CatalogItem[] => [])
  return dedupeById(related).slice(0, 4)
}

/**
 * The recently watched titles the model is told about, newest first.
 *
 * One entry per title, not one per episode: a history is mostly episodes of
 * one or two shows, and sending them as-is would fill the whole allowance
 * with the same series repeated twenty times and tell the model nothing
 * about anyone's range.
 *
 * Entries with no title are dropped. tracking:list's history rows carry
 * whatever metadata was stored when the watch was recorded (see
 * database.ts's history()), and a row from an older write can have none —
 * a bare id is not something to put in front of a model.
 */
export function recentlyWatchedRefs(history: HistoryEntry[]): OllamaTitleRef[] {
  const byId = new Map<string, { entry: HistoryEntry; watchedAt: number }>()
  for (const entry of history) {
    const id = String(entry?.id ?? '')
    const title = String(entry?.title ?? '').trim()
    if (!id || !title) continue
    // A missing timestamp sorts oldest rather than newest — Simkl omits
    // last_watched_at on some movies (see HistoryEntry), and letting those
    // float to the top would fill "recently watched" with whatever happened
    // to have no date on it.
    const watchedAt = entry.watchedAt ? new Date(entry.watchedAt).getTime() : 0
    const existing = byId.get(id)
    if (!existing || watchedAt > existing.watchedAt) byId.set(id, { entry, watchedAt })
  }

  return [...byId.values()]
    .sort((a, b) => b.watchedAt - a.watchedAt)
    .slice(0, MAX_WATCHED_CONTEXT)
    .map(({ entry }) => ({
      id: String(entry.id),
      title: String(entry.title),
      year: Number.parseInt(String(entry.year ?? ''), 10) || undefined,
      genres: Array.isArray(entry.genres) ? entry.genres : undefined
    }))
}
