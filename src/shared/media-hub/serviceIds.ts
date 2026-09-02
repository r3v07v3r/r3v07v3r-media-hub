// Which catalog ids are REAL — expressible to a tracking service — and
// which only exist inside this app.
//
// This lived in src/main/media-hub/simkl.ts (it is still re-exported from
// there, unchanged, for everything main-side that already imports it). It
// moved to shared because the question it answers stopped being a Simkl
// payload detail the moment demo ids leaked into real user data: three
// watch_history rows with mockData ids (m-10/m-11/m-13 — Interstellar,
// The Martian, Ex Machina) were written on 2026-08-24 through the demo-pool
// fallback, duplicating films already tracked under their real IMDb ids,
// and every layer that could have stopped it needs the same predicate —
// the renderer (to refuse the click with an explanation), the IPC boundary
// (to refuse a renderer that didn't), and the migration that cleans up the
// rows already written. Main-only placement is what left the renderer
// unable to ask.
//
// Simkl's id space is deliberately the one tested: it is the UNION of what
// every connected service can address (IMDb for movies/series — which is
// also all Trakt is ever sent — plus kitsu/mal/anilist/anidb for anime,
// which is what the MAL push resolves through). An id no Simkl payload can
// carry is an id NO service can be told about, so "expressible to Simkl"
// and "expressible to any service" are the same predicate today; if a
// service with a broader id space is ever added, this file is the one
// place that assumption lives.

/** At most one id is ever populated, keyed by which service the catalog id encodes. */
export interface SimklMediaIds {
  imdb?: string
  kitsu?: number
  mal?: number
  anilist?: number
  anidb?: number
}

/**
 * Derives Simkl's `ids` object from our internal catalog id string.
 * `tt1234567` (Cinemeta/IMDb) maps straight to `{imdb}`; everything else
 * uses this app's `${provider}:${id}` convention (kitsu/mal/anilist/anidb).
 * Unrecognized ids resolve to `{}` — Simkl treats an empty ids object as
 * "match by title/year" fallback rather than an error.
 */
export function idsForCatalogId(id: string): SimklMediaIds {
  if (/^tt\d+$/i.test(id)) return { imdb: id }
  for (const key of ['kitsu', 'mal', 'anilist', 'anidb'] as const) {
    if (id.startsWith(`${key}:`)) {
      const value = Number(id.split(':')[1])
      if (Number.isFinite(value)) return { [key]: value } as SimklMediaIds
    }
  }
  return {}
}

/**
 * Whether a catalog id can be expressed to Simkl as a REAL id — the
 * precondition for a push whose outcome can be verified, and for a diff
 * that can ever see the result. An id that resolves to `{}` goes out as a
 * title/year guess: Simkl either matches it against an entry the diff will
 * never join back to this id, or rejects it in a not_found entry that
 * carries no ids and so can't be attributed to anything (see
 * unmatchedCatalogIds). Either way the local record stays where it was and
 * the disagreement resurfaces on the next check, forever.
 */
export function hasExpressibleSimklId(id: string): boolean {
  return Object.keys(idsForCatalogId(id)).length > 0
}

/**
 * The one sentence every surface shows when it refuses to write a demo
 * title into the library. Shared between the renderer's toasts and the
 * main-process rejection below so the person reads the same explanation
 * whichever layer caught it — two wordings for one refusal would read as
 * two different problems.
 *
 * "Demo title" rather than "unmappable id": the only source of such ids a
 * person can actually click on is mockData's sample pool (the AI
 * assistant's last-resort fallback and the bridgeless preview build), so
 * naming the id scheme would explain the mechanism to us and nothing to
 * them.
 */
export function demoOnlyTitleMessage(title: string): string {
  return `"${title}" is a demo title from the built-in sample catalog — it can't be added to your library or synced to a tracking service.`
}

/**
 * Refuses a library WRITE for an id no service can express. This is the
 * IPC-boundary backstop behind the renderer's own per-click guards: any
 * mutation surface that forgets (or postdates) those guards still cannot
 * write an m-* id into watch_history/tracked/ratings/lists, which is
 * exactly how the Aug 24 rows got there.
 *
 * Deliberately only for the ADD direction. Removals (unmark, untrack,
 * un-rate via score 0, remove-from-list) of an inexpressible id are how
 * pollution that already exists gets cleaned up, and refusing those would
 * lock the ghosts in — the same reasoning PR #144 applied when it kept
 * unpushable rows in the sync review so "Use Simkl" could delete them.
 * Callers enforce the direction; this just throws uniformly.
 */
export function assertLibraryWritableId(id: unknown, title?: unknown): void {
  const catalogId = String(id ?? '')
  if (hasExpressibleSimklId(catalogId)) return
  throw new Error(demoOnlyTitleMessage(String(title || '') || catalogId))
}
